/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from 'fs';
import http from 'http';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import { test, expect } from '@playwright/test';

const cloakBrowserVersion: string = JSON.parse(fs.readFileSync(path.join(__dirname, '../package-lock.json'), 'utf8')).packages['node_modules/cloakbrowser'].version;

type CliResult = {
  output: string;
  error: string;
  exitCode: number | null;
};

async function runCli(...args: string[]): Promise<CliResult> {
  return runCliWithOptions({}, ...args);
}

async function runCliWithOptions(options: { env?: NodeJS.ProcessEnv, cwd?: string }, ...args: string[]): Promise<CliResult> {
  const cliPath = path.join(__dirname, '../playwright-cli.js');

  return new Promise<CliResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const childProcess = spawn(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        PLAYWRIGHT_CLI_BROWSER_PROVIDER: process.env.PLAYWRIGHT_CLI_BROWSER_PROVIDER || 'cloakbrowser',
        PLAYWRIGHT_CLI_INSTALLATION_FOR_TEST: test.info().outputPath(),
        PWTEST_DAEMON_SESSION_DIR: path.join(test.info().outputPath(), 'daemon'),
        NO_UPDATE_NOTIFIER: '1',
        ...options.env,
      },
      cwd: options.cwd ?? test.info().outputPath(),
    });

    childProcess.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    childProcess.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    childProcess.on('close', (code) => {
      resolve({
        output: stdout.trim(),
        error: stderr.trim(),
        exitCode: code,
      });
    });

    childProcess.on('error', reject);
  });
}

test('open data URL', async ({}) => {
  expect(await runCli('open', 'data:text/html,hello', '--persistent')).toEqual(expect.objectContaining({
    output: expect.stringContaining('hello'),
    exitCode: 0,
  }));

  expect(await runCli('delete-data')).toEqual(expect.objectContaining({
    output: expect.stringContaining('Deleted user data for'),
    exitCode: 0,
  }));
});

test('warns when installed skill is out of date', async ({}) => {
  expect(await runCli('install', '--skills')).toEqual(expect.objectContaining({
    exitCode: 0,
  }));

  const skillFile = path.join(test.info().outputPath(), '.claude', 'skills', 'playwright-cli', 'SKILL.md');
  fs.appendFileSync(skillFile, 'x');

  expect(await runCli('--help')).toEqual(expect.objectContaining({
    error: expect.stringContaining('does not match the tool version'),
  }));
});

test('browser provider selection respects explicit config', async ({}) => {
  const providers = require('../browserProviders');

  expect(providers.resolveProvider(undefined)).toBe('cloakbrowser');
  expect(providers.resolveProvider('cloakbrowser')).toBe('cloakbrowser');
  expect(() => providers.resolveProvider('patchright')).toThrow(/removed/);
  expect(() => providers.resolveProvider('camoufox')).toThrow(/removed/);
  expect(() => providers.resolveProvider('cloakbrowser,patchright')).toThrow(/removed/);

  expect(providers.hasExplicitBrowserConfig(['open', '--browser=firefox'], {})).toBe(true);
  expect(providers.hasExplicitBrowserConfig(['open', '--config', 'cli.json'], {})).toBe(true);
  expect(providers.hasExplicitBrowserConfig(['open'], { PLAYWRIGHT_MCP_CONFIG: 'mcp.json' })).toBe(true);
  // Ambient upstream env vars are set system-wide for other tools; they must not
  // silence stealth provider selection (issue #28).
  expect(providers.hasExplicitBrowserConfig(['open'], { PLAYWRIGHT_MCP_BROWSER: 'firefox' })).toBe(false);
  expect(providers.hasExplicitBrowserConfig(['open'], { PLAYWRIGHT_MCP_EXECUTABLE_PATH: '/x/chrome' })).toBe(false);
  expect(providers.hasExplicitBrowserConfig(['open'], {})).toBe(false);
});

test('recovers provider identity from browser config when metadata is missing', async ({}) => {
  const { inferProviderDetails } = require('../cliEnhancements');
  // Chrome for Testing launches no longer indicate any stealth provider;
  // provenance requires a cloakbrowser fingerprint/binary signature.
  expect(inferProviderDetails({
    browser: {
      browserName: 'chromium',
      launchOptions: { channel: 'chrome-for-testing' },
      contextOptions: { userAgent: 'Mozilla/5.0 Chrome/149.0.0.0' },
    },
  })).toBeUndefined();
  expect(inferProviderDetails({
    browser: { browserName: 'chromium', launchOptions: { channel: 'chrome-for-testing' } },
  })).toBeUndefined();
  expect(inferProviderDetails({
    browser: { browserName: 'chromium', launchOptions: { executablePath: '/cache/.cloakbrowser/chrome' } },
  })).toEqual({ name: 'cloakbrowser', version: cloakBrowserVersion });
  expect(inferProviderDetails({
    browser: { browserName: 'chromium', launchOptions: { args: ['--fingerprint={"seed":42}'] } },
  })).toEqual({ name: 'cloakbrowser', version: cloakBrowserVersion });
  expect(inferProviderDetails({
    browser: { browserName: 'chromium', launchOptions: { channel: 'chrome' } },
  })).toBeUndefined();
});

test('ambient upstream browser env does not silence stealth provider selection', async ({}) => {
  const { configureBrowserProvider } = require('../browserProviders');
  // PLAYWRIGHT_MCP_BROWSER is set system-wide for other tools (playwright MCP).
  // open must still activate the default stealth provider (issue #28).
  const env: NodeJS.ProcessEnv = {
    PLAYWRIGHT_MCP_BROWSER: 'chromium',
    PLAYWRIGHT_MCP_EXECUTABLE_PATH: '/wrong/browser',
  };
  class Session {
    static async startDaemon() {
      return { pid: 1, sessionName: 'default' };
    }
  }
  const config = await configureBrowserProvider({
    command: 'open',
    env,
    sessionModule: { Session },
  });
  expect(config.enabled).toBe(true);
  expect(env.PLAYWRIGHT_CLI_ACTIVE_BROWSER_PROVIDER).toBe('cloakbrowser');
  expect(env.PLAYWRIGHT_MCP_BROWSER).toBeUndefined();
  expect(env.PLAYWRIGHT_MCP_EXECUTABLE_PATH).toBeUndefined();
  // The generated config must carry the stealth UA override, not the ambient one.
  const configPath = env.PLAYWRIGHT_MCP_CONFIG;
  expect(configPath).toBeTruthy();
  const generated = JSON.parse(require('fs').readFileSync(configPath!, 'utf8'));
  expect(generated.browser.contextOptions.userAgent).toContain('Chrome/');
  expect(generated.browser.contextOptions.userAgent).not.toContain('Headless');
});

test('explicit --browser flag still skips provider selection', async ({}) => {
  const { createProviderState } = require('../browserProviders');
  expect(createProviderState('open', ['open', '--browser=firefox'], {}).enabled).toBe(false);
  expect(createProviderState('open', ['open'], { PLAYWRIGHT_MCP_CONFIG: '/tmp/cfg.json' }).enabled).toBe(false);
  expect(createProviderState('open', ['open'], {}).enabled).toBe(true);
});

test('missing mandatory CloakBrowser package does not claim a declared version', async ({}) => {
  const { providerVersion } = require('../browserProviders');
  expect(() => providerVersion('cloakbrowser', () => {
    throw new Error('CloakBrowser is not installed');
  })).toThrow('CloakBrowser is not installed');
});

test('package identity is stealth-web-cli with both bin entries', async ({}) => {
  // Guards the issue #30 rename: the published name, binary name, and repo
  // URLs must all agree, and the old name must not resurface.
  const pkg = require('../package.json');
  expect(pkg.name).toBe('stealth-web-cli');
  expect(Object.keys(pkg.bin)).toContain('stealth-web-cli');
  expect(Object.keys(pkg.bin)).toContain('playwright-cli');
  expect(pkg.repository.url).toContain('github.com/Sekinal/stealth-web-cli');
  expect(pkg.homepage).toContain('github.com/Sekinal/stealth-web-cli');

  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '../package-lock.json'), 'utf8'));
  expect(lock.name).toBe('stealth-web-cli');
  expect(lock.packages[''].name).toBe('stealth-web-cli');
  expect(lock.packages[''].bin).toEqual(pkg.bin);

  // The bundled skill install hints must use the new binary name.
  const skillCheck = fs.readFileSync(path.join(__dirname, '../skillCheck.js'), 'utf8');
  expect(skillCheck).toContain("command: 'stealth-web-cli install --skills'");
  expect(skillCheck).not.toContain('stealth-browser-cli');
});

test('does not warn when installed skill only differs in line endings', async ({}) => {
  expect(await runCli('install', '--skills')).toEqual(expect.objectContaining({
    exitCode: 0,
  }));

  const skillFile = path.join(test.info().outputPath(), '.claude', 'skills', 'playwright-cli', 'SKILL.md');
  fs.writeFileSync(skillFile, fs.readFileSync(skillFile, 'utf8').replace(/\n/g, '\r\n'));

  expect(await runCli('--help')).toEqual(expect.objectContaining({
    error: expect.not.stringContaining('does not match the tool version'),
  }));
});

test('a single CloakBrowser provider surfaces activation and launch failures', async ({}) => {
  const { configureBrowserProvider } = require('../browserProviders');

  const activationEnv: NodeJS.ProcessEnv = {
    PLAYWRIGHT_CLI_BROWSER_PROVIDER: 'cloakbrowser',
  };
  await expect(configureBrowserProvider({
    command: 'open',
    env: activationEnv,
    sessionModule: { Session: class { static async startDaemon() {} } },
    activateProvider: async () => {
      throw new Error('Cloak executable was not found');
    },
  })).rejects.toThrow('Cloak executable was not found');

  const launchEnv: NodeJS.ProcessEnv = {};
  class LaunchSession {
    static async startDaemon() {
      throw new Error('Daemon crashed during launch');
    }
  }
  await configureBrowserProvider({
    command: 'open',
    env: launchEnv,
    sessionModule: { Session: LaunchSession },
  });
  await expect(LaunchSession.startDaemon()).rejects.toThrow('Daemon crashed during launch');
});

test('an explicit provider override replaces conflicting upstream browser environment', async ({}) => {
  const { configureBrowserProvider } = require('../browserProviders');
  const env: NodeJS.ProcessEnv = {
    PLAYWRIGHT_CLI_BROWSER_PROVIDER: 'cloakbrowser',
    PLAYWRIGHT_MCP_BROWSER: 'chromium',
    PLAYWRIGHT_MCP_EXECUTABLE_PATH: '/wrong/browser',
  };
  class Session {
    static async startDaemon() {
      return { pid: 1, sessionName: 'default' };
    }
  }

  await configureBrowserProvider({
    command: 'open',
    env,
    sessionModule: { Session },
  });
  expect(env.PLAYWRIGHT_MCP_BROWSER).toBeUndefined();
  expect(env.PLAYWRIGHT_MCP_EXECUTABLE_PATH).toBeUndefined();
  expect(env.PLAYWRIGHT_CLI_ACTIVE_BROWSER_PROVIDER).toBe('cloakbrowser');
});

test('open fails when CloakBrowser is unavailable', async ({}) => {
  const missingCloak = path.join(test.info().outputPath(), 'missing-cloak');
  const opened = await runCliWithOptions({
    env: {
      CLOAKBROWSER_BINARY_PATH: missingCloak,
    },
  }, '-s=cloak-unavailable', 'open', 'data:text/html,<title>Unavailable</title>', '--json');
  expect(opened.exitCode).not.toBe(0);
  expect(JSON.parse(opened.output)).toEqual(expect.objectContaining({
    ok: false,
    error: expect.any(String),
  }));
});

test('a default-path .playwright/cli.config.json does not silently disable CloakBrowser (issue 37)', async ({}) => {
  const cwd = test.info().outputPath();
  fs.mkdirSync(path.join(cwd, '.playwright'), { recursive: true });
  // The documented proxy setup lives at the default config path; before the
  // fix it was promoted to a CLI-level override that shadowed the generated
  // provider config, falling back to a vanilla Chrome channel.
  fs.writeFileSync(
      path.join(cwd, '.playwright', 'cli.config.json'),
      JSON.stringify({ browser: { launchOptions: { proxy: { server: 'http://user:pass@127.0.0.1:1' } } } }),
  );

  try {
    const opened = await runCliWithOptions({ cwd }, '-s=default-config-proxy', 'open', 'data:text/html,<title>P37</title>', '--json');
    expect(opened.exitCode, opened.error).toBe(0);
    expect(JSON.parse(opened.output)).toEqual(expect.objectContaining({
      ok: true,
      provider: { name: 'cloakbrowser', version: cloakBrowserVersion },
    }));
  } finally {
    await runCliWithOptions({ cwd }, '-s=default-config-proxy', 'close');
  }
});

test('reports active provider, re-evaluates it, and lists the provider name', async ({}) => {
  const firstOpen = await runCli('-s=provider-report', 'open', 'data:text/html,<title>First</title>');
  expect(firstOpen).toEqual(expect.objectContaining({
    output: expect.stringContaining(`### Browser provider\n- name: cloakbrowser\n- version: ${cloakBrowserVersion}`),
    exitCode: 0,
  }));

  // With the sidecar present, list reports the provider name instead of the
  // generic browser channel.
  const list = await runCli('list');
  expect(list.output).toContain('browser-type: cloakbrowser');
  expect(list.output).not.toContain('browser-type: chrome-for-testing');

  const listJson = JSON.parse((await runCli('list', '--json')).output);
  expect(listJson.result.browsers).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'provider-report', browserType: 'cloakbrowser' }),
  ]));

  const sidecarJson = await runCli('-s=provider-report', 'eval', '() => document.title', '--json');
  expect(JSON.parse(sidecarJson.output)).toEqual(expect.objectContaining({
    ok: true,
    provider: { name: 'cloakbrowser', version: cloakBrowserVersion },
  }));

  const secondOpen = await runCli('-s=provider-report', 'open', 'data:text/html,<title>Second</title>');
  expect(secondOpen).toEqual(expect.objectContaining({
    error: expect.stringContaining("restarting it to re-apply the CloakBrowser configuration"),
    exitCode: 0,
  }));

  await runCli('-s=provider-report', 'close');
});

test('session without sidecar does not claim provider provenance from channel alone', async ({}) => {
  // Upstream session files record only browserName+launchOptions, which look
  // identical for an ambient upstream chromium launch. Channel
  // chrome-for-testing alone must not claim stealth provider provenance
  // (issue #28); only a cloakbrowser signature may.
  const opened = await runCli('-s=channel-only', 'open', 'data:text/html,<title>C</title>', '--json');
  expect(JSON.parse(opened.output).provider?.name).toBeTruthy();

  const daemonRoot = path.join(test.info().outputPath(), 'daemon');
  const metadataRelativePath = fs.readdirSync(daemonRoot, { recursive: true })
      .map(String)
      .find(file => file.endsWith('channel-only.provider.json'));
  expect(metadataRelativePath).toBeTruthy();
  fs.unlinkSync(path.join(daemonRoot, metadataRelativePath!));

  const evalJson = await runCli('-s=channel-only', 'eval', '() => document.title', '--json');
  const payload = JSON.parse(evalJson.output);
  expect(payload.ok).toBe(true);
  // No sidecar, but the generated CloakBrowser config embeds its binary path /
  // fingerprint args, so provenance is recovered from that evidence.
  expect(payload.provider).toEqual({ name: 'cloakbrowser', version: cloakBrowserVersion });

  await runCli('-s=channel-only', 'close');
});

test('emits stable structured output with page metadata and provider details', async ({}) => {
  const opened = await runCli('-s=json-output', 'open', 'data:text/html,<title>Structured</title><h1>Hello</h1>', '--json');
  const openJson = JSON.parse(opened.output);
  expect(openJson).toEqual(expect.objectContaining({
    ok: true,
    title: 'Structured',
    console: [],
    provider: { name: 'cloakbrowser', version: cloakBrowserVersion },
    session: 'json-output',
  }));
  expect(openJson.url).toContain('data:text/html');

  const evaluated = await runCli('-s=json-output', 'eval', '() => ({ answer: 42, text: document.body.innerText })', '--json');
  expect(JSON.parse(evaluated.output)).toEqual({
    ok: true,
    url: openJson.url,
    title: 'Structured',
    result: { answer: 42, text: 'Hello' },
    console: [],
    provider: { name: 'cloakbrowser', version: cloakBrowserVersion },
    challenge: { type: 'none', blocked: false },
    bodyLength: 5,
    emptyBody: false,
    webdriver: false,
  });

  const snapshot = await runCli('-s=json-output', 'snapshot', '--inline', '--json');
  expect(JSON.parse(snapshot.output)).toEqual(expect.objectContaining({
    ok: true,
    result: { snapshot: expect.stringContaining('heading "Hello"') },
  }));

  await runCli('-s=json-output', 'close');
});

test('writes complete eval results with --output', async ({}) => {
  await runCli('-s=eval-output', 'open', 'data:text/html,<title>Output</title>');
  const outputFile = path.join(test.info().outputPath(), 'evaluation result.txt');
  const expected = `line1\nline2 with "quotes" and \\ backslash\n${'x'.repeat(8192)}`;
  const evaluated = await runCli(
      '-s=eval-output',
      'eval',
      `() => ${JSON.stringify(expected)}`,
      `--output=${outputFile}`,
      '--json');
  expect(evaluated.exitCode).toBe(0);
  expect(JSON.parse(evaluated.output)).toEqual(expect.objectContaining({
    ok: true,
    result: `- [Evaluation result](${outputFile})`,
    provider: { name: 'cloakbrowser', version: cloakBrowserVersion },
  }));
  expect(fs.readFileSync(outputFile, 'utf8')).toBe(expected);

  const objectFile = path.join(test.info().outputPath(), 'evaluation-object.json');
  await runCli('-s=eval-output', 'eval', '() => ({ answer: 42 })', `--output=${objectFile}`);
  expect(fs.readFileSync(objectFile, 'utf8')).toBe('{\n  "answer": 42\n}');
  await runCli('-s=eval-output', 'close');
});

test('--raw eval unwraps JSON-encoded string results', async ({}) => {
  await runCli('-s=raw-eval', 'open', 'data:text/html,<title>Raw</title>');
  // Without --raw, JSON.stringify returns a quoted string (double-encoded)
  const withoutRaw = await runCli('-s=raw-eval', 'eval', 'JSON.stringify({a:1})', '--json');
  const withoutPayload = JSON.parse(withoutRaw.output);
  expect(withoutPayload.result).toBe('{"a":1}');

  // With --raw, the string result is unwrapped (no extra quotes)
  const rawStr = await runCli('-s=raw-eval', '--raw', 'eval', 'JSON.stringify({a:1})');
  expect(rawStr.output.trim()).toBe('{"a":1}');

  // Object results are unaffected by --raw unwrapping (they aren't strings)
  const rawObj = await runCli('-s=raw-eval', '--raw', 'eval', '({a:1})');
  expect(rawObj.output.trim()).toBe('{\n  "a": 1\n}');

  // Number results are unaffected
  const rawNum = await runCli('-s=raw-eval', '--raw', 'eval', '42');
  expect(rawNum.output.trim()).toBe('42');
  await runCli('-s=raw-eval', 'close');
});

test('fetch command returns structured HTTP response', async ({}) => {
  await runCli('-s=fetch-test', 'open', 'data:text/html,<title>Fetch</title>');
  const result = await runCli('-s=fetch-test', 'fetch', 'data:text/html,<p>Hello</p>', '--json');
  const payload = JSON.parse(result.output);
  expect(result.exitCode).toBe(0);
  expect(payload.ok).toBe(true);
  expect(payload.result.status).toBe(200);
  expect(payload.result.body).toBe('<p>Hello</p>');
  expect(payload.result.headers).toEqual(expect.objectContaining({ 'content-type': 'text/html' }));
  await runCli('-s=fetch-test', 'close');
});

test('fetch --raw returns just the response body', async ({}) => {
  await runCli('-s=fetch-raw-test', 'open', 'data:text/html,<title>RawFetch</title>');
  const result = await runCli('-s=fetch-raw-test', '--raw', 'fetch', 'data:text/html,<p>BodyOnly</p>');
  expect(result.output.trim()).toBe('<p>BodyOnly</p>');
  await runCli('-s=fetch-raw-test', 'close');
});


test('fetch reports HTTP 4xx/5xx as failure while preserving the body', async ({}) => {
  const server = http.createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP server address');

  try {
    await runCli('-s=fetch-404-test', 'open', 'data:text/html,<title>F</title>');
    const result = await runCli('-s=fetch-404-test', 'fetch', `http://127.0.0.1:${address.port}/missing`, '--json');
    const payload = JSON.parse(result.output);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('HTTP 404 Not Found');
    expect(payload.result.status).toBe(404);
    expect(payload.result.body).toBe('not found');
    expect(payload.result.failed).toBe(true);
    await runCli('-s=fetch-404-test', 'close');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('fetch supports POST with data and reports redirects', async ({}) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/target' });
      res.end();
      return;
    }
    if (req.url === '/target') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('landed');
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, body }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP server address');

  try {
    await runCli('-s=fetch-post-test', 'open', 'data:text/html,<title>FP</title>');
    const base = `http://127.0.0.1:${address.port}`;

    const post = await runCli('-s=fetch-post-test', 'fetch', `${base}/echo`, '--method=POST', '--data={"x":1}', '--json');
    const postPayload = JSON.parse(post.output);
    expect(postPayload.ok).toBe(true);
    expect(postPayload.result.json.method).toBe('POST');
    expect(postPayload.result.json.body).toBe('{"x":1}');

    const redirect = await runCli('-s=fetch-post-test', 'fetch', `${base}/redirect`, '--json');
    const redirectPayload = JSON.parse(redirect.output);
    expect(redirectPayload.result.status).toBe(200);
    expect(redirectPayload.result.redirected).toBe(true);
    expect(redirectPayload.result.url).toBe(`${base}/target`);
    expect(redirectPayload.result.body).toBe('landed');
    await runCli('-s=fetch-post-test', 'close');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('fetch returns base64 for binary responses without corruption', async ({}) => {
  const crypto = require('crypto');
  const server = http.createServer((req, res) => {
    const buf = crypto.randomBytes(1024);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.length });
    res.end(buf);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP server address');

  try {
    await runCli('-s=fetch-binary-test', 'open', 'data:text/html,<title>B</title>');
    const result = await runCli('-s=fetch-binary-test', 'fetch', `http://127.0.0.1:${address.port}/`, '--json');
    const payload = JSON.parse(result.output);
    expect(payload.result.binary).toBe(true);
    const decoded = Buffer.from(payload.result.body, 'base64');
    expect(decoded.length).toBe(1024);
    expect(payload.result.headers['content-type']).toBe('application/octet-stream');
    await runCli('-s=fetch-binary-test', 'close');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('fetch detects anti-bot challenge types from status and body', async ({}) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/datadome') {
      res.writeHead(403, { 'content-type': 'text/html' });
      res.end('<html><body>Please enable JS and disable any ad blocker</body></html>');
      return;
    }
    if (req.url === '/akamai') {
      res.writeHead(403, { 'content-type': 'text/html' });
      res.end('<html><title>Access Denied</title><body>You don\'t have permission to access</body></html>');
      return;
    }
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('forbidden');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP server address');

  try {
    await runCli('-s=fetch-challenge-test', 'open', 'data:text/html,<title>CH</title>');
    const base = `http://127.0.0.1:${address.port}`;

    const datadome = await runCli('-s=fetch-challenge-test', 'fetch', `${base}/datadome`, '--engine=wreq', '--json');
    expect(JSON.parse(datadome.output).result.challenge).toEqual({ type: 'datadome', blocked: true });

    const akamai = await runCli('-s=fetch-challenge-test', 'fetch', `${base}/akamai`, '--engine=wreq', '--json');
    expect(JSON.parse(akamai.output).result.challenge).toEqual({ type: 'blocked', blocked: true });

    const plain = await runCli('-s=fetch-challenge-test', 'fetch', `${base}/plain`, '--engine=wreq', '--json');
    expect(JSON.parse(plain.output).result.challenge).toEqual({ type: '403', blocked: true });
    await runCli('-s=fetch-challenge-test', 'close');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('goto detects captcha widgets in the DOM (turnstile/recaptcha/hcaptcha)', async ({}) => {
  await runCli('-s=captcha-widget', 'open', 'data:text/html,<title>s</title>');

  const turnstile = await runCli('-s=captcha-widget', 'goto', 'data:text/html,<iframe src="https://challenges.cloudflare.com/turnstile/v0/api.js"></iframe>', '--timeout=5', '--json');
  expect(JSON.parse(turnstile.output).result.challenge).toEqual({ type: 'turnstile', blocked: true });

  const recaptcha = await runCli('-s=captcha-widget', 'goto', 'data:text/html,<div class="g-recaptcha" data-sitekey="test"></div>', '--timeout=5', '--json');
  expect(JSON.parse(recaptcha.output).result.challenge).toEqual({ type: 'recaptcha', blocked: true });

  const hcaptcha = await runCli('-s=captcha-widget', 'goto', 'data:text/html,<iframe src="https://hcaptcha.com/captcha/v2/api.js"></iframe>', '--timeout=5', '--json');
  expect(JSON.parse(hcaptcha.output).result.challenge).toEqual({ type: 'hcaptcha', blocked: true });

  // hCaptcha embeds `recaptchacompat=true` in its iframe URL; its own
  // `recaptcha` substring must not misclassify the widget as reCAPTCHA.
  const hcaptchaCompat = await runCli('-s=captcha-widget', 'goto', 'data:text/html,<iframe src="https://hcaptcha.com/captcha/v2/api.js?recaptchacompat=true"></iframe>', '--timeout=5', '--json');
  expect(JSON.parse(hcaptchaCompat.output).result.challenge).toEqual({ type: 'hcaptcha', blocked: true });

  const plain = await runCli('-s=captcha-widget', 'goto', 'data:text/html,<p>hello</p>', '--timeout=5', '--json');
  expect(JSON.parse(plain.output).result.challenge).toEqual({ type: 'none', blocked: false });
  await runCli('-s=captcha-widget', 'close');
});

test('scrape renders JS content, crawls with ok, redacts challenges, and extracts', async ({}) => {
  // Each scrape spawns a CloakBrowser instance; Windows CI is slow enough that
  // the default 30s budget is too tight for the full sequence.
  test.setTimeout(120_000);
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/challenge')) {
      res.writeHead(403, { 'content-type': 'text/html' });
      res.end('<html><title>Just a moment...</title><body><p>Checking your browser before accessing, please enable JS.</p></body></html>');
      return;
    }
    if (req.url.startsWith('/page2')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><title>Page Two</title></head><body><h1>Second</h1><a href="/">Home</a></body></html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head><title>Scrape Home</title></head><body><h1>Welcome</h1><div id="d"></div><a href="/page2">p2</a>' +
        '<script>document.getElementById("d").innerText = "Rendered by JS";</script></body></html>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP server address');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const page = await runCli('scrape', `${base}/`);
    expect(page.exitCode, page.output).toBe(0);
    const record = JSON.parse(page.output);
    expect(record.ok).toBe(true);
    expect(record.title).toBe('Scrape Home');
    expect(record.status).toBe(200);
    expect(record.text).toContain('Rendered by JS');
    expect(record.attempts).toBe(1);
    expect(record.retried).toBe(false);

    const text = await runCli('scrape', `${base}/`, '--output-format=text');
    expect(text.output.trim()).toContain('Welcome');

    const schemaFile = path.join(test.info().outputPath(), 'schema.json');
    fs.writeFileSync(schemaFile, JSON.stringify({ title: { selector: 'h1' } }));
    const extracted = await runCli('scrape', `${base}/`, `--schema=${schemaFile}`);
    expect(JSON.parse(extracted.output).extracted).toEqual({ title: 'Welcome' });

    // Crawl succeeds with a positive `ok` (the summary has no scalar status).
    const crawled = await runCli('scrape', `${base}/`, '--crawl', '--max-requests=5');
    const crawlPayload = JSON.parse(crawled.output);
    expect(crawlPayload.ok).toBe(true);
    expect(crawlPayload.requestsProcessed).toBeGreaterThan(0);
    expect(crawlPayload.results.map(r => r.title)).toEqual(expect.arrayContaining(['Scrape Home', 'Page Two']));
    expect(crawlPayload.failedRequests).toEqual([]);
    // --crawl --output-format=text must join the pages, not emit just a newline.
    const crawlText = await runCli('scrape', `${base}/`, '--crawl', '--max-requests=5', '--output-format=text');
    expect(crawlText.output.trim().length).toBeGreaterThan(0);
    expect(crawlText.output).toContain('Welcome');

    // Challenge pages are retried, redacted (never captured), and exit nonzero.
    const challenged = await runCli('scrape', `${base}/challenge`, '--retry=1');
    const challengePayload = JSON.parse(challenged.output);
    expect(challengePayload.ok).toBe(false);
    expect(challenged.exitCode).not.toBe(0);
    expect(challengePayload.challenge).toEqual({ type: 'cloudflare', blocked: true });
    expect(challengePayload.text).toBe('');
    expect(challengePayload.html).toBe('');
    expect(challengePayload.retried).toBe(true);

    const badFormat = await runCli('scrape', `${base}/`, '--output-format=yaml');
    expect(badFormat.exitCode).not.toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('scrape parses --help, ignores -s= session flags, and flattens CSV --select', async ({}) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head><title>Sel</title></head><body><h1 class="h">One</h1><p>The text</p></body></html>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP server address');
  const base = `http://127.0.0.1:${address.port}`;

  try {
    // --help and -h print the command help instead of failing on a missing URL.
    const help = await runCli('scrape', '--help');
    expect(help.exitCode).toBe(0);
    expect(help.output).toContain('--max-requests');

    // Scrape is sessionless: a -s=<name> flag must not be treated as the URL.
    const scraped = await runCli('-s=scrape-cli-test', 'scrape', `${base}/`, '--select=.h', '--output-format=csv');
    expect(scraped.exitCode).toBe(0);
    const lines = scraped.output.trim().split('\n');
    expect(lines[0].split(',')).toEqual(expect.arrayContaining(['text', 'html']));
    expect(lines[1]).toContain('One');
    expect(scraped.output).not.toContain('The text');
    await runCli('-s=scrape-cli-test', 'close').catch(() => {});
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test('fetch supports basic auth via --user/--password', async ({}) => {
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? '';
    if (auth === `Basic ${Buffer.from('alice:secret').toString('base64')}`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"authenticated":true}');
    } else {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('unauthorized');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP server address');

  try {
    await runCli('-s=fetch-auth', 'open', 'data:text/html,<title>A</title>');
    const result = await runCli('-s=fetch-auth', 'fetch', `http://127.0.0.1:${address.port}/`, '--user=alice', '--password=secret', '--json');
    const payload = JSON.parse(result.output);
    expect(payload.ok).toBe(true);
    expect(payload.result.json.authenticated).toBe(true);
    await runCli('-s=fetch-auth', 'close');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('fetch defaults to the wreq engine without an open session', async ({}) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ seen: req.headers['user-agent'] ?? '' }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP server address');

  try {
    // No `open` first: wreq must not require a session.
    const result = await runCli('-s=engine-default', 'fetch', `http://127.0.0.1:${address.port}/`, '--json');
    const payload = JSON.parse(result.output);
    expect(payload.ok).toBe(true);
    expect(payload.result.engine).toBe('wreq');
    expect(payload.result.status).toBe(200);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('fetch --engine=httpcloak issues a request without a session', async ({}) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('httpcloak reached me');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP server address');

  try {
    const result = await runCli('-s=engine-httpcloak', 'fetch', `http://127.0.0.1:${address.port}/`, '--engine=httpcloak', '--json');
    const payload = JSON.parse(result.output);
    expect(payload.ok).toBe(true);
    expect(payload.result.engine).toBe('httpcloak');
    expect(payload.result.body).toBe('httpcloak reached me');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('fetch rejects an unsupported engine before contacting any session', async ({}) => {
  const result = await runCli('fetch', 'https://example.com', '--engine=nonsense', '--json');
  expect(result.exitCode).not.toBe(0);
  expect(result.output).toContain('Unsupported --engine');
});

test('fetch --engine=browser requires a session and tags the result', async ({}) => {
  await runCli('-s=engine-browser', 'open', 'data:text/html,<title>B</title>');
  const result = await runCli('-s=engine-browser', 'fetch', 'data:text/html,plain-body', '--engine=browser', '--json');
  const payload = JSON.parse(result.output);
  expect(payload.ok).toBe(true);
  expect(payload.result.engine).toBe('browser');
  expect(payload.result.body).toContain('plain-body');
  await runCli('-s=engine-browser', 'close');
});

test('fetch argv parser mimics minimist for separated option values', async () => {
  const { parseCliArgv } = require('../cliEnhancements');
  const { positional, flags } = parseCliArgv(
      ['fetch', 'https://example.com/', '--method', 'POST', '--engine', 'httpcloak', '--data', '{"a":1}', '--json'],
      'fetch',
      { json: true, raw: true });
  expect(positional).toEqual(['https://example.com/']);
  expect(flags).toEqual({ method: 'POST', engine: 'httpcloak', data: '{"a":1}', json: true });
});

test('fetch --engine=httpcloak sends --data as a raw body and separated flags parse', async ({}) => {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, contentType: req.headers['content-type'] ?? null, body: rawBody }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP server address');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const body = '{"a":1}';
    // --engine httpcloak and --method POST as SEPARATE argv tokens (minimist
    // style); --data must reach the server as the raw body, not a JSON-encoded
    // quoted string.
    const result = await runCli('fetch', base, '--engine', 'httpcloak', '--method', 'POST', '--data', body, '--json');
    const payload = JSON.parse(result.output);
    expect(payload.ok, result.output).toBe(true);
    expect(payload.result.json.method).toBe('POST');
    expect(payload.result.json.body).toBe(body);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('fetch 200-challenge pages never report success; default engine escalates', async ({}) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><title>Just a moment...</title><body>Checking your browser before accessing, please enable JS.</body></html>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP server address');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    // Explicit engine: keep the transport, but never present the challenge as success.
    const explicit = await runCli('fetch', base, '--engine=wreq', '--json');
    const explicitPayload = JSON.parse(explicit.output);
    expect(explicit.exitCode).toBe(1);
    expect(explicitPayload.ok).toBe(false);
    expect(explicitPayload.error).toContain('Blocked by cloudflare challenge');
    expect(explicitPayload.result.challenge).toEqual({ type: 'cloudflare', blocked: true });

    // Default engine escalates to the browser session instead of emitting a
    // stale success. Without a session the escalated path hits the session
    // gate; with one, the in-page browser fetch of this CORS-less localhost
    // fixture fails closed. Either way a blocked challenge is never reported
    // as ok and the process exits nonzero.
    const noSession = await runCli('fetch', base, '--json');
    expect(noSession.exitCode).not.toBe(0);
    expect(JSON.parse(noSession.output).ok).toBe(false);

    await runCli('-s=fetch-esc', 'open', 'data:text/html,<title>E</title>');
    const def = await runCli('-s=fetch-esc', 'fetch', base, '--json');
    const defPayload = JSON.parse(def.output);
    expect(defPayload.ok).toBe(false);
    expect(def.exitCode).not.toBe(0);
    await runCli('-s=fetch-esc', 'close');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
test('wait-for waits for a selector or text to appear', async ({}) => {
  await runCli('-s=wait-for-test', 'open', 'data:text/html,<h1>Welcome</h1>');
  const found = await runCli('-s=wait-for-test', 'wait-for', 'text=Welcome', '--timeout=5', '--json');
  expect(JSON.parse(found.output).result.found).toBe(true);

  const missing = await runCli('-s=wait-for-test', 'wait-for', 'text=DefinitelyNotHere', '--timeout=1', '--json');
  expect(JSON.parse(missing.output).result.found).toBe(false);
  await runCli('-s=wait-for-test', 'close');
});

test('fetch --retry retries transient 5xx', async ({}) => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    if (requests === 1) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('overloaded');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP server address');

  try {
    await runCli('-s=fetch-retry', 'open', 'data:text/html,<title>R</title>');
    const result = await runCli('-s=fetch-retry', 'fetch', `http://127.0.0.1:${address.port}/`, '--retry=2', '--json');
    const payload = JSON.parse(result.output);
    expect(payload.ok).toBe(true);
    expect(payload.result.status).toBe(200);
    expect(payload.result.attempts).toBe(2);
    expect(payload.result.retried).toBe(true);
    await runCli('-s=fetch-retry', 'close');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('fetch rejects malformed URL with a clear message', async ({}) => {
  const { prepareCommandArgs } = require('../cliEnhancements');
  expect(() => prepareCommandArgs({ _: ['fetch', 'notaurl'] }))
      .toThrow(/Invalid URL 'notaurl': missing protocol/);
});

test('screenshot --inline returns base64 PNG', async ({}) => {
  await runCli('-s=screenshot-inline', 'open', 'data:text/html,<h1>Visual</h1>');
  const result = await runCli('-s=screenshot-inline', 'screenshot', '--inline', '--json');
  const payload = JSON.parse(result.output);
  expect(payload.result.mimeType).toBe('image/png');
  const buf = Buffer.from(payload.result.screenshot, 'base64');
  expect(buf.slice(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  await runCli('-s=screenshot-inline', 'close');
});

test('solve-captcha detects, times out, and injects tokens', async ({}) => {
  await runCli('-s=solve-captcha', 'open', 'data:text/html,<div class="cf-turnstile"></div><input name="cf-turnstile-response" value="">');

  const noToken = await runCli('-s=solve-captcha', 'solve-captcha', '--timeout=1', '--json');
  const noTokenPayload = JSON.parse(noToken.output).result;
  expect(noTokenPayload.captcha).toBe('turnstile');
  expect(noTokenPayload.solved).toBe(false);

  const injected = await runCli('-s=solve-captcha', 'solve-captcha', '--token=abc123', '--json');
  const injectedPayload = JSON.parse(injected.output).result;
  expect(injectedPayload.captcha).toBe('turnstile');
  expect(injectedPayload.solved).toBe(true);
  expect(injectedPayload.injected).toBe(true);

  // hCaptcha widget with the `recaptchacompat` flag must be detected as
  // hCaptcha, not reCAPTCHA, and use the hCaptcha token field.
  const hcaptchaGoto = await runCli('-s=solve-captcha', 'goto', 'data:text/html,<iframe src="https://hcaptcha.com/captcha/v2/api.js?recaptchacompat=true"></iframe><input name="h-captcha-response" value="">', '--timeout=5', '--json');
  expect(JSON.parse(hcaptchaGoto.output).result.challenge).toEqual({ type: 'hcaptcha', blocked: true });

  const hcaptchaSol = await runCli('-s=solve-captcha', 'solve-captcha', '--timeout=1', '--json');
  const hcaptchaPayload = JSON.parse(hcaptchaSol.output).result;
  expect(hcaptchaPayload.captcha).toBe('hcaptcha');
  expect(hcaptchaPayload.solved).toBe(false);

  await runCli('-s=solve-captcha', 'close');
});

test('solve-captcha integrates CapSolver (createTask/getTaskResult/token)', async ({}) => {
  const solver = http.createServer((req, res) => {
    req.resume(); // consume the request body so 'end' fires
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/createTask') {
        res.end(JSON.stringify({ errorId: 0, taskId: 'mock-task' }));
      } else if (req.url === '/getTaskResult') {
        res.end(JSON.stringify({ errorId: 0, status: 'ready', solution: { token: 'mock-token-xyz' } }));
      } else {
        res.end(JSON.stringify({ errorId: 1, errorDescription: 'bad endpoint' }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    solver.once('error', reject);
    solver.listen(0, '127.0.0.1', resolve);
  });
  const address = solver.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP server address');

  try {
    await runCli('-s=capsolver-test', 'open', 'data:text/html,<div class="cf-turnstile" data-sitekey="0xTESTKEY"></div><input name="cf-turnstile-response">');
    const result = await runCliWithOptions({
      env: { CAPSOLVER_API_URL: `http://127.0.0.1:${address.port}` },
    }, '-s=capsolver-test', 'solve-captcha', '--captcha-api-key=TEST', '--json');
    const payload = JSON.parse(result.output).result;
    expect(payload.captcha).toBe('turnstile');
    expect(payload.solver).toBe('capsolver');
    expect(payload.solved).toBe(true);
    expect(payload.token).toBe('mock-token-xyz');
    await runCli('-s=capsolver-test', 'close');
  } finally {
    solver.closeAllConnections();
    await new Promise<void>(resolve => solver.close(() => resolve()));
  }
});

test('solve-captcha auto-resolves via checkbox click in the iframe', async ({}) => {
  const parent = `<!DOCTYPE html><html><head><title>Mock</title></head><body>
<div class="cf-turnstile" data-sitekey="0xMOCK"></div>
<input type="hidden" name="cf-turnstile-response" id="cf-turnstile-response" value="">
<iframe id="w" src="/challenges.cloudflare.com/turnstile/iframe" style="width:300px;height:70px;border:none"></iframe>
<script>
window.addEventListener('message', (e) => { if (e.data && e.data.type === 'turnstile-token') document.getElementById('cf-turnstile-response').value = e.data.token; });
</script>
</body></html>`;
  const iframe = `<!DOCTYPE html><html><body>
<input type="checkbox" id="check" role="checkbox" style="width:24px;height:24px">
<script>
document.getElementById('check').addEventListener('change', (e) => {
  if (e.target.checked) setTimeout(() => parent.postMessage({ type: 'turnstile-token', token: 'resolved-token-xyz' }, '*'), 100);
});
</script>
</body></html>`;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url.includes('/challenges.cloudflare.com/') ? iframe : parent);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP server address');

  try {
    await runCli('-s=turnstile-resolve', 'open', `http://127.0.0.1:${address.port}/`);
    const result = await runCli('-s=turnstile-resolve', 'solve-captcha', '--timeout=10', '--json');
    const payload = JSON.parse(result.output).result;
    expect(payload.captcha).toBe('turnstile');
    expect(payload.solved).toBe(true);
    expect(payload.token).toBe('resolved-token-xyz');
    await runCli('-s=turnstile-resolve', 'close');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('solve-captcha resolves press-and-hold challenges', async ({}) => {
  const page = `<!DOCTYPE html><html><head><title>Verify</title></head><body>
<button id="holdbtn" style="width:200px;height:60px">Press and Hold</button>
<div id="status">not verified</div>
<script>
let t = null;
const btn = document.getElementById('holdbtn');
btn.addEventListener('mousedown', () => { t = setTimeout(() => {
  document.getElementById('status').innerText = 'verified';
  const inp = document.createElement('input');
  inp.type = 'hidden'; inp.name = 'human-verification'; inp.value = 'human-verified-123';
  document.body.appendChild(inp);
}, 3000); });
btn.addEventListener('mouseup', () => clearTimeout(t));
btn.addEventListener('mouseleave', () => clearTimeout(t));
</script></body></html>`;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP server address');

  try {
    await runCli('-s=press-hold', 'open', `http://127.0.0.1:${address.port}/`);
    const result = await runCli('-s=press-hold', 'solve-captcha', '--timeout=15', '--json');
    const payload = JSON.parse(result.output).result;
    expect(payload.captcha).toBe('hold');
    expect(payload.solved).toBe(true);
    expect(payload.token).toBe('human-verified-123');
    await runCli('-s=press-hold', 'close');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('goto reports soft 404 as failure', async ({}) => {
  const server = http.createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<html><title>Not Found</title><body>Page not found</body></html>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP server address');

  try {
    await runCli('-s=goto-soft404', 'open', 'data:text/html,<title>Start</title>');
    const result = await runCli('-s=goto-soft404', 'goto', `http://127.0.0.1:${address.port}/`, '--timeout=5', '--json');
    const payload = JSON.parse(result.output);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain('HTTP 404');
    expect(payload.result.status).toBe(404);
    expect(payload.result.failed).toBe(true);
    await runCli('-s=goto-soft404', 'close');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('goto --retry retries transient 5xx and reports attempts', async ({}) => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    // Count document attempts, independently of browser favicon requests.
    if (req.url !== '/') {
      res.writeHead(204);
      res.end();
      return;
    }
    requests++;
    if (requests === 1) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('transient failure');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>recovered</body></html>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP server address');

  try {
    await runCli('-s=goto-retry', 'open', 'data:text/html,<title>Start</title>');
    const result = await runCli('-s=goto-retry', 'goto', `http://127.0.0.1:${address.port}/`, '--timeout=5', '--retry=2', '--json');
    const payload = JSON.parse(result.output);
    expect(payload.ok).toBe(true);
    expect(payload.result.status).toBe(200);
    expect(payload.result.attempts).toBe(2);
    expect(payload.result.retried).toBe(true);
    expect(requests).toBe(2);
  } finally {
    await runCli('-s=goto-retry', 'close');
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('goto warns on stderr when redirected to a different host', async ({}) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/target') {
      res.end('<html><body>Local redirect target</body></html>');
      return;
    }
    res.writeHead(302, { location: `http://localhost:${address.port}/target` });
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP server address');

  try {
    await runCli('-s=goto-redirect-warn', 'open', 'data:text/html,<title>Start</title>');
    const result = await runCli('-s=goto-redirect-warn', 'goto', `http://127.0.0.1:${address.port}/`, '--timeout=15');
    // Text mode: warning on stderr, command still succeeds.
    expect(result.exitCode).toBe(0);
    expect(result.error).toContain('landed on a different host than requested');
    expect(result.error).toContain(`127.0.0.1:${address.port}`);
    expect(result.error).toContain(`http://localhost:${address.port}/target`);

    // Same-host navigation stays silent.
    const sameHost = await runCli('-s=goto-redirect-warn', 'goto', `http://127.0.0.1:${address.port}/target`, '--timeout=15');
    expect(sameHost.exitCode).toBe(0);
    expect(sameHost.error).not.toContain('landed on a different host');

  } finally {
    await runCli('-s=goto-redirect-warn', 'close');
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
test('fetch without URL reports missing argument', async ({}) => {
  const { prepareCommandArgs } = require('../cliEnhancements');
  expect(() => prepareCommandArgs({ _: ['fetch'] })).toThrow(/fetch requires a URL/);
});

test('structured success payload always has a provider field', async ({}) => {
  const { successPayload } = require('../cliEnhancements');
  expect(successPayload(undefined, 'done', [], undefined)).toEqual({
    ok: true,
    url: null,
    title: null,
    result: 'done',
    console: [],
    provider: null,
  });

  expect(successPayload(undefined, 'done', [], { name: 'cloakbrowser', version: cloakBrowserVersion })).toEqual({
    ok: true,
    url: null,
    title: null,
    result: 'done',
    console: [],
    provider: { name: 'cloakbrowser', version: cloakBrowserVersion },
  });
});

test('goto timeout fails quickly with structured navigation status', async ({}) => {
  const server = http.createServer(() => {});
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP server address');

  try {
    await runCli('-s=goto-timeout', 'open', 'data:text/html,<title>Before</title>');
    const startedAt = Date.now();
    const navigation = await runCli('-s=goto-timeout', 'goto', `http://127.0.0.1:${address.port}`, '--timeout=0.2', '--json');
    const elapsed = Date.now() - startedAt;
    const payload = JSON.parse(navigation.output);

    expect(navigation.exitCode).toBe(1);
    expect(elapsed).toBeLessThan(3000);
    expect(payload).toEqual(expect.objectContaining({
      ok: false,
      url: null,
      title: null,
      result: null,
      console: [],
      error: expect.stringContaining('Timeout 200ms exceeded'),
    }));
    expect(payload.error).not.toContain('\u001b');
  } finally {
    await runCli('-s=goto-timeout', 'close');
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('invalid navigation timeout returns the structured error contract', async ({}) => {
  await runCli('-s=invalid-timeout', 'open', 'data:text/html,<title>Before</title>');
  const result = await runCli('-s=invalid-timeout', 'goto', 'https://example.com', '--timeout=soon', '--json');
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.output)).toEqual({
    ok: false,
    url: null,
    title: null,
    result: null,
    console: [],
    error: "Invalid navigation timeout 'soon'. Use seconds (for example, --timeout=5).",
  });
  await runCli('-s=invalid-timeout', 'close');
});

test('sub-millisecond navigation timeouts are rejected instead of disabling the timeout', async ({}) => {
  const { parseTimeoutMs } = require('../cliEnhancements');
  // Playwright reads `timeout: 0` as "no timeout", so rounding a tiny value down
  // to zero would turn the most aggressive request into an indefinite wait.
  expect(() => parseTimeoutMs('0.0001')).toThrow(/too small/);
  expect(() => parseTimeoutMs('0.4ms')).toThrow(/too small/);
  expect(parseTimeoutMs('1ms')).toBe(1);
  expect(parseTimeoutMs('5')).toBe(5000);
});

test('goto --timeout without a URL reports the missing argument', async ({}) => {
  const { prepareCommandArgs } = require('../cliEnhancements');
  expect(() => prepareCommandArgs({ _: ['goto'], timeout: '5' }))
      .toThrow(/goto requires a URL/);
  const prepared = prepareCommandArgs({ _: ['goto', 'https://example.com'], timeout: '5' });
  expect(prepared._[1]).toContain('"https://example.com"');
  expect(prepared._[1]).not.toContain('goto(undefined');
});

test('goto --wait-until without a URL reports the missing argument', async ({}) => {
  const { prepareCommandArgs } = require('../cliEnhancements');
  expect(() => prepareCommandArgs({ _: ['goto'], 'wait-until': 'load' }))
      .toThrow(/goto requires a URL/);
});

test('invalid --wait-until value is rejected', async ({}) => {
  const { prepareCommandArgs } = require('../cliEnhancements');
  expect(() => prepareCommandArgs({ _: ['goto', 'https://example.com'], 'wait-until': 'never' }))
      .toThrow(/Invalid --wait-until/);
  expect(() => prepareCommandArgs({ _: ['goto', 'https://example.com'], 'wait-until': 'load' }))
      .not.toThrow();
});

test('goto --wait-until generates a run-code snippet with the right strategy', async ({}) => {
  const { prepareCommandArgs } = require('../cliEnhancements');
  const prepared = prepareCommandArgs({ _: ['goto', 'https://example.com'], 'wait-until': 'networkidle' });
  expect(prepared._[0]).toBe('run-code');
  expect(prepared._[1]).toContain("waitUntil: 'networkidle'");
  expect(prepared._[1]).toContain('navigation');
  expect(prepared._[1]).toContain('url: finalUrl');
  expect(prepared._[1]).toContain('status');
  expect(prepared._[1]).toContain('redirected');
  expect(prepared._[1]).toContain('challenge');
  expect(prepared._[1]).toContain('bodyLength');
  expect(prepared._[1]).toContain('emptyBody');
  expect(prepared._[1]).toContain('attempts');
});

test('goto without flags is not intercepted', async ({}) => {
  const { prepareCommandArgs } = require('../cliEnhancements');
  const prepared = prepareCommandArgs({ _: ['goto', 'https://example.com'] });
  expect(prepared._[0]).toBe('goto');
});

test('goto --timeout returns full navigation result with redirect detection', async ({}) => {
  await runCli('-s=goto-result', 'open', 'data:text/html,<title>Start</title>');
  const nav = await runCli('-s=goto-result', 'goto', 'data:text/html,<title>Target</title>', '--timeout=5', '--json');
  const payload = JSON.parse(nav.output);
  expect(nav.exitCode).toBe(0);
  expect(payload.ok).toBe(true);
  // The result from the evaluated snippet
  expect(payload.result.navigation).toBe('succeeded');
  expect(payload.result.url).toContain('data:text/html');
  expect(payload.result.title).toBe('Target');
  expect(payload.result.status === null || typeof payload.result.status === 'number').toBe(true);
  expect(payload.result.redirected).toBe(false);
  await runCli('-s=goto-result', 'close');
});

test('goto --timeout and --wait-until can be combined', async ({}) => {
  await runCli('-s=goto-combined', 'open', 'data:text/html,<title>Before</title>');
  const nav = await runCli('-s=goto-combined', 'goto', 'data:text/html,<title>After</title>', '--timeout=5', '--wait-until=load', '--json');
  const payload = JSON.parse(nav.output);
  expect(nav.exitCode).toBe(0);
  expect(payload.ok).toBe(true);
  expect(payload.result.navigation).toBe('succeeded');
  expect(payload.result.title).toBe('After');
  await runCli('-s=goto-combined', 'close');
});


test('parseTabList structures tab-list text output', async ({}) => {
  // We can't import parseTabList directly (it's not exported), so test via --json
  await runCli('-s=parse-tabs', 'open', 'data:text/html,<title>First</title>');
  await runCli('-s=parse-tabs', 'tab-new', 'data:text/html,<title>Second</title>');
  const result = await runCli('-s=parse-tabs', 'tab-list', '--json');
  const payload = JSON.parse(result.output);
  expect(payload.ok).toBe(true);
  expect(payload.result.tabs).toEqual([
    { index: 0, current: false, title: 'First', url: 'data:text/html,<title>First</title>' },
    { index: 1, current: true, title: 'Second', url: 'data:text/html,<title>Second</title>' },
  ]);
  await runCli('-s=parse-tabs', 'close');
});

test('parseConsoleOutput structures console text output', async ({}) => {
  await runCli('-s=parse-console', 'open', 'data:text/html,<title>C</title>');
  // Empty console
  const empty = await runCli('-s=parse-console', 'console', '--json');
  const emptyPayload = JSON.parse(empty.output);
  expect(emptyPayload.result).toEqual({ messages: [], summary: { total: 0, errors: 0, warnings: 0 } });
  await runCli('-s=parse-console', 'close');
});

test('parseRequestsList structures requests text output', async ({}) => {
  await runCli('-s=parse-reqs', 'open', 'data:text/html,<title>R</title>');
  const result = await runCli('-s=parse-reqs', 'requests', '--json');
  const payload = JSON.parse(result.output);
  expect(payload.ok).toBe(true);
  expect(payload.result.requests).toEqual([]);
  await runCli('-s=parse-reqs', 'close');
});

test('normalizeCommandResult passes through non-string results unchanged', async ({}) => {
  // Non-text commands (eval, snapshot, fetch) should return their structured result as-is
  await runCli('-s=pass-through', 'open', 'data:text/html,<title>PT</title>');
  const result = await runCli('-s=pass-through', 'eval', '() => ({ x: 1 })', '--json');
  const payload = JSON.parse(result.output);
  expect(payload.result).toEqual({ x: 1 });
  await runCli('-s=pass-through', 'close');
});
test('failure payloads survive errors that cannot be serialized', async ({}) => {
  const { failurePayload } = require('../cliEnhancements');
  const circular: any = { a: 1 };
  circular.self = circular;
  expect(() => failurePayload(circular)).not.toThrow();
  expect(failurePayload(circular)).toEqual(expect.objectContaining({
    ok: false,
    error: expect.any(String),
  }));

  const bigint = { size: BigInt(1) };
  expect(() => failurePayload(bigint)).not.toThrow();
});

test('generated provider config directories are removed on exit', async ({}) => {
  const probe = `
    const providers = require(${JSON.stringify(path.join(__dirname, '../browserProviders.js'))});
    const state = providers.createProviderState('open', ['open'], {});
    process.stdout.write(state.configDir);
  `;
  const configDir = execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8' }).trim();
  expect(configDir).toContain('playwright-cli-browser-');
  expect(fs.existsSync(configDir)).toBe(false);
});

test('challenge detection flags Cloudflare-style pages', async ({}) => {
  // detectChallengeFromText is not exported; test via the payload path instead
  await runCli('-s=challenge-test', 'open', 'data:text/html,<title>Just a moment...</title><p>Checking your browser before accessing</p>');
  const result = await runCli('-s=challenge-test', 'eval', '() => document.title', '--json');
  const payload = JSON.parse(result.output);
  expect(payload.challenge).toEqual({ type: 'cloudflare', blocked: true });
  expect(payload.bodyLength).toBeGreaterThan(0);
  expect(payload.emptyBody).toBe(false);
  expect(payload.webdriver).toBe(false);
  await runCli('-s=challenge-test', 'close');
});

test('empty body is reported with emptyBody flag', async ({}) => {
  await runCli('-s=empty-test', 'open', 'data:text/html,');
  const result = await runCli('-s=empty-test', 'eval', '() => document.body.innerText', '--json');
  const payload = JSON.parse(result.output);
  expect(payload.bodyLength).toBe(0);
  expect(payload.emptyBody).toBe(true);
  await runCli('-s=empty-test', 'close');
});

test('cleanup command removes accumulated artifacts', async ({}) => {
  const outputDir = path.join(process.cwd(), '.playwright-cli');
  const probe = `
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(process.cwd(), '.playwright-cli');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'page-test-old.yml'), '');
    fs.writeFileSync(path.join(dir, 'console-test-old.log'), '');
  `;
  execFileSync(process.execPath, ['-e', probe]);
  const result = execFileSync(process.execPath, [path.join(__dirname, '../playwright-cli.js'), 'cleanup', '--all', '--json'], { encoding: 'utf8' });
  const payload = JSON.parse(result);
  expect(payload.removed).toBeGreaterThanOrEqual(2);
  expect(fs.existsSync(path.join(outputDir, 'page-test-old.yml'))).toBe(false);
  expect(fs.existsSync(path.join(outputDir, 'console-test-old.log'))).toBe(false);
});

test('host-resolver-rules flag is extracted for DNS override', async ({}) => {
  // flagValue is internal; verify via a state probe
  const probe = `
    const providers = require(${JSON.stringify(path.join(__dirname, '../browserProviders.js'))});
    const state = providers.createProviderState('open', ['open', '--host-resolver-rules=MAP example.com 1.2.3.4'], {});
    process.stdout.write(JSON.stringify({ rules: state.hostResolverRules }));
  `;
  const out = execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8' }).trim();
  expect(JSON.parse(out)).toEqual({ rules: 'MAP example.com 1.2.3.4' });
});

test('request-headers and response-headers --json return structured headers', async ({}) => {
  const opened = await runCli('-s=headers-test', 'open', 'https://httpbin.org/get');
  expect(opened.exitCode, opened.error).toBe(0);
  await new Promise(resolve => setTimeout(resolve, 2000));
  const responseHeaders = await runCli('-s=headers-test', 'response-headers', '1', '--json');
  const payload = JSON.parse(responseHeaders.output);
  expect(payload.ok, responseHeaders.output).toBe(true);
  expect(typeof payload.result.headers).toBe('object');
  expect(payload.result.headers).toEqual(expect.objectContaining({ 'content-type': 'application/json' }));
  await runCli('-s=headers-test', 'close');
});

test('default config preserves context settings and rejects malformed JSON', async () => {
  const cwd = test.info().outputPath();
  const configPath = path.join(cwd, '.playwright', 'cli.config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ browser: { contextOptions: { locale: 'fr-FR', userAgent: 'HeadlessChrome' } } }));
  try {
    const opened = await runCli('-s=config-context', 'open', 'data:text/html,hello', '--json');
    expect(opened.exitCode, opened.error).toBe(0);
    const result = await runCli('-s=config-context', 'eval', '() => ({ language: navigator.language, ua: navigator.userAgent })', '--json');
    expect(JSON.parse(result.output).result.language).toBe('fr-FR');
    expect(JSON.parse(result.output).result.ua).not.toContain('HeadlessChrome');
  } finally {
    await runCli('-s=config-context', 'close');
  }
  fs.writeFileSync(configPath, '{');
  try {
    const invalid = await runCli('-s=config-invalid', 'open', 'data:text/html,hello', '--json');
    expect(invalid.exitCode).toBe(1);
    expect(invalid.output).toContain('cli.config.json');
  } finally {
    fs.rmSync(configPath);
    await runCli('-s=config-invalid', 'close');
  }
});

test('scrape retries empty and server-error pages and reports exhausted HTTP failures', async () => {
  test.setTimeout(60_000);
  const counts = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const route = req.url ?? '/';
    const count = (counts.get(route) ?? 0) + 1;
    counts.set(route, count);
    const failing = route === '/always' || count === 1;
    res.writeHead(failing && route !== '/empty' ? 500 : 200, { 'content-type': 'text/html' });
    res.end(failing && route === '/empty' ? '<html><body></body></html>' : `<html><body>${failing ? 'Service unavailable' : 'Recovered content'}</body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const route of ['/empty', '/error']) {
      const result = await runCli('scrape', `${base}${route}`, '--retry=1');
      const payload = JSON.parse(result.output);
      expect(payload.text).toContain('Recovered content');
      expect(payload.attempts).toBe(2);
      expect(counts.get(route)).toBe(2);
    }
    const exhausted = await runCli('scrape', `${base}/always`, '--crawl', '--retry=0');
    const payload = JSON.parse(exhausted.output);
    expect(exhausted.exitCode).toBe(1);
    expect(payload.ok).toBe(false);
    expect(payload.results[0].challenge.blocked).toBe(false);
    expect(payload.results[0].text).toContain('Service unavailable');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('scrape only reports CAPTCHA solved after the page unblocks', async () => {
  test.setTimeout(60_000);
  const server = http.createServer((req, res) => {
    if (req.url === '/createTask' || req.url === '/getTaskResult') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/createTask' ? { errorId: 0, taskId: 'fixture' } : { errorId: 0, status: 'ready', solution: { token: 'fixture-token' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    const unblock = req.url === '/unblock' ? '<script>document.querySelector("input").addEventListener("change", () => setTimeout(() => { document.body.innerHTML = "<h1>Verified content</h1>"; }, 100));</script>' : '';
    res.end(`<html><body><div class="cf-turnstile" data-sitekey="fixture">Challenge content</div><input name="cf-turnstile-response">${unblock}</body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const base = `http://127.0.0.1:${address.port}`;
  const options = { env: { CAPSOLVER_API_KEY: 'fixture-key', CAPSOLVER_API_URL: base } };
  try {
    const blocked = await runCliWithOptions(options, 'scrape', `${base}/blocked`, '--retry=0', '--timeout=5');
    const payload = JSON.parse(blocked.output);
    expect(payload.ok).toBe(false);
    expect(payload.text).toBe('');
    expect(blocked.exitCode).toBe(1);
    const solved = await runCliWithOptions(options, 'scrape', `${base}/unblock`, '--retry=0', '--timeout=5');
    expect(JSON.parse(solved.output).ok).toBe(true);
    expect(JSON.parse(solved.output).text).toContain('Verified content');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('scrape accepts separated option values and short help', async () => {
  const { parseScrapeArgs } = require('../scraper');
  expect(parseScrapeArgs(['scrape', 'http://localhost/', '--select', 'h1', '--retry', '0', '--output-format', 'csv'])).toMatchObject({ select: 'h1', retries: 0, outputFormat: 'csv' });
  const help = await runCli('scrape', '-h');
  expect(help.exitCode).toBe(0);
  expect(help.output).toContain('--output-format');
});

test('scrape bounds navigation retries and excludes redirected cross-origin content', async () => {
  test.setTimeout(60_000);
  const server = http.createServer((req, res) => {
    if (req.url === '/hang') return;
    if (req.url === '/redirect') {
      res.writeHead(302, { location: `http://localhost:${address.port}/foreign` });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url === '/foreign' ? '<html><body>Foreign content</body></html>' : '<html><body>Home<a href="/redirect">redirect</a></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const result = await runCli('scrape', base, '--crawl', '--max-requests=3', '--retry=0');
    expect(result.exitCode, result.error).toBe(0);
    expect(result.output).not.toContain('Foreign content');
    expect(JSON.parse(result.output).results).toHaveLength(1);
    const start = Date.now();
    const hanging = await runCli('scrape', `${base}/hang`, '--timeout=1', '--retry=0');
    expect(hanging.exitCode).toBe(1);
    expect(JSON.parse(hanging.output).attempts).toBe(1);
    expect(JSON.parse(hanging.output).challenge.blocked).toBe(false);
    expect(Date.now() - start).toBeLessThan(15_000);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('httpcloak honors subsecond timeout and preserves binary bytes', async () => {
  const bytes = Buffer.from([0, 128, 255, 1, 254]);
  const timers = new Set<NodeJS.Timeout>();
  const server = http.createServer((req, res) => {
    if (req.url === '/slow') {
      const timer = setTimeout(() => { res.end('too late'); timers.delete(timer); }, 1500);
      timers.add(timer);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(bytes);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const timeout = await runCli('fetch', `${base}/slow`, '--engine=httpcloak', '--timeout=0.1', '--json');
    expect(timeout.exitCode).toBe(1);
    expect(JSON.parse(timeout.output).ok).toBe(false);
    const binary = await runCli('fetch', base, '--engine=httpcloak', '--json');
    expect(binary.exitCode, binary.output).toBe(0);
    expect(JSON.parse(binary.output).result.body).toBe(bytes.toString('base64'));
  } finally {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('default fetch escalates HTTP challenges and browser challenges fail closed', async () => {
  let attempts = 0;
  const server = http.createServer((req, res) => {
    const challenge = req.url === '/blocked' || (req.url === '/recover' && ++attempts === 1);
    res.writeHead(challenge && req.url === '/recover' ? 403 : 200, { 'content-type': 'text/html' });
    res.end(challenge ? '<html><body>Checking your browser before accessing</body></html>' : '<html><body>Verified content</body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await runCli('-s=fetch-recover', 'open', base);
    const recovered = await runCli('-s=fetch-recover', 'fetch', `${base}/recover`, '--json');
    expect(JSON.parse(recovered.output).ok).toBe(true);
    expect(JSON.parse(recovered.output).result.engine).toBe('browser');
    expect(attempts).toBe(2);
    const blocked = await runCli('-s=fetch-recover', 'fetch', `${base}/blocked`, '--json');
    expect(JSON.parse(blocked.output).ok).toBe(false);
    expect(JSON.parse(blocked.output).result.challenge.blocked).toBe(true);
    expect(blocked.exitCode).toBe(1);
    for (const flags of [[], ['--raw']]) {
      const text = await runCli('-s=fetch-recover', 'fetch', `${base}/blocked`, ...flags);
      expect(text.exitCode, text.output).toBe(1);
    }
  } finally {
    await runCli('-s=fetch-recover', 'close');
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('published package includes the scrape runtime', async () => {
  const output = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const packages: Record<string, { files: { path: string }[] }> = JSON.parse(output);
  expect(Object.values(packages)[0].files.map(file => file.path)).toEqual(expect.arrayContaining([
    'playwright-cli.js', 'browserProviders.js', 'cliEnhancements.js', 'scraper.js',
  ]));
});

test('runtime dependency graph contains standard Playwright and no Patchright', async () => {
  const pkg = require('../package.json');
  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '../package-lock.json'), 'utf8'));
  expect(pkg.dependencies['playwright-core']).toBe(pkg.dependencies.playwright);
  expect(pkg.dependencies).not.toHaveProperty('patchright-core');
  expect(Object.keys(lock.packages).some(name => /(?:^|\/)patchright(?:-core)?$/.test(name))).toBe(false);
});

test('standard Playwright controls CloakBrowser without loading Patchright', async () => {
  const hook = test.info().outputPath('reject-patchright.cjs');
  fs.writeFileSync(hook, `
    const Module = require('module');
    const originalLoad = Module._load;
    Module._load = function(id, ...args) {
      if (/patchright/.test(id)) throw new Error('Patchright must not load');
      return originalLoad.call(this, id, ...args);
    };
  `);
  const options = { env: { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(hook)}` } };
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/frame' ? '<button onclick="parent.document.querySelector(\'h1\').textContent=\'Clicked\'">Click me</button>' : '<html><body><h1>Ready</h1><iframe src="/frame"></iframe></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const url = `http://127.0.0.1:${address.port}/`;
  try {
    const opened = await runCliWithOptions(options, '-s=standard-runtime', 'open', url, '--json');
    expect(opened.exitCode, opened.output || opened.error).toBe(0);
    expect(JSON.parse(opened.output).provider.name).toBe('cloakbrowser');
    const result = await runCliWithOptions(options, '-s=standard-runtime', 'run-code', `async page => {
      await page.addInitScript(() => { window.runtimeInit = 'installed'; });
      await page.goto(${JSON.stringify(url)});
      await page.frameLocator('iframe').getByRole('button').click();
      return await page.evaluate(() => ({ init: window.runtimeInit, text: document.querySelector('h1').textContent, webdriver: navigator.webdriver, ua: navigator.userAgent }));
    }`, '--json');
    expect(result.exitCode, result.output).toBe(0);
    expect(JSON.parse(result.output).result).toMatchObject({ init: 'installed', text: 'Clicked', webdriver: false });
    expect(JSON.parse(result.output).result.ua).not.toContain('HeadlessChrome');
  } finally {
    await runCliWithOptions(options, '-s=standard-runtime', 'close');
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('removed provider metadata and fallback state cannot claim active provenance', async () => {
  try {
    await runCli('-s=removed-metadata', 'open', 'data:text/html,<title>Current</title>');
    const daemonRoot = path.join(test.info().outputPath(), 'daemon');
    const relative = fs.readdirSync(daemonRoot, { recursive: true }).map(String).find(file => file.endsWith('removed-metadata.provider.json'));
    expect(relative).toBeTruthy();
    const metadata = path.join(daemonRoot, relative!);
    fs.writeFileSync(metadata, JSON.stringify({ provider: 'patchright', version: 'old', fallback: { requested: 'camoufox', active: 'patchright', reason: 'legacy' } }));
    const result = await runCli('-s=removed-metadata', 'eval', '() => document.title', '--json');
    const payload = JSON.parse(result.output);
    expect(payload.provider.name).toBe('cloakbrowser');
    expect(payload).not.toHaveProperty('fallback');
  } finally {
    await runCli('-s=removed-metadata', 'close');
  }
});

// --- Issue regressions (P1 review batch) -------------------------------

test('fetch --help and -h print usage without dispatching a request (issue 47)', async () => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const flag of ['--help', '-h']) {
      const result = await runCli('fetch', `${base}/`, '--method=POST', flag);
      expect(result.exitCode, result.output).toBe(0);
      expect(result.output).toContain('playwright-cli fetch <url>');
    }
    const noUrl = await runCli('fetch', '--help');
    expect(noUrl.exitCode).toBe(0);
    expect(noUrl.output).toContain('playwright-cli fetch <url>');
    expect(requests).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('proxy credentials are redacted in JSON output (issue 60)', async () => {
  // A live proxy fixture: the engine routes through it, and the reported
  // metadata must still never expose the embedded credentials.
  const proxy = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"fixture":true}');
  });
  await new Promise<void>((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
  try {
    const result = await runCliWithOptions({
      env: { PLAYWRIGHT_MCP_PROXY_SERVER: `http://test-user:TEST_ONLY_SECRET@127.0.0.1:${address.port}` },
    }, 'fetch', 'http://example.com/', '--engine=wreq', '--json');
    expect(result.output).not.toContain('TEST_ONLY_SECRET');
    expect(result.error).not.toContain('TEST_ONLY_SECRET');
    expect(JSON.parse(result.output).proxy.server).toBe(`http://127.0.0.1:${address.port}/`);
  } finally {
    proxy.closeAllConnections();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
  }
});

test('benign vendor mentions and noscript notices are not challenges (issue 46)', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url === '/article')
      return res.end('<html><title>Integration documentation</title><body><h1>DataDome integration guide</h1><p>Configure the integration.</p></body></html>');
    res.end('<html><body><noscript>Please enable JavaScript for interactive features.</noscript><h1>Public article</h1><p>Complete readable content.</p></body></html>');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const path of ['/article', '/noscript']) {
      const result = await runCli('fetch', `${base}${path}`, '--engine=wreq', '--json');
      expect(result.exitCode, result.output).toBe(0);
      expect(JSON.parse(result.output).ok).toBe(true);
    }
    const scraped = await runCli('scrape', `${base}/article`);
    expect(JSON.parse(scraped.output).text).toContain('DataDome integration guide');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('challenge escalation never replays a POST automatically (issue 48)', async () => {
  let posts = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      posts++;
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><title>Just a moment</title><body>Checking your browser</body></html>');
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body><h1>Ready</h1></body></html>');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
  try {
    await runCli('-s=issue48', 'open', `http://127.0.0.1:${address.port}/`);
    const result = await runCli('-s=issue48', 'fetch', `http://127.0.0.1:${address.port}/create`, '--method=POST', '--data={"item":"example"}', '--retry=0', '--json');
    expect(posts, result.output).toBe(1);
    await runCli('-s=issue48', 'close');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('HTTP engines route through the configured proxy (issue 44)', async () => {
  const hits: string[] = [];
  const target = http.createServer((req, res) => {
    hits.push('target');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"source":"target"}');
  });
  const proxy = http.createServer((req, res) => {
    hits.push('proxy');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"source":"proxy"}');
  });
  await new Promise<void>((resolve, reject) => { target.once('error', reject); target.listen(0, '127.0.0.1', resolve); });
  await new Promise<void>((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
  const targetAddress = target.address();
  const proxyAddress = proxy.address();
  if (!targetAddress || typeof targetAddress === 'string' || !proxyAddress || typeof proxyAddress === 'string')
    throw new Error('Expected TCP server addresses');
  const env = {
    PLAYWRIGHT_MCP_PROXY_SERVER: `http://127.0.0.1:${proxyAddress.port}`,
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    NO_PROXY: '',
    PLAYWRIGHT_MCP_PROXY_BYPASS: '',
  };
  try {
    for (const engine of ['wreq', 'httpcloak']) {
      hits.length = 0;
      const result = await runCliWithOptions({ env }, 'fetch', `http://127.0.0.1:${targetAddress.port}/`, `--engine=${engine}`, '--json');
      // The target must never be reached directly; the engine must consult the
      // proxy. httpcloak tunnels via CONNECT, so a plain fixture yields a
      // proxy-dial error that still proves routing (and never a direct hit).
      expect(hits, `${engine}: ${result.output}`).not.toContain('target');
      const routed = hits.includes('proxy') || /dial_proxy|proxy/i.test(result.output);
      expect(routed, `${engine}: ${result.output}`).toBe(true);
      if (hits.includes('proxy'))
        expect(JSON.parse(result.output).result.json.source).toBe('proxy');
    }
  } finally {
    target.closeAllConnections();
    proxy.closeAllConnections();
    await new Promise<void>(resolve => target.close(() => resolve()));
    await new Promise<void>(resolve => proxy.close(() => resolve()));
  }
});

test('solve-captcha never leaks the CapSolver key into output (issue 49)', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body><h1>No widget here</h1></body></html>');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
  try {
    await runCli('-s=issue49', 'open', `http://127.0.0.1:${address.port}/`);
    for (const args of [['solve-captcha'], ['solve-captcha', '--json']]) {
      const result = await runCliWithOptions({ env: { CAPSOLVER_API_KEY: 'TEST_ONLY_SENTINEL_KEY' } }, '-s=issue49', ...args);
      expect(result.output).not.toContain('TEST_ONLY_SENTINEL_KEY');
      expect(result.error).not.toContain('TEST_ONLY_SENTINEL_KEY');
    }
    const flagged = await runCliWithOptions({ env: {} }, '-s=issue49', 'solve-captcha', '--captcha-api-key=TEST_ONLY_FLAG_KEY');
    expect(flagged.output).not.toContain('TEST_ONLY_FLAG_KEY');
    expect(flagged.error).not.toContain('TEST_ONLY_FLAG_KEY');
    await runCli('-s=issue49', 'close');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('user agent matches the CloakBrowser fingerprint platform (issue 56)', async () => {
  await runCli('-s=issue56', 'open', 'data:text/html,<title>UA</title>');
  const result = await runCli('-s=issue56', 'eval', '() => ({ ua: navigator.userAgent, uaPlatform: navigator.userAgentData?.platform, platform: navigator.platform })', '--json');
  const info = JSON.parse(result.output).result;
  await runCli('-s=issue56', 'close');
  // Whichever platform CloakBrowser fingerprints, the UA string must agree.
  if (info.uaPlatform === 'Windows')
    expect(info.ua).toContain('Windows NT');
  else if (info.uaPlatform === 'macOS')
    expect(info.ua).toContain('Macintosh');
  else if (info.uaPlatform === 'Linux')
    expect(info.ua).toContain('X11; Linux');
  expect(info.ua).not.toContain('HeadlessChrome');
});

test('goto --timeout keeps the file: protocol restriction (issue 58)', async () => {
  const cwd = test.info().outputPath();
  const workspace = path.join(cwd, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const outside = path.join(cwd, 'outside.html');
  fs.writeFileSync(outside, '<html><title>Outside</title><body>TEST_ONLY_OUTSIDE</body></html>');
  const env = { PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS: 'false' };
  try {
    await runCliWithOptions({ cwd: workspace, env }, '-s=issue58', 'open', 'data:text/html,<h1>Start</h1>');
    const plain = await runCliWithOptions({ cwd: workspace, env }, '-s=issue58', 'goto', `file://${outside}`, '--json');
    expect(plain.exitCode).not.toBe(0);
    const withTimeout = await runCliWithOptions({ cwd: workspace, env }, '-s=issue58', 'goto', `file://${outside}`, '--timeout=2', '--json');
    expect(withTimeout.exitCode, withTimeout.output).not.toBe(0);
    expect(JSON.parse(withTimeout.output).ok).toBe(false);
    await runCliWithOptions({ cwd: workspace, env }, '-s=issue58', 'close');
  } finally {
    fs.rmSync(outside, { force: true });
  }
});

test('fetch argv parser keeps separated values that begin with a dash (issue 52)', async () => {
  const { parseCliArgv } = require('../cliEnhancements');
  const { flags } = parseCliArgv(['fetch', 'http://example.com/', '--data', '-1', '--json'], 'fetch', { json: true, raw: true });
  expect(flags.data).toBe('-1');
  const longValue = parseCliArgv(['fetch', 'http://example.com/', '--data', '--json'], 'fetch', { json: true, raw: true });
  expect(longValue.flags.data).toBe(true);
});

test('browser engine returns binary bodies losslessly (issue 21)', async () => {
  const bytes = Buffer.from([0, 255, 254, 128, 195, 40, 13, 10]);
  const server = http.createServer((req, res) => {
    if (req.url === '/binary') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(bytes);
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><title>Binary host</title><body>ok</body></html>');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
  try {
    // The browser engine fetches in-page, so the session must be on the same
    // origin as the binary target.
    await runCli('-s=issue21', 'open', `http://127.0.0.1:${address.port}/`);
    const result = await runCli('-s=issue21', 'fetch', `http://127.0.0.1:${address.port}/binary`, '--engine=browser', '--json');
    const payload = JSON.parse(result.output).result;
    expect(payload.binary).toBe(true);
    expect(Buffer.from(payload.body, 'base64').equals(bytes)).toBe(true);
    await runCli('-s=issue21', 'close');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('wreq --timeout bounds body consumption, not just headers (issue 39)', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.flushHeaders();
    setTimeout(() => res.end('Delayed body'), 2500);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
  try {
    const result = await runCli('fetch', `http://127.0.0.1:${address.port}/`, '--engine=wreq', '--timeout=0.3', '--retry=0', '--json');
    // The timeout must cover body consumption: a stalled body is a failure,
    // not a successful response that arrives late.
    expect(result.exitCode, result.output).not.toBe(0);
    const payload = JSON.parse(result.output);
    expect(payload.ok).toBe(false);
    expect(payload.result).toBeNull();
    expect(payload.error).toContain('timed out');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('scrape reports truncation instead of silently capping extraction (issue 61)', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><body><ul>${Array.from({ length: 12 }, (_, i) => `<li>item-${i}</li>`).join('')}</ul></body></html>`);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
  const base = `http://127.0.0.1:${address.port}`;
  const schemaFile = path.join(test.info().outputPath(), 'all-schema.json');
  fs.writeFileSync(schemaFile, JSON.stringify({ items: { selector: 'li', all: true } }));
  try {
    // Cap below the match count: partial output must be flagged.
    const capped = await runCli('scrape', `${base}/`, '--select=li', '--max-items=5');
    const cappedPayload = JSON.parse(capped.output);
    expect(cappedPayload.selected).toHaveLength(5);
    expect(cappedPayload.truncated.selected).toEqual({ returned: 5, total: 12 });

    const cappedSchema = await runCli('scrape', `${base}/`, `--schema=${schemaFile}`, '--max-items=5');
    expect(JSON.parse(cappedSchema.output).truncated.items).toEqual({ returned: 5, total: 12 });

    // Above the match count: complete output, no truncation metadata.
    const complete = await runCli('scrape', `${base}/`, '--select=li', '--max-items=50');
    const completePayload = JSON.parse(complete.output);
    expect(completePayload.selected).toHaveLength(12);
    expect(completePayload.truncated).toBeUndefined();
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('scrape csv round-trips values containing CR, LF, commas and quotes (issue 62)', async () => {
  const value = 'alpha\rbravo\ncharlie,dave"echo';
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><body><p data-value="${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">Fixture</p></body></html>`);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
  const schemaFile = path.join(test.info().outputPath(), 'cr-schema.json');
  fs.writeFileSync(schemaFile, JSON.stringify({ value: { selector: 'p', attr: 'data-value' } }));
  try {
    const result = await runCli('scrape', `http://127.0.0.1:${address.port}/`, `--schema=${schemaFile}`, '--output-format=csv');
    const lines = result.output.split('\n');
    expect(lines[0]).toBe('value');
    // The data row is one quoted field: 1 header + 1 record, not several.
    const dataRow = result.output.slice(result.output.indexOf('\n') + 1);
    expect(dataRow.startsWith('"')).toBe(true);
    expect(dataRow.trimEnd().endsWith('"')).toBe(true);
    expect(dataRow).toContain('""echo');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('fetch preserves header values containing commas (issue 45)', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ headers: req.headers }));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
  try {
    const accept = await runCli('fetch', `http://127.0.0.1:${address.port}/`, '--engine=wreq', '--header=Accept: application/json, text/plain', '--json');
    expect(JSON.parse(accept.output).result.json.headers.accept).toBe('application/json, text/plain');

    const date = 'Wed, 21 Oct 2015 07:28:00 GMT';
    const modified = await runCli('fetch', `http://127.0.0.1:${address.port}/`, '--engine=wreq', `--header=If-Modified-Since: ${date}`, '--json');
    expect(JSON.parse(modified.output).result.json.headers['if-modified-since']).toBe(date);

    // Bare name and explicit multiple headers still work.
    const multi = await runCli('fetch', `http://127.0.0.1:${address.port}/`, '--engine=wreq', '--header=X-One: 1, X-Two: 2', '--json');
    const headers = JSON.parse(multi.output).result.json.headers;
    expect(headers['x-one']).toBe('1');
    expect(headers['x-two']).toBe('2');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('fetch result shape is identical across engines for a JSON body (issue 68)', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/api') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"value":42}');
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><title>Host</title><body>ok</body></html>');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
  const base = `http://127.0.0.1:${address.port}`;
  const fields = ['status', 'statusText', 'url', 'redirected', 'headers', 'body', 'attempts', 'retried', 'binary', 'json', 'failed'];
  try {
    await runCli('-s=issue68', 'open', `${base}/`);
    const wreq = JSON.parse((await runCli('-s=issue68', 'fetch', `${base}/api`, '--engine=wreq', '--json')).output).result;
    const browser = JSON.parse((await runCli('-s=issue68', 'fetch', `${base}/api`, '--engine=browser', '--json')).output).result;
    for (const field of fields)
      expect(Object.hasOwn(browser, field), `browser engine result missing '${field}'`).toBe(true);
    expect(wreq.json).toEqual({ value: 42 });
    expect(browser.json).toEqual({ value: 42 });
    expect(browser.binary).toBe(false);
    await runCli('-s=issue68', 'close');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('POST Content-Type is consistent across all engines (issue 69)', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/strict') {
      const contentType = req.headers['content-type'];
      res.statusCode = String(contentType).startsWith('application/json') ? 200 : 415;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ contentType, status: res.statusCode }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><title>Host</title><body>ok</body></html>');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await runCli('-s=issue69', 'open', `${base}/`);
    for (const engine of ['wreq', 'httpcloak', 'browser']) {
      const implicit = await runCli('-s=issue69', 'fetch', `${base}/strict`, `--engine=${engine}`, '--method=POST', '--data={"value":42}', '--json');
      const payload = JSON.parse(implicit.output);
      expect(implicit.exitCode, `${engine}: ${implicit.output}`).toBe(0);
      expect(payload.result.json.contentType, `${engine} implicit content-type`).toMatch(/^application\/json/);
      expect(payload.result.json.status).toBe(200);
    }
    // An explicit header still wins.
    const explicit = await runCli('-s=issue69', 'fetch', `${base}/strict`, '--engine=browser', '--method=POST', '--data={"value":42}', '--header=Content-Type: application/json', '--json');
    expect(JSON.parse(explicit.output).result.json.contentType).toMatch(/^application\/json/);
    await runCli('-s=issue69', 'close');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('wait-for reports failure on timeout and invalid selectors (issue 70)', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body><h1>Ready</h1></body></html>');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
  try {
    await runCli('-s=issue70', 'open', `http://127.0.0.1:${address.port}/`);

    const present = await runCli('-s=issue70', 'wait-for', 'h1', '--timeout=2', '--json');
    expect(present.exitCode, present.output).toBe(0);
    expect(JSON.parse(present.output).result.found).toBe(true);

    for (const selector of ['#missing', '[']) {
      const json = await runCli('-s=issue70', 'wait-for', selector, '--timeout=1', '--json');
      expect(json.exitCode, `${selector}: ${json.output}`).not.toBe(0);
      const payload = JSON.parse(json.output);
      expect(payload.ok).toBe(false);
      expect(payload.result.found).toBe(false);
      expect(payload.error).toBeTruthy();

      const text = await runCli('-s=issue70', 'wait-for', selector, '--timeout=1');
      expect(text.exitCode, `${selector} text: ${text.output}`).not.toBe(0);
    }
    await runCli('-s=issue70', 'close');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('goto retry-delay treats a bare value as milliseconds (issue 71)', async () => {
  const hits: Record<string, number> = {};
  const server = http.createServer((req, res) => {
    hits[req.url!] = (hits[req.url!] ?? 0) + 1;
    res.writeHead(hits[req.url!] === 1 ? 503 : 200, { 'content-type': 'text/html' });
    res.end('<html><body><h1>Ready</h1></body></html>');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await runCli('-s=issue71', 'open', `${base}/`);
    // Documented default is milliseconds: bare and `ms` must behave the same.
    for (const delay of ['2', '2ms']) {
      const startedAt = Date.now();
      const result = await runCli('-s=issue71', 'goto', `${base}/retry-${delay}`, '--retry=1', `--retry-delay=${delay}`, '--timeout=3', '--json');
      const elapsed = Date.now() - startedAt;
      expect(JSON.parse(result.output).result.attempts, `${delay}: ${result.output}`).toBe(2);
      // Seconds-semantics would stall ~2000ms; milliseconds stays well under it.
      expect(elapsed, `retry-delay=${delay} took ${elapsed}ms`).toBeLessThan(1500);
    }
    await runCli('-s=issue71', 'close');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('tab-list parses bracketed titles and parenthesized URLs (issue 63)', async () => {
  const { parseTabList } = require('../cliEnhancements');
  const parsed = parseTabList([
    '- 0: [Report [final]](http://127.0.0.1:8765/brackets)',
    '- 1: (current) [Normal report](http://127.0.0.1:8765/page(1))',
    '- 2: [](https://example.com/)',
    'garbage line that must be ignored',
  ].join('\n'));
  expect(parsed.tabs).toEqual([
    { index: 0, current: false, title: 'Report [final]', url: 'http://127.0.0.1:8765/brackets' },
    { index: 1, current: true, title: 'Normal report', url: 'http://127.0.0.1:8765/page(1)' },
    { index: 2, current: false, title: '', url: 'https://example.com/' },
  ]);
});

test('scrape from an image-only page succeeds on attribute extraction (issue 66)', async () => {
  const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  let requests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/gallery')
      requests++;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><body><img src="${gif}"></body></html>`);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
  const schemaFile = path.join(test.info().outputPath(), 'image-schema.json');
  fs.writeFileSync(schemaFile, JSON.stringify({ image: { selector: 'img', attr: 'src' } }));
  try {
    const result = await runCli('scrape', `http://127.0.0.1:${address.port}/gallery`, `--schema=${schemaFile}`, '--retry=1');
    const payload = JSON.parse(result.output);
    expect(result.exitCode, result.output).toBe(0);
    expect(payload.ok).toBe(true);
    expect(payload.failed).toBe(false);
    expect(payload.extracted.image).toBe(gif);
    expect(payload.attempts).toBe(1);
    expect(requests, 'a valid extraction must not be retried').toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('scrape schema fails on an invalid selector but allows a no-match selector (issue 43)', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body><h1>Actual heading</h1></body></html>');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
  const base = `http://127.0.0.1:${address.port}`;
  const invalid = path.join(test.info().outputPath(), 'invalid-schema.json');
  const noMatch = path.join(test.info().outputPath(), 'nomatch-schema.json');
  fs.writeFileSync(invalid, JSON.stringify({ heading: { selector: '[' } }));
  fs.writeFileSync(noMatch, JSON.stringify({ heading: { selector: '#nope' } }));
  try {
    for (const retry of ['0', '1']) {
      const bad = await runCli('scrape', `${base}/`, `--schema=${invalid}`, `--retry=${retry}`);
      expect(bad.exitCode, `retry=${retry}: ${bad.output}`).not.toBe(0);
      expect(bad.output).toContain('heading');
    }
    // A valid selector that matches nothing is still a successful scrape.
    const empty = await runCli('scrape', `${base}/`, `--schema=${noMatch}`, '--retry=0');
    const payload = JSON.parse(empty.output);
    expect(empty.exitCode, empty.output).toBe(0);
    expect(payload.extracted.heading).toBeNull();
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('solve-captcha token injection fails when no response field exists (issue 50)', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body><div class="cf-turnstile" data-sitekey="test-only">Local unresolved widget</div></body></html>');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
  try {
    await runCli('-s=issue50', 'open', `http://127.0.0.1:${address.port}/`);
    const result = await runCli('-s=issue50', 'solve-captcha', '--token=TEST_ONLY_DUMMY', '--timeout=0.1', '--json');
    const payload = JSON.parse(result.output);
    expect(result.exitCode, result.output).not.toBe(0);
    expect(payload.ok).toBe(false);
    expect(payload.result.solved).toBe(false);
    expect(payload.result.injected).toBe(false);
    expect(payload.error).toBeTruthy();
    await runCli('-s=issue50', 'close');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('goto on an HTTP 200 challenge is an unsuccessful outcome (issue 51)', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/challenge') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html><title>Just a moment</title><body>Checking your browser</body></html>');
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><title>Ready</title><body><h1>Ready</h1></body></html>');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await runCli('-s=issue51', 'open', `${base}/`);

    const normal = await runCli('-s=issue51', 'goto', `${base}/`, '--timeout=3', '--json');
    expect(normal.exitCode, normal.output).toBe(0);
    expect(JSON.parse(normal.output).ok).toBe(true);

    const blocked = await runCli('-s=issue51', 'goto', `${base}/challenge`, '--timeout=3', '--json');
    const payload = JSON.parse(blocked.output);
    expect(blocked.exitCode, blocked.output).not.toBe(0);
    expect(payload.ok).toBe(false);
    // HTTP 200 and the challenge detail stay available.
    expect(payload.result.status).toBe(200);
    expect(payload.result.challenge).toEqual({ type: 'cloudflare', blocked: true });

    const blockedText = await runCli('-s=issue51', 'goto', `${base}/challenge`, '--timeout=3');
    expect(blockedText.exitCode, `text mode: ${blockedText.output}`).not.toBe(0);
    await runCli('-s=issue51', 'close');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('scrape csv keeps text/html when an attribute shares the name (issue 42)', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body><h1 text="attribute text" html="attribute html">Actual heading</h1></body></html>');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
  try {
    const json = await runCli('scrape', `http://127.0.0.1:${address.port}/`, '--select=h1', '--retry=0');
    const selected = JSON.parse(json.output).selected[0];
    expect(selected.text).toBe('Actual heading');
    expect(selected.attrs).toEqual({ text: 'attribute text', html: 'attribute html' });

    const csv = await runCli('scrape', `http://127.0.0.1:${address.port}/`, '--select=h1', '--output-format=csv', '--retry=0');
    const [header, row] = csv.output.trim().split('\n');
    const columns = header.split(',');
    const values = row.split(',').reduce((acc, value, index) => ({ ...acc, [columns[index]]: value }), {});
    // The reserved fields survive; the colliding attributes are preserved too.
    expect(values.text).toBe('Actual heading');
    expect(values.html).toContain('Actual heading');
    expect(csv.output).toContain('attribute text');
    expect(csv.output).toContain('attribute html');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('install --skills installs this package skill, not the upstream one (issue 64)', async () => {
  const cwd = test.info().outputPath();
  const bundled = path.join(__dirname, '..', 'skills', 'playwright-cli', 'SKILL.md');
  const bundledText = fs.readFileSync(bundled, 'utf8').replace(/\r\n/g, '\n');

  for (const target of [
    { args: ['install', '--skills'], dir: path.join(cwd, '.claude', 'skills', 'playwright-cli') },
    { args: ['install', '--skills=agents'], dir: path.join(cwd, '.agents', 'skills', 'playwright-cli') },
  ]) {
    const installed = await runCliWithOptions({ cwd }, ...target.args);
    expect(installed.exitCode, installed.output).toBe(0);
    const text = fs.readFileSync(path.join(target.dir, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
    expect(text).toBe(bundledText);
    expect(text).toContain('playwright-cli fetch');
    expect(text).toContain('playwright-cli scrape');
    expect(fs.existsSync(path.join(target.dir, 'references'))).toBe(true);

    // A freshly installed skill must not be reported as stale.
    const help = await runCliWithOptions({ cwd }, '--help');
    expect(help.error).not.toContain('does not match the tool version');
  }
});
