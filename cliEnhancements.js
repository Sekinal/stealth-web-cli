/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

// @ts-check

const fs = require('fs');
const path = require('path');

const activeProviderEnvName = 'PLAYWRIGHT_CLI_ACTIVE_BROWSER_PROVIDER';
const providerMetadataSuffix = '.provider.json';

// Shared between the `fetch` help entry and the `fetch --help` short-circuit,
// which must print usage instead of dispatching a request (issue #47).
const FETCH_HELP = [
  'playwright-cli fetch <url>               make an HTTP request (engine: wreq by default, or via the browser)',
  '  --method=GET|POST|PUT|PATCH|DELETE|HEAD  HTTP method (default GET)',
  '  --data=<body>                            request body (POST/PUT/PATCH)',
  '  --header="Key: Value"                    request header (comma-separated)',
  '  --user=<name> --password=<secret>        basic authentication',
  '  --timeout=<seconds>                      request timeout (default: no timeout)',
  '  --retry=<N>                              retry up to N times on 5xx/network errors',
  '  --engine=wreq|httpcloak|browser          transport engine (default wreq; browser requires an open session)',
].join('\n');

// Secrets that must never reach stdout/stderr, generated code displays,
// errors, or persisted logs (issue #49). Values are registered at startup and
// when a solve-captcha invocation carries a key, then scrubbed centrally.
const redactionSecrets = new Set();

/**
 * @param {unknown} value
 */
function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 6)
    redactionSecrets.add(value);
}

/**
 * @param {string} text
 * @returns {string}
 */
function redactSecrets(text) {
  let result = text;
  for (const secret of redactionSecrets)
    result = result.split(secret).join('[REDACTED]');
  return result;
}

let secretRedactionInstalled = false;

/**
 * Wrap stdout/stderr once so any registered secret is scrubbed before it is
 * written, regardless of the output mode or code path.
 */
function installSecretRedaction() {
  if (secretRedactionInstalled)
    return;
  secretRedactionInstalled = true;
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    stream.write = function(/** @type {any} */ chunk, /** @type {any[]} */ ...rest) {
      if (typeof chunk === 'string' && redactionSecrets.size)
        chunk = redactSecrets(chunk);
      return original(chunk, ...rest);
    };
  }
}

/**
 * Adds the small amount of stealth-browser-specific behavior that cannot be
 * expressed through the upstream CLI configuration file.
 *
 * @param {{
 *   argv?: string[],
 *   command?: string,
 *   env?: NodeJS.ProcessEnv,
 *   providerConfig?: { enabled?: boolean },
 *   sessionModule: { Session: any },
 *   outputModule: { TextOutput: any, JsonOutput: any },
 *   help: any,
 *   stderr?: NodeJS.WriteStream,
 * }} options
 */
function configureCliEnhancements(options) {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const command = options.command ?? firstCommand(argv);
  const stderr = options.stderr ?? process.stderr;

  // Scrub secrets (CapSolver keys, proxy credentials) from every output path.
  registerSecret(env.CAPSOLVER_API_KEY);
  installSecretRedaction();

  extendHelp(options.help);
  patchSession(options.sessionModule.Session, {
    command,
    env,
    providerConfig: options.providerConfig,
    stderr,
  });
  patchOutput(options.outputModule, env);
}

/**
 * @param {any} help
 */
function extendHelp(help) {
  const goto = help.commands?.goto;
  if (goto) {
    goto.flags.timeout = 'string';
    goto.flags['wait-until'] = 'string';
    goto.flags['retry-empty'] = 'boolean';
    goto.flags['retry-empty-delay'] = 'string';
    goto.flags.retry = 'string';
    goto.flags['retry-delay'] = 'string';
    if (!goto.help.includes('--timeout'))
      goto.help += '\n  --timeout                   navigation timeout in seconds';
    if (!goto.help.includes('--wait-until'))
      goto.help += '\n  --wait-until                navigation wait strategy: load, domcontentloaded, networkidle, commit';
    if (!goto.help.includes('--retry'))
      goto.help += '\n  --retry=<N>                 retry up to N times on transient failures (timeout, abort, empty body, 4xx)';
    if (!goto.help.includes('--retry-delay'))
      goto.help += '\n  --retry-delay=<ms>          delay between retries (default 1500)';
  }

  const evaluate = help.commands?.eval;
  if (evaluate) {
    evaluate.flags.output = 'string';
    if (!evaluate.help.includes('--output'))
      evaluate.help += '\n  --output                    write the raw evaluation value to a file';
  }

  const snapshot = help.commands?.snapshot;
  if (snapshot) {
    snapshot.flags.inline = 'boolean';
    if (!snapshot.help.includes('--inline'))
      snapshot.help += '\n  --inline                    return the snapshot inline instead of writing a file';
  }

  const screenshot = help.commands?.screenshot;
  if (screenshot) {
    screenshot.flags.inline = 'boolean';
    if (!screenshot.help.includes('--inline'))
      screenshot.help += '\n  --inline                    return the screenshot as base64 PNG instead of writing a file';
  }
  if (!help.commands.fetch) {
    help.commands.fetch = {
      flags: { method: 'string', data: 'string', header: 'string', timeout: 'string', user: 'string', password: 'string', retry: 'string', engine: 'string' },
      args: ['url'],
      raw: true,
      help: FETCH_HELP,
    };
  }
  if (!help.commands['wait-for']) {
    help.commands['wait-for'] = {
      flags: { timeout: 'string' },
      args: ['selector'],
      help: [
        'playwright-cli wait-for <selector>      wait until an element matching a selector appears',
        '  --timeout=<seconds>                     timeout (default 5)',
      ].join('\n'),
    };
  }
  if (!help.commands['solve-captcha']) {
    help.commands['solve-captcha'] = {
      flags: { timeout: 'string', token: 'string', 'captcha-api-key': 'string' },
      args: [],
      help: [
        'playwright-cli solve-captcha             attempt to auto-solve the captcha on the page',
        '  --timeout=<seconds>                     max wait for auto-resolution (default 15)',
        '  --token=<token>                         inject a pre-solved token',
        '  --captcha-api-key=<key>                 solve via CapSolver (or CAPSOLVER_API_KEY env)',
      ].join('\n'),
    };
  }
  if (!help.commands.scrape) {
    help.commands.scrape = {
      flags: {
        crawl: 'boolean', 'max-requests': 'string', 'max-depth': 'string', 'same-origin': 'boolean',
        concurrency: 'string', 'requests-per-minute': 'string', select: 'string', schema: 'string',
        'output-format': 'string', output: 'string', timeout: 'string', retry: 'string',
      },
      args: ['url'],
      help: [
        'playwright-cli scrape <url>               scrape rendered content on stdout or --output=<file>',
        '  --crawl                                 crawl the site following same-origin links',
        '  --max-requests=<N>                      max pages (default 1, or 20 with --crawl)',
        '  --max-depth=<N>                         max link depth to follow with --crawl',
        '  --same-origin=true|false                only follow same-origin links (default true)',
        '  --concurrency=<N>                       parallel pages (default 1)',
        '  --requests-per-minute=<N>               rate-limit requests per minute (default: none)',
        '  --select=<css>                          extract elements matching a selector',
        '  --schema=<json-file>                    extract fields: { field: { selector, attr?, all? } }',
        '  --output-format=json|text|markdown|csv  output format (default json)',
        '  --output=<file>                         write output to a file instead of stdout',
        '  --timeout=<seconds>                     per-page request timeout (default 60)',
        '  --retry=<N>                             retries with backoff on 5xx/empty/challenge (default 3)',
      ].join('\n'),
    };
  }
}

/**
 * @param {any} Session
 * @param {{
 *   command?: string,
 *   env: NodeJS.ProcessEnv,
 *   providerConfig?: { enabled?: boolean },
 *   stderr: NodeJS.WriteStream,
 * }} options
 */
function patchSession(Session, options) {
  if (!Session || Session.__stealthCliEnhancements)
    return;
  Session.__stealthCliEnhancements = true;

  const originalStartDaemon = Session.startDaemon;
  /** @type {(clientInfo: any, cliArgs: any, mode?: any) => Promise<any>} */
  Session.startDaemon = async function(clientInfo, _cliArgs, _mode) {
    const result = await originalStartDaemon.apply(this, arguments);
    const provider = options.env[activeProviderEnvName];
    if (provider) {
      writeProviderMetadata(clientInfo.daemonProfilesDir, result.sessionName, {
        provider,
        version: providerVersion(provider),
      });
    }
    return result;
  };

  const originalCanConnect = Session.prototype.canConnect;
  Session.prototype.canConnect = async function() {
    const canConnect = await originalCanConnect.apply(this, arguments);
    if (canConnect) {
      const metadata = readProviderMetadata(this._sessionFile?.daemonDir, this.name);
      const provider = metadata ? { name: metadata.provider, version: metadata.version } : inferProviderDetails(this.config);
      this.__stealthProviderDetails = provider;
      if (provider?.name && this.config?.browser) {
        this.config.browser.launchOptions ??= {};
        this.config.browser.launchOptions.channel = provider.name;
      }
    }
    return canConnect;
  };

  if (options.command === 'open' && options.providerConfig?.enabled) {
    const originalStop = Session.prototype.stop;
    let reportedReevaluation = false;
    Session.prototype.stop = async function() {
      if (!reportedReevaluation && await originalCanConnect.call(this)) {
        reportedReevaluation = true;
        const metadata = readProviderMetadata(this._sessionFile?.daemonDir, this.name);
        const active = metadata?.provider ? ` currently using '${metadata.provider}'` : '';
        options.stderr.write(`[playwright-cli] Session '${this.name}' is already running${active}; restarting it to re-apply the CloakBrowser configuration.\n`);
      }
      return await originalStop.apply(this, arguments);
    };
  }

  const originalRun = Session.prototype.run;
  /** @type {(this: any, clientInfo: any, args: any, runOptions: any) => Promise<any>} */
  Session.prototype.run = async function(clientInfo, args, runOptions) {
    const evalOutputPath = resolveEvalOutputPath(args);
    const preparedArgs = prepareCommandArgs(args);
    // Non-browser fetch engines (wreq/httpcloak) run entirely in Node and
    // never require an open browser session.
    if (preparedArgs._?.[0] === 'engine-fetch' && preparedArgs._engineRequest && preparedArgs._engineRequest.engine !== 'browser') {
      return await emitEngineFetchResult(preparedArgs._engineRequest, this, options, runOptions);
    }
    try {
      let result = await originalRun.call(this, clientInfo, preparedArgs, runOptions);
      if (result.isError)
        process.exitCode = 1;
      if (!result.isError && args._?.[0] === 'fetch') {
        const parsed = normalizeUpstreamResult(parseJsonText(result.text));
        const fetched = typeof parsed === 'object' ? parsed : parseJsonText(parseUpstreamSections(result.text).get('Result'));
        if (fetched && typeof fetched === 'object' && 'body' in fetched && 'status' in fetched) {
          const challenge = detectChallengeFromText(null, typeof fetched.body === 'string' ? fetched.body : '', typeof fetched.status === 'number' ? fetched.status : null);
          if (challenge.blocked)
            process.exitCode = 1;
        }
      }
      if (!result.isError && args._?.[0] === 'wait-for') {
        // A wait that times out or receives a malformed selector is a command
        // failure, not a successful presence probe (issue #70). Text mode only
        // needs the exit code; the JSON branch below reports ok:false.
        const parsed = normalizeUpstreamResult(parseJsonText(result.text));
        const waited = typeof parsed === 'object' ? parsed : parseJsonText(parseUpstreamSections(result.text).get('Result'));
        if (waited && typeof waited === 'object' && waited.found !== true)
          process.exitCode = 1;
      }
      if (!result.isError && evalOutputPath) {
        rewriteEvalOutput(evalOutputPath);
        result = { ...result, text: absoluteEvalOutputLink(result.text, evalOutputPath) };
      }
      if (!result.isError && runOptions?.raw) {
        const cmd = args._?.[0];
        try {
          const parsed = JSON.parse(result.text);
          if (cmd === 'fetch' && parsed && typeof parsed.body === 'string')
            result = { ...result, text: parsed.body };
          else if (cmd === 'eval' && typeof parsed === 'string')
            result = { ...result, text: parsed };
        } catch {}
      }
      if (!runOptions?.json) {
        // Text mode: warn when goto landed on a different host than requested
        // (issue #8 Bug 2) — --json already reports `redirected`.
        if (args._?.[0] === 'goto' && !result.isError && !runOptions?.raw) {
          try {
            const sections = parseUpstreamSections(result.text);
            const resultJson = sections.get('Result');
            if (resultJson) {
              const parsed = JSON.parse(resultJson);
              if (parsed?.redirected && typeof parsed.url === 'string') {
                const requested = typeof args._?.[1] === 'string' ? args._[1] : '';
                console.error(`[playwright-cli] Warning: goto landed on a different host than requested. Requested: ${hostOfUrl(requested) || requested}; final URL: ${parsed.url}`);
              }
            }
          } catch {}
        }
        return result;
      }

      const upstreamPayload = parseJsonText(result.text);
      if (result.isError || upstreamPayload?.isError) {
        process.exitCode = 1;
        const payload = failurePayload(
            upstreamPayload?.error ?? result.text,
            undefined,
            [],
            providerDetailsForSession(this, options.env));
        return { ...result, text: JSON.stringify(payload, null, 2) };
      }

      const [page, consoleEntries] = await readSessionContext(originalRun, this, clientInfo);
      /** @type {Record<string, any>} */
      const normalizedResult = /** @type {Record<string, any>} */ (normalizeCommandResult(args._?.[0], normalizeUpstreamResult(upstreamPayload)));
      const cmd = args._?.[0];
      if (cmd === 'fetch' && normalizedResult && typeof normalizedResult === 'object' && !Array.isArray(normalizedResult)) {
        const fetchChallenge = detectChallengeFromText(null, typeof normalizedResult.body === 'string' ? normalizedResult.body : '', typeof normalizedResult.status === 'number' ? normalizedResult.status : null);
        if (fetchChallenge.blocked) {
          normalizedResult.challenge = fetchChallenge;
          normalizedResult.failed = true;
        }
      }
      if (cmd === 'wait-for' && normalizedResult && !Array.isArray(normalizedResult) && normalizedResult.found !== true) {
        process.exitCode = 1;
        const payload = {
          ...successPayload(page, null, consoleEntries, providerDetailsForSession(this, options.env), proxyDetails(options.env)),
          ok: false,
          result: normalizedResult,
          error: normalizedResult.error ?? `wait-for did not find '${normalizedResult.selector}' within the timeout`,
        };
        return { ...result, text: JSON.stringify(payload, null, 2) };
      }
      if ((cmd === 'fetch' || cmd === 'goto') && normalizedResult && !Array.isArray(normalizedResult) && typeof normalizedResult === 'object' && normalizedResult.failed) {
        process.exitCode = 1;
        const payload = {
          ...successPayload(page, null, consoleEntries, providerDetailsForSession(this, options.env), proxyDetails(options.env)),
          ok: false,
          result: normalizedResult,
          error: normalizedResult.status < 400 && normalizedResult.challenge?.blocked
            ? `Blocked by ${normalizedResult.challenge.type} challenge`
            : `HTTP ${normalizedResult.status} ${normalizedResult.statusText ?? ''}`.trim(),
        };
        return { ...result, text: JSON.stringify(payload, null, 2) };
      }
      const payload = successPayload(
          page,
          normalizedResult,
          consoleEntries,
          providerDetailsForSession(this, options.env),
          proxyDetails(options.env));
      return { ...result, text: JSON.stringify(payload, null, 2) };
    } catch (error) {
      if (runOptions?.json) {
        const [page, consoleEntries] = await readSessionContext(originalRun, this, clientInfo);
        if (error && typeof error === 'object') {
          const taggedError = /** @type {Record<string, any>} */ (error);
          taggedError.cliJson = failurePayload(
              error,
              page,
              consoleEntries,
              providerDetailsForSession(this, options.env));
        }
      }
      throw error;
    }
  };
}

/**
 * @param {{ TextOutput: any, JsonOutput: any }} outputModule
 * @param {NodeJS.ProcessEnv} env
 */
function patchOutput(outputModule, env) {
  const TextOutput = outputModule.TextOutput;
  if (TextOutput && !TextOutput.__stealthCliEnhancements) {
    const originalOpen = TextOutput.prototype.open;
    /** @type {(this: any, session: any, pid: any, toolResult: any) => void} */
    TextOutput.prototype.open = function(_session, _pid, _toolResult) {
      originalOpen.apply(this, arguments);
      const provider = providerDetails(env);
      if (provider)
        console.log(`### Browser provider\n- name: ${provider.name}\n- version: ${provider.version}`);
    };
  }

  const JsonOutput = outputModule.JsonOutput;
  if (JsonOutput && !JsonOutput.__stealthCliEnhancements) {
    const originalEmit = JsonOutput.prototype._emit;
    /** @type {(this: any, value: any) => any} */
    JsonOutput.prototype._emit = function(value) {
      let payload;
      if (value?.result?.ok !== undefined && value.session) {
        payload = {
          ...value.result,
          provider: value.result.provider ?? providerDetails(env) ?? null,
          session: value.session,
          pid: value.pid,
        };
      } else if (value?.ok !== undefined) {
        payload = {
          ...value,
          provider: value.provider ?? providerDetails(env) ?? null,
        };
      } else if (value?.isError) {
        payload = failurePayload(value.error, undefined, [], providerDetails(env));
      } else {
        payload = successPayload(undefined, value, [], providerDetails(env), proxyDetails(env));
      }
      return originalEmit.call(this, payload);
    };
  }
}

/**
 * @param {any} args
 */
function prepareCommandArgs(args) {
  const prepared = { ...args, _: [...(args?._ ?? [])] };
  const command = prepared._[0];

  if (command === 'eval' && prepared.output !== undefined) {
    if (prepared.filename !== undefined && prepared.filename !== prepared.output)
      throw new Error('Only one of --filename and --output may be specified.');
    prepared.filename = prepared.output;
    delete prepared.output;
  }

  if (command === 'snapshot' && prepared.inline) {
    if (prepared.filename !== undefined)
      throw new Error('Only one of --filename and --inline may be specified.');
    delete prepared.inline;
  }

  if (command === 'screenshot' && prepared.inline) {
    if (prepared.filename !== undefined)
      throw new Error('Only one of --filename and --inline may be specified.');
    const target = prepared._[1];
    const fullPage = prepared['full-page'] === true;
    delete prepared.inline;
    delete prepared['full-page'];
    prepared._ = ['run-code', `async (page) => {
  const buf = ${target !== undefined
    ? `await page.locator(${JSON.stringify(target)}).screenshot()`
    : `await page.screenshot({ ${fullPage ? 'fullPage: true' : ''} })`};
  return { screenshot: buf.toString('base64'), mimeType: 'image/png' };
}`];
  }
  if (command === 'goto') {
    const hasTimeout = prepared.timeout !== undefined;
    const hasWaitUntil = prepared['wait-until'] !== undefined;
    const retryEmpty = prepared['retry-empty'] === true;
    const retryCount = prepared.retry !== undefined ? Math.max(0, parseInt(prepared.retry, 10) || 0) : 0;
    const retryDelayMs = prepared['retry-delay'] !== undefined ? parseDelayMs(prepared['retry-delay'])
        : prepared['retry-empty-delay'] !== undefined ? parseDelayMs(prepared['retry-empty-delay']) : 1500;
    if (hasTimeout || hasWaitUntil || retryEmpty || retryCount > 0) {
      const url = prepared._[1];
      if (typeof url !== 'string' || !url)
        throw new Error('goto requires a URL (for example, goto https://example.com --timeout=5).');
      // Enhanced navigation must preserve the same protocol policy as plain
      // goto; --timeout/--retry must not bypass the file: restriction (issue #58).
      if (!process.env.PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS || process.env.PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS === 'false') {
        try {
          if (new URL(url).protocol === 'file:')
            throw new Error(`Access to "file:" protocol is blocked. Attempted URL: "${url}"`);
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('Access to "file:"'))
            throw error;
        }
      }
      const timeoutMs = hasTimeout ? parseTimeoutMs(prepared.timeout) : 60000;
      const waitUntil = hasWaitUntil ? prepared['wait-until'] : 'domcontentloaded';
      if (hasWaitUntil && !['load', 'domcontentloaded', 'networkidle', 'commit'].includes(waitUntil))
        throw new Error(`Invalid --wait-until value '${waitUntil}'. Expected one of: load, domcontentloaded, networkidle, commit.`);
      delete prepared.timeout;
      delete prepared['wait-until'];
      delete prepared['retry-empty'];
      delete prepared['retry-empty-delay'];
      delete prepared.retry;
      delete prepared['retry-delay'];
      prepared._ = ['run-code', `async (page) => {
  const detectChallenge = async (status, title) => {
    const dom = await page.evaluate(() => {
      const has = (sel) => !!document.querySelector(sel);
      return {
        turnstile: has('iframe[src*="challenges.cloudflare.com"], .cf-turnstile, [data-turnstile-widget]'),
        recaptcha: has('iframe[src*="recaptcha/api"], iframe[src*="google.com/recaptcha"], iframe[src*="recaptcha.net"], .g-recaptcha, [class*="g-recaptcha"]'),
        hcaptcha: has('iframe[src*="hcaptcha.com"], iframe[src*="hcaptcha.net"], .h-captcha, [data-hcaptcha-widget-id]'),
      };
    }).catch(() => ({ turnstile: false, recaptcha: false, hcaptcha: false }));
    if (dom.turnstile) return { type: 'turnstile', blocked: true };
    if (dom.recaptcha) return { type: 'recaptcha', blocked: true };
    if (dom.hcaptcha) return { type: 'hcaptcha', blocked: true };
    const text = (title || '') + ' ' + (await page.evaluate(() => document.body ? document.body.innerText.slice(0, 2000) : '').catch(() => ''));
    const lower = text.toLowerCase();
    if (status === 403)
      return { type: '403', blocked: true };
    if (status === 429)
      return { type: 'rate-limit', blocked: true };
    if (lower.includes('just a moment') || lower.includes('checking your browser') || lower.includes('enable javascript'))
      return { type: 'cloudflare', blocked: true };
    if (lower.includes('performing security verification') || lower.includes('ray id'))
      return { type: 'cloudflare', blocked: true };
    if (lower.includes('please enable js and disable any ad blocker') || lower.includes('datadome'))
      return { type: 'datadome', blocked: true };
    if (lower.includes('access denied') || lower.includes('you have been blocked') || lower.includes('your access has been') || lower.includes("you don't have permission"))
      return { type: 'blocked', blocked: true };
    if (lower.includes('select all squares') || lower.includes('i am not a robot') || lower.includes('verify you are human') || lower.includes('prove you are human') || lower.includes('complete the security check'))
      return { type: 'captcha', blocked: true };
    return { type: 'none', blocked: false };
  };
  const requestedUrl = ${JSON.stringify(url)};
  const hostOf = (u) => { const m = u.match(/^[a-z][a-z0-9+.-]*:\\/\\/([^\\/?#]*)/i); return m ? m[1].toLowerCase() : u; };
  const maxAttempts = ${retryCount} + 1;
  let response = null;
  let lastError = null;
  let bodyLength = 0;
  let attempts = 0;
  for (let i = 0; i < maxAttempts; i++) {
    attempts = i + 1;
    try {
      response = await page.goto(requestedUrl, { waitUntil: '${waitUntil}', timeout: ${timeoutMs} });
      bodyLength = await page.evaluate(() => document.body ? document.body.innerText.length : 0);
      lastError = null;
    } catch (e) {
      lastError = e;
      bodyLength = 0;
    }
    const statusNow = response ? response.status() : null;
    const retryOnEmpty = (${retryEmpty} || ${retryCount} > 0) && bodyLength === 0;
    const retryOnError = ${retryCount} > 0 && lastError !== null;
    const retryOnStatus = ${retryCount} > 0 && statusNow !== null && statusNow >= 400 && statusNow !== 404;
    const shouldRetry = i < maxAttempts - 1 && (retryOnEmpty || retryOnError || retryOnStatus);
    if (!shouldRetry)
      break;
    await page.waitForTimeout(${retryDelayMs});
  }
  if (lastError)
    throw lastError;
  const finalUrl = page.url();
  const redirected = hostOf(requestedUrl) !== hostOf(finalUrl);
  const title = await page.title();
  const status = response ? response.status() : null;
  const challenge = await detectChallenge(status, title);
  return {
    navigation: 'succeeded',
    url: finalUrl,
    title,
    status,
    redirected,
    challenge,
    bodyLength,
    emptyBody: bodyLength === 0,
    attempts,
    retried: attempts > 1,
    failed: status !== null && status >= 400,
  };
}`];
    }
  }

  if (command === 'fetch') {
    const url = prepared._[1];
    if (typeof url !== 'string' || !url)
      throw new Error('fetch requires a URL (for example, fetch https://api.example.com/data).');
    if (!/^(https?|data|about|blob):/i.test(url))
      throw new Error(`Invalid URL '${url}': missing protocol. Use http://, https://, data:, about:, or blob:.`);
    const method = (prepared.method ?? 'GET').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method))
      throw new Error(`Unsupported fetch method '${prepared.method}'. Expected one of: GET, POST, PUT, PATCH, DELETE, HEAD.`);
    const forcedBrowser = process.env.PLAYWRIGHT_CLI_FORCE_BROWSER_FETCH === '1';
    delete process.env.PLAYWRIGHT_CLI_FORCE_BROWSER_FETCH;
    const engineRaw = typeof prepared.engine === 'string' ? prepared.engine.toLowerCase() : '';
    const engine = forcedBrowser ? 'browser' : (engineRaw === undefined || engineRaw === '' ? 'wreq' : engineRaw);
    // Plain engines (node-wreq/httpcloak) have no data:/about:/blob: transport;
    // the browser run-code handles those schemes natively.
    const resolvedEngine = /^(data|about|blob):/i.test(url) ? 'browser' : engine;
    if (!['wreq', 'httpcloak', 'browser'].includes(resolvedEngine))
      throw new Error(`Unsupported --engine '${prepared.engine}'. Expected one of: wreq, httpcloak, browser.`);
    const data = prepared.data;
    const headerArg = prepared.header;
    const timeoutMs = prepared.timeout !== undefined ? parseTimeoutMs(prepared.timeout) : undefined;
    const retryCount = prepared.retry !== undefined ? Math.max(0, parseInt(prepared.retry, 10) || 0) : 0;
    // Basic auth: build the Authorization header here (Node has Buffer) rather
    // than in the sandbox, which lacks Node globals.
    let authHeader = null;
    if (prepared.user !== undefined || prepared.password !== undefined) {
      const creds = Buffer.from(`${prepared.user ?? ''}:${prepared.password ?? ''}`).toString('base64');
      authHeader = `Authorization: Basic ${creds}`;
    }
    delete prepared.method;
    delete prepared.data;
    delete prepared.header;
    delete prepared.timeout;
    delete prepared.retry;
    delete prepared.user;
    delete prepared.password;
    delete prepared.engine;
    const mergedHeaders = {
      ...(headerArg !== undefined ? parseHeaderArg(headerArg) : {}),
      ...(authHeader ? parseHeaderArg(authHeader) : {}),
    };
    // Consistent body defaults across transports: a body without an explicit
    // Content-Type must not change semantics when the engine changes (issue #69).
    // The browser's in-page fetch would otherwise label it text/plain and the
    // HTTP engines would send none, turning accepted JSON into HTTP 415.
    if (data !== undefined && !Object.keys(mergedHeaders).some(name => name.toLowerCase() === 'content-type'))
      mergedHeaders['Content-Type'] = 'application/json';
    const maxAttempts = retryCount + 1;

    // Non-browser engines run in Node before the daemon is ever contacted;
    // stash the request spec for the run-wrapper to dispatch.
    if (resolvedEngine !== 'browser') {
      prepared._ = ['engine-fetch'];
      prepared._engineRequest = {
        engine: resolvedEngine,
        url,
        method,
        data,
        headers: mergedHeaders,
        timeoutMs,
        retryCount,
        maxAttempts,
      };
      return prepared;
    }

    prepared._ = ['run-code', `async (page) => {
  const startedAt = Date.now();
  const url = ${JSON.stringify(url)};
  const isSpecialScheme = /^(data|about|blob):/.test(url);
  if (isSpecialScheme) {
    const res = await page.evaluate(async (u) => {
      const r = await fetch(u);
      return { status: r.status, statusText: r.statusText, headers: Object.fromEntries(r.headers.entries()), body: await r.text() };
    }, url);
    return { ...res, url, redirected: false, failed: res.status >= 400, engine: 'browser' };
  }
  let response = null;
  let lastError = null;
  let attempts = 0;
  for (let i = 0; i < ${maxAttempts}; i++) {
    attempts = i + 1;
    try {
      // In-page fetch: the request rides CloakBrowser's own network stack
      // (BoringSSL + Chrome h2), not the Node-side APIRequestContext.
      response = await page.evaluate(async ({ url, method, data, headers, timeoutMs }) => {
        const res = await fetch(url, {
          method,
          ...(data !== undefined ? { body: data } : {}),
          ...(headers && Object.keys(headers).length ? { headers } : {}),
          ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
        });
        const responseHeaders = Object.fromEntries(res.headers.entries());
        const contentType = responseHeaders['content-type'] || '';
        const isBinary = /octet-stream|image\\/|application\\/pdf|application\\/zip|application\\/gzip|audio\\/|video\\/|font\\//.test(contentType);
        // Binary bodies must be read as bytes and encoded losslessly: text()
        // UTF-8 decodes and mangles them (issue #21).
        let body;
        if (isBinary) {
          const bytes = new Uint8Array(await res.arrayBuffer());
          let latin = '';
          const chunk = 0x8000;
          for (let i = 0; i < bytes.length; i += chunk)
            latin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
          body = btoa(latin);
        } else {
          body = await res.text();
        }
        return {
          status: res.status,
          statusText: res.statusText,
          url: res.url,
          headers: responseHeaders,
          body,
          binary: isBinary,
          redirected: res.redirected,
        };
      }, { url, method: ${JSON.stringify(method)}, data: ${JSON.stringify(data)}, headers: ${JSON.stringify(mergedHeaders)}, timeoutMs: ${timeoutMs ?? 'null'} });
      lastError = null;
    } catch (e) {
      lastError = e;
    }
    const statusNow = response ? response.status : null;
    const shouldRetry = ${retryCount} > 0 && i < ${maxAttempts} - 1 && (lastError !== null || (statusNow !== null && statusNow >= 500));
    if (!shouldRetry)
      break;
    await page.waitForTimeout(1500);
  }
  if (lastError && !response)
    throw lastError;
  const status = response.status;
  const finalUrl = response.url;
  const redirected = response.redirected;
  const headers = response.headers;
  const body = response.body;
  const binary = response.binary === true;
  let json = null;
  if (!binary) { try { json = JSON.parse(body); } catch (_) {} }
  return {
    status,
    statusText: response.statusText,
    url: finalUrl,
    redirected,
    headers,
    body,
    binary,
    json,
    attempts,
    retried: attempts > 1,
    durationMs: Date.now() - startedAt,
    engine: 'browser',
    failed: status >= 400,
  };
}`];
  }

  if (command === 'wait-for') {
    const selector = prepared._[1];
    if (typeof selector !== 'string' || !selector)
      throw new Error('wait-for requires a selector (for example, wait-for "text=Submit" or "#main").');
    const timeoutMs = prepared.timeout !== undefined ? parseTimeoutMs(prepared.timeout) : 5000;
    delete prepared.timeout;
    prepared._ = ['run-code', `async (page) => {
  const target = ${JSON.stringify(selector)};
  try {
    const element = await page.waitForSelector(target, { timeout: ${timeoutMs} });
    return {
      found: true,
      selector: target,
      text: await element.textContent().catch(() => null),
    };
  } catch (e) {
    return { found: false, selector: target, error: e.message };
  }
}`];
  }

  if (command === 'solve-captcha') {
    const timeoutMs = prepared.timeout !== undefined ? parseTimeoutMs(prepared.timeout) : 15000;
    const injectToken = prepared.token;
    const apiKey = prepared['captcha-api-key'] ?? process.env.CAPSOLVER_API_KEY;
    const useSolver = typeof apiKey === 'string' && apiKey.length > 0;
    registerSecret(apiKey);
    delete prepared.timeout;
    delete prepared.token;
    delete prepared['captcha-api-key'];
    prepared._ = ['run-code', `async (page) => {
  const detect = await page.evaluate(() => {
    const q = (sel) => !!document.querySelector(sel);
    const holdButton = [...document.querySelectorAll('button, [role="button"]')].some(el => /hold|press/i.test(el.textContent || ''));
    return {
      turnstile: q('.cf-turnstile, [data-turnstile-widget], iframe[src*="challenges.cloudflare.com"]'),
      recaptcha: q('.g-recaptcha, iframe[src*="recaptcha/api"], iframe[src*="google.com/recaptcha"], iframe[src*="recaptcha.net"], iframe[title*="reCAPTCHA"]'),
      hcaptcha: q('.h-captcha, iframe[src*="hcaptcha.com"], iframe[src*="hcaptcha.net"], [data-hcaptcha-widget-id]'),
      hold: holdButton,
    };
  });
  const type = detect.turnstile ? 'turnstile' : detect.recaptcha ? 'recaptcha' : detect.hcaptcha ? 'hcaptcha' : detect.hold ? 'hold' : 'none';
  if (type === 'none')
    return { captcha: 'none', solved: false, error: 'no captcha widget detected on the page' };
  const tokenSelector = type === 'turnstile' ? '[name="cf-turnstile-response"]'
    : type === 'recaptcha' ? '[name="g-recaptcha-response"], textarea[name="g-recaptcha-response"]'
    : type === 'hcaptcha' ? '[name="h-captcha-response"], textarea[name="h-captcha-response"]'
    : '[name*="verification"], [name*="human"], input[type="hidden"][name*="verify"]';
  const inject = ${JSON.stringify(injectToken ?? null)};
  if (inject) {
    await page.evaluate((args) => {
      const el = document.querySelector(args.sel);
      if (el) { el.value = args.token; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
    }, { sel: tokenSelector, token: inject });
    return { captcha: type, solved: true, injected: true };
  }
  const solverKey = ${JSON.stringify(useSolver ? apiKey : null)};
  const solverUrl = ${JSON.stringify(process.env.CAPSOLVER_API_URL || 'https://api.capsolver.com')};
  if (solverKey) {
    const sitekey = await page.evaluate(() => {
      const el = document.querySelector('[data-sitekey], .cf-turnstile, .g-recaptcha, .h-captcha');
      if (el && el.getAttribute('data-sitekey'))
        return el.getAttribute('data-sitekey');
      const iframe = document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="recaptcha/api"], iframe[src*="google.com/recaptcha"], iframe[src*="recaptcha.net"]');
      if (iframe) {
        const m = (iframe.src || '').match(/[?&]k=([^&]+)/);
        if (m) return m[1];
      }
      return null;
    });
    if (!sitekey)
      return { captcha: type, solved: false, error: 'could not extract the captcha sitekey' };
    const taskType = type === 'turnstile' ? 'AntiTurnstileTaskProxyLess'
      : type === 'recaptcha' ? 'ReCaptchaV2TaskProxyLess'
      : 'HCaptchaTaskProxyLess';
    try {
      const createResp = await page.request.post(solverUrl + '/createTask', {
        data: { clientKey: solverKey, task: { type: taskType, websiteURL: page.url(), websiteKey: sitekey } },
      });
      const createJson = await createResp.json();
      if (createJson.errorId !== 0)
        return { captcha: type, solved: false, solver: 'capsolver', error: createJson.errorDescription || createJson.errorCode };
      const taskId = createJson.taskId;
      for (let i = 0; i < 40; i++) {
        const resResp = await page.request.post(solverUrl + '/getTaskResult', {
          data: { clientKey: solverKey, taskId },
        });
        const resJson = await resResp.json();
        if (resJson.errorId !== 0)
          return { captcha: type, solved: false, solver: 'capsolver', error: resJson.errorDescription || resJson.errorCode };
        if (resJson.status === 'ready') {
          const token = resJson.solution?.token || resJson.solution?.gRecaptchaResponse;
          if (token) {
            await page.evaluate((args) => {
              const el = document.querySelector(args.sel);
              if (el) { el.value = args.token; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
            }, { sel: tokenSelector, token });
            return { captcha: type, solved: true, solver: 'capsolver', token };
          }
        }
        await page.waitForTimeout(3000);
      }
      return { captcha: type, solved: false, solver: 'capsolver', error: 'CapSolver timed out waiting for the task result' };
    } catch (e) {
      return { captcha: type, solved: false, solver: 'capsolver', error: e.message };
    }
  }
  if (type === 'turnstile') {
    try {
      const frame = page.frameLocator('iframe[src*="challenges.cloudflare.com"]').first();
      await frame.locator('input[type="checkbox"], [role="checkbox"], .chakra-checkbox, label').first().click({ timeout: 3000 });
    } catch {}
  }
  if (type === 'recaptcha') {
    try {
      const frame = page.frameLocator('iframe[src*="recaptcha/api"], iframe[src*="google.com/recaptcha"], iframe[src*="recaptcha.net"]').first();
      await frame.locator('.recaptcha-checkbox, [role="checkbox"]').first().click({ timeout: 3000 });
    } catch {}
  }
  if (type === 'hcaptcha') {
    try {
      const frame = page.frameLocator('iframe[src*="hcaptcha.com"], iframe[src*="hcaptcha.net"]').first();
      await frame.locator('.checkbox, [role="checkbox"], input[type="checkbox"]').first().click({ timeout: 3000 });
    } catch {}
  }
  try {
    const holdButton = page.locator('button:has-text("hold"), button:has-text("press"), [role="button"]:has-text("hold"), [role="button"]:has-text("press")').first();
    const box = await holdButton.boundingBox({ timeout: 1000 }).catch(() => null);
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(5000);
      await page.mouse.up();
    }
  } catch {}
  const deadline = Date.now() + ${timeoutMs};
  while (Date.now() < deadline) {
    const token = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el && el.value ? el.value : '';
    }, tokenSelector);
    if (token)
      return { captcha: type, solved: true, token };
    await page.waitForTimeout(500);
  }
  return { captcha: type, solved: false, error: 'timed out waiting for the captcha to resolve' };
}`];
  }

  return prepared;
}

/**
 * @param {any} args
 */
function resolveEvalOutputPath(args) {
  if (args?._?.[0] !== 'eval' || typeof args.output !== 'string' || !args.output)
    return undefined;
  return path.resolve(process.cwd(), args.output);
}

/**
 * Upstream intentionally stores evaluation results as JSON. `--output` is the
 * stealth CLI's raw-value variant: strings are written literally, while other
 * JSON-compatible values retain their readable JSON representation.
 *
 * @param {string} outputPath
 */
function rewriteEvalOutput(outputPath) {
  const serialized = fs.readFileSync(outputPath, 'utf8');
  let value;
  try {
    value = JSON.parse(serialized);
  } catch {
    return;
  }
  const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value);
  fs.writeFileSync(outputPath, raw, 'utf8');
}

/**
 * @param {unknown} text
 * @param {string} outputPath
 */
function absoluteEvalOutputLink(text, outputPath) {
  if (typeof text !== 'string')
    return text;
  const link = `- [Evaluation result](${outputPath})`;
  const payload = parseJsonText(text);
  if (payload && typeof payload === 'object' && typeof payload.result === 'string')
    return JSON.stringify({ ...payload, result: link });
  return text.replace(/- \[Evaluation result\]\([^\r\n]*\)/, link);
}

/**
 * @param {string | number} value
 */
function parseTimeoutMs(value) {
  const input = String(value).trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)(ms|s)?$/.exec(input);
  if (!match)
    throw new Error(`Invalid navigation timeout '${value}'. Use seconds (for example, --timeout=5).`);
  const amount = Number(match[1]);
  // Round before validating: Playwright treats `timeout: 0` as "no timeout", so a
  // sub-millisecond value must be rejected rather than rounded into an infinite wait.
  const timeoutMs = Math.round(match[2] === 'ms' ? amount : amount * 1000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error(`Navigation timeout '${value}' is too small; use at least 1ms (for example, --timeout=5).`);
  return timeoutMs;
}

/**
 * Parse a retry delay. The documented unit for retry delays is milliseconds, so
 * a bare number means ms (`2` -> 2ms) while an explicit suffix still works
 * (`2s` -> 2000ms, `2ms` -> 2ms). Issue #71.
 * @param {string | number} value
 * @returns {number}
 */
function parseDelayMs(value) {
  const input = String(value).trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)(ms|s)?$/.exec(input);
  if (!match)
    throw new Error(`Invalid retry delay '${value}'. Use milliseconds (for example, --retry-delay=1500) or an 's'/'ms' suffix.`);
  const amount = Number(match[1]);
  const delayMs = Math.round(match[2] === 's' ? amount * 1000 : amount);
  if (!Number.isFinite(delayMs) || delayMs < 0)
    throw new Error(`Invalid retry delay '${value}'.`);
  return delayMs;
}

/**
 * Every `--json` invocation needs both the page metadata and the console buffer.
 * The two reads are independent, so issue them together instead of paying two
 * sequential daemon round-trips on top of the caller's own command. Both helpers
 * swallow their own failures, so this never rejects.
 *
 * @param {Function} originalRun
 * @param {any} session
 * @param {any} clientInfo
 * @returns {Promise<[{ url: string | null, title: string | null } | undefined, string[]]>}
 */
function readSessionContext(originalRun, session, clientInfo) {
  return Promise.all([
    readPageMetadata(originalRun, session, clientInfo),
    readConsoleEntries(originalRun, session, clientInfo),
  ]);
}

/**
 * @param {Function} originalRun
 * @param {any} session
 * @param {any} clientInfo
 * @returns {Promise<{ url: string | null, title: string | null, bodyLength: number | null,
 *   emptyBody: boolean, webdriver: boolean,
 *   challenge?: { type: string, blocked: boolean } } | undefined>}
 */
async function readPageMetadata(originalRun, session, clientInfo) {
  try {
    const response = await originalRun.call(session, clientInfo, {
      _: ['eval', `() => {
        const has = (sel) => !!document.querySelector(sel);
        const captcha = {
          turnstile: has('iframe[src*="challenges.cloudflare.com"], .cf-turnstile, [data-turnstile-widget]'),
          recaptcha: has('iframe[src*="recaptcha/api"], iframe[src*="google.com/recaptcha"], iframe[src*="recaptcha.net"], .g-recaptcha, [class*="g-recaptcha"]'),
          hcaptcha: has('iframe[src*="hcaptcha.com"], iframe[src*="hcaptcha.net"], .h-captcha, [data-hcaptcha-widget-id]'),
        };
        return {
          url: location.href,
          title: document.title,
          bodyLength: document.body ? document.body.innerText.length : 0,
          bodyText: document.body ? document.body.innerText.slice(0, 2000) : '',
          webdriver: navigator.webdriver,
          captcha,
        };
      }`],
    }, { json: true, raw: false });
    const payload = normalizeUpstreamResult(parseJsonText(response.text));
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const record = /** @type {Record<string, any>} */ (payload);
      const title = stringOrNull(record.title);
      const bodyText = stringOrNull(record.bodyText) ?? '';
      const bodyLength = typeof record.bodyLength === 'number' ? record.bodyLength : null;
      const challenge = detectCaptchaChallenge(title, bodyText, record.captcha);
      return {
        url: stringOrNull(record.url),
        title,
        bodyLength,
        emptyBody: bodyLength === 0,
        webdriver: !!record.webdriver,
        challenge,
      };
    }
  } catch {
  }
  return undefined;
}

/**
 * @param {Function} originalRun
 * @param {any} session
 * @param {any} clientInfo
 */
async function readConsoleEntries(originalRun, session, clientInfo) {
  try {
    const response = await originalRun.call(session, clientInfo, { _: ['console'] }, { json: true, raw: false });
    const payload = normalizeUpstreamResult(parseJsonText(response.text));
    return parseConsoleText(typeof payload === 'string' ? payload : '');
  } catch {
    return [];
  }
}

/**
 * @param {unknown} value
 */

/**
 * Parse upstream text output into structured data for commands whose daemon
 * responses are plain text, not JSON. This gives agents machine-readable
 * results in --json mode instead of forcing them to regex-parse Markdown.
 *
 * @param {string | undefined} command
 * @param {unknown} upstreamResult
 * @returns {unknown}
 */
function normalizeCommandResult(command, upstreamResult) {
  if (typeof upstreamResult !== 'string')
    return upstreamResult;

  if (command === 'tab-list')
    return parseTabList(upstreamResult);
  if (command === 'console')
    return parseConsoleOutput(upstreamResult);
  if (command === 'requests')
    return parseRequestsList(upstreamResult);
  if (command === 'request')
    return parseRequestDetail(upstreamResult);
  if (command === 'request-headers' || command === 'response-headers')
    return { headers: parseHeaderLines(upstreamResult) };
  if (command === 'request-body' || command === 'response-body')
    return parseBodyText(upstreamResult);

  return upstreamResult;
}

/**
 * Parse header key-value lines into an object.
 * @param {string} text
 * @returns {Record<string, string>}
 */
function parseHeaderLines(text) {
  const headers = /** @type {Record<string, string>} */ ({});
  for (const line of text.split(/\r?\n/)) {
    const kv = line.match(/^([^:]+):\s*(.*)$/);
    if (kv)
      headers[kv[1].trim()] = kv[2].trim();
  }
  return headers;
}

/**
 * Parse a single `--header="Key: Value"` argument into an object. Multiple
 * comma-separated headers are supported, but a comma inside a header value
 * (Accept lists, HTTP dates, quoted strings) must be preserved: only a comma
 * followed by a new `Name:` starts another header (issue #45).
 * @param {string} arg
 * @returns {Record<string, string>}
 */
function parseHeaderArg(arg) {
  const headers = /** @type {Record<string, string>} */ ({});
  const TOKEN = "[A-Za-z0-9!#$%&'*+.^_`|~-]+";
  const startsHeader = new RegExp(`^\\s*(${TOKEN})\\s*:\\s*([\\s\\S]*)$`);
  let currentName = null;
  for (const part of String(arg).split(',')) {
    const kv = part.match(startsHeader);
    if (kv) {
      currentName = kv[1].trim();
      headers[currentName] = kv[2].trim();
    } else if (currentName) {
      headers[currentName] = `${headers[currentName]},${part}`;
    }
  }
  return headers;
}

/**
 * Parse a body: return raw text plus a parsed JSON value when applicable.
 * @param {string} text
 */
function parseBodyText(text) {
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return json !== null ? { body: text, json } : { body: text };
}

/**
 * Parse tab-list output: "- 0: [Title](url)\n- 1: (current) [Title](url)"
 * @param {string} text
 */
function parseTabList(text) {
  const tabs = [];
  // Greedy title/URL so ordinary punctuation in page metadata (brackets in a
  // title, parentheses in a URL) does not silently drop the tab (issue #63).
  const re = /^- (\d+):( \(current\))? \[(.*)\]\((.*)\)\s*$/gm;
  let match;
  while ((match = re.exec(text)) !== null) {
    tabs.push({
      index: parseInt(match[1], 10),
      current: !!match[2],
      title: match[3],
      url: match[4],
    });
  }
  return { tabs };
}
/**
 * Parse console output:
 *   "Total messages: N (Errors: X, Warnings: Y)\n[ERROR] msg\n[WARNING] msg"
 * @param {string} text
 */
function parseConsoleOutput(text) {
  const lines = text.split(/\r?\n/);
  const messages = [];
  const levelMap = /** @type {Record<string, string>} */ ({ '[ERROR]': 'error', '[WARNING]': 'warning', '[INFO]': 'info', '[DEBUG]': 'debug', '[LOG]': 'log' });
  let summary = { total: 0, errors: 0, warnings: 0 };

  const summaryMatch = text.match(/Total messages:\s*(\d+)\s*\(Errors:\s*(\d+),\s*Warnings:\s*(\d+)\)/);
  if (summaryMatch) {
    summary = {
      total: parseInt(summaryMatch[1], 10),
      errors: parseInt(summaryMatch[2], 10),
      warnings: parseInt(summaryMatch[3], 10),
    };
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('Total messages:') || trimmed === '### Result')
      continue;
    for (const [prefix, level] of Object.entries(levelMap)) {
      if (trimmed.startsWith(prefix)) {
        messages.push({ level, text: trimmed.slice(prefix.length).trim() });
        break;
      }
    }
  }

  return { messages, summary };
}

/**
 * Parse requests list: "1. [GET] url => [200] \n2. [POST] url => [404] "
 * @param {string} text
 */
function parseRequestsList(text) {
  const requests = [];
  const re = /^(\d+)\.\s+\[(\w+)\]\s+(\S+)\s+=>\s+\[(\d+)\]/gm;
  let match;
  while ((match = re.exec(text)) !== null) {
    requests.push({
      index: parseInt(match[1], 10),
      method: match[2],
      url: match[3],
      status: parseInt(match[4], 10),
    });
  }
  return { requests };
}

/**
 * Parse request detail output into structured sections.
 * @param {string} text
 */
function parseRequestDetail(text) {
  const headerMatch = text.match(/^#(\d+)\s+\[(\w+)\]\s+(\S+)/m);
  const result = {
    index: headerMatch ? parseInt(headerMatch[1], 10) : null,
    method: headerMatch?.[2] ?? null,
    url: headerMatch?.[3] ?? null,
    general: /** @type {Record<string, string>} */ ({}),
    requestHeaders: /** @type {Record<string, string>} */ ({}),
    responseHeaders: /** @type {Record<string, string>} */ ({}),
  };

  let section = /** @type {null | 'general' | 'requestHeaders' | 'responseHeaders'} */ (null);
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === 'General') { section = 'general'; continue; }
    if (trimmed === 'Request headers') { section = 'requestHeaders'; continue; }
    if (trimmed === 'Response headers') { section = 'responseHeaders'; continue; }
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('Run `'))
      continue;
    const kv = trimmed.match(/^(\S[\w\s-]+?):\s+(.*)/);
    if (kv && section) {
      const key = kv[1].trim();
      const value = kv[2].trim();
      result[section][key] = value;
    }
  }

  return result;
}

/**
 * Unwrap upstream payloads of the shape `{ result: ... }`.
 * @param {unknown} value
 * @returns {unknown}
 */
function normalizeUpstreamResult(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && 'result' in value)
    return parseJsonText(value.result);
  return value;
}

/**
 * @param {unknown} value
 */
function parseJsonText(value) {
  if (typeof value !== 'string')
    return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * A fetch request routed through a non-browser engine.
 *
 * @typedef {Object} EngineRequest
 * @property {string} engine 'wreq' | 'httpcloak' | 'browser'
 * @property {string} url
 * @property {string} method
 * @property {string | undefined} data
 * @property {Record<string, string>} headers
 * @property {number | undefined} timeoutMs
 * @property {number} retryCount
 * @property {number} maxAttempts
 */

/**
 * Execute a fetch through the wreq engine (node-wreq, Chrome-impersonating
 * Rust TLS core). Runs entirely in Node — no browser session needed.
 *
 * @param {EngineRequest} req
 * @returns {Promise<{ status: any, statusText: any, url: any, redirected: boolean,
 *   headers: Record<string, string>, body: any, binary: boolean, json: any,
 *   attempts: number, retried: boolean, durationMs: number, engine: string, failed: boolean }>}
 */
async function fetchWithWreq(req) {
  const wreq = /** @type {any} */ (require('node-wreq'));
  const profiles = wreq.getProfiles();
  const newestChrome = profiles.filter(p => p.startsWith('chrome')).sort((a, b) => parseInt(b.split('_')[1], 10) - parseInt(a.split('_')[1], 10))[0];
  const startedAt = Date.now();
  const proxy = proxyForEngine(req.url);
  const headers = { ...req.headers };
  if (req.data !== undefined && !Object.keys(headers).some(h => h.toLowerCase() === 'content-type'))
    headers['content-type'] = 'application/json';
  const controller = new AbortController();
  const timeout = req.timeoutMs ? setTimeout(() => controller.abort(), req.timeoutMs) : null;
  // Created before the request so an abort that fires during/after the headers
  // is still observed by the body read (issue #39).
  const aborted = new Promise((_, reject) => {
    const fail = () => reject(new Error(`Request timed out after ${req.timeoutMs}ms`));
    if (controller.signal.aborted)
      return fail();
    controller.signal.addEventListener('abort', fail, { once: true });
  });
  let response = null;
  let lastError = null;
  let attempts = 0;
  let resolvedBody = /** @type {any} */ (null);
  let resolvedBinary = false;
  let resolvedHeaders = /** @type {Record<string, string>} */ ({});
  try {
    for (let i = 0; i < req.maxAttempts; i++) {
      attempts = i + 1;
      try {
        response = await wreq.fetch(req.url, {
          method: req.method,
          headers,
          body: req.data !== undefined ? (typeof req.data === 'string' ? req.data : JSON.stringify(req.data)) : undefined,
          impersonate: newestChrome,
          redirect: 'follow',
          signal: controller?.signal,
          ...(proxy ? { proxy } : {}),
        });
        lastError = null;
      } catch (error) {
        lastError = error;
      }
      const statusNow = response ? response.status : null;
      const shouldRetry = req.retryCount > 0 && i < req.maxAttempts - 1 && (lastError !== null || (statusNow !== null && statusNow >= 500));
      if (!shouldRetry)
        break;
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    // Body consumption stays inside the timeout window: a stalled body must
    // not outlive --timeout (issue #39).
    if (response) {
      const responseHeaders = /** @type {Record<string, string>} */ ({});
      response.headers.forEach((value, name) => { responseHeaders[name.toLowerCase()] = value; });
      const contentType = responseHeaders['content-type'] ?? '';
      const isBinaryResponse = /octet-stream|image\/|application\/pdf|application\/zip|application\/gzip|audio\/|video\/|font\//.test(contentType);
      const readBody = isBinaryResponse
        ? response.arrayBuffer().then((/** @type {ArrayBuffer} */ buf) => ({ body: Buffer.from(buf).toString('base64'), binary: true }))
        : response.text().then((/** @type {string} */ text) => ({ body: text, binary: false }));
      const settled = await Promise.race([readBody, aborted]);
      resolvedBody = settled.body;
      resolvedBinary = settled.binary;
      resolvedHeaders = responseHeaders;
    }
  } finally {
    clearTimeout(timeout);
  }
  if (lastError && !response)
    throw lastError;
  const responseHeaders = resolvedHeaders;
  const body = resolvedBody;
  const binary = resolvedBinary;
  let json = null;
  if (!binary) { try { json = JSON.parse(body); } catch {} }
  /** @type {{ status: any, statusText: any, url: any, redirected: boolean, headers: Record<string, string>, body: any, binary: boolean, json: any, attempts: number, retried: boolean, durationMs: number, engine: string, failed: boolean }} */
  return {
    status: response.status,
    statusText: response.statusText || '',
    url: response.url || req.url,
    redirected: response.url ? response.url !== req.url : false,
    headers: responseHeaders,
    body,
    attempts,
    retried: attempts > 1,
    durationMs: Date.now() - startedAt,
    binary,
    json,
    engine: 'wreq',
    failed: response.status >= 400,
  };
}

/**
 * Execute a fetch through httpcloak's Chrome-fingerprint HTTP client.
 * @param {EngineRequest} req
 * @returns {Promise<{ status: any, statusText: any, url: any, redirected: boolean,
 *   headers: Record<string, string>, body: any, binary: boolean, json: any,
 *   attempts: number, retried: boolean, durationMs: number, engine: string, failed: boolean }>}
 */
async function fetchWithHttpcloak(req) {
  const { Session } = require('httpcloak');
  const proxy = proxyForEngine(req.url);
  const session = new Session({ preset: 'chrome-latest', ...(proxy ? { proxy } : {}) });
  const startedAt = Date.now();
  let response = null;
  let lastError = null;
  let attempts = 0;
  try {
    for (let i = 0; i < req.maxAttempts; i++) {
      attempts = i + 1;
      try {
        const options = { headers: Object.keys(req.headers).length ? req.headers : undefined };
        if (req.data !== undefined)
          options.body = req.data;
        if (req.timeoutMs) {
          options.timeout = req.timeoutMs / 1000; // httpcloak timeouts are in seconds
          options.signal = AbortSignal.timeout(req.timeoutMs);
        }
        response = await session.request(req.method.toLowerCase(), req.url, options);
        lastError = null;
      } catch (error) {
        lastError = error;
      }
      const statusNow = response ? response.statusCode : null;
      const shouldRetry = req.retryCount > 0 && i < req.maxAttempts - 1 && (lastError !== null || (statusNow !== null && statusNow >= 500));
      if (!shouldRetry)
        break;
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  } finally {
    session.close();
  }
  if (lastError && !response)
    throw lastError;
  const headers = /** @type {Record<string, string>} */ ({});
  for (const [name, value] of Object.entries(response.headers ?? {}))
    headers[String(name).toLowerCase()] = String(value);
  const contentType = headers['content-type'] ?? '';
  const isBinary = /octet-stream|image\/|application\/pdf|application\/zip|application\/gzip|audio\/|video\/|font\//.test(contentType);
  let body = response.text ?? '';
  let binary = false;
  if (isBinary) {
    body = Buffer.from(response.body || Buffer.alloc(0)).toString('base64');
    binary = true;
  }
  let json = null;
  if (!binary) { try { json = JSON.parse(body); } catch {} }
  /** @type {{ status: any, statusText: any, url: any, redirected: boolean, headers: Record<string, string>, body: any, binary: boolean, json: any, attempts: number, retried: boolean, durationMs: number, engine: string, failed: boolean }} */
  return {
    status: response.statusCode,
    statusText: '',
    url: response.finalUrl || req.url,
    redirected: (response.finalUrl || req.url) !== req.url,
    headers,
    body,
    attempts,
    retried: attempts > 1,
    durationMs: Date.now() - startedAt,
    binary,
    json,
    engine: 'httpcloak',
    failed: response.statusCode >= 400,
  };
}

/**
 * Dispatch a fetch request to the configured non-browser engine.
 *
 * @param {EngineRequest} req
 * @returns {Promise<Record<string, any>>}
 */
async function runEngineFetch(req) {
  if (req.engine === 'httpcloak') {
    const available = (() => { try { require.resolve('httpcloak'); return true; } catch { return false; } })();
    if (!available)
      throw new Error('httpcloak is not installed; use --engine=wreq (default) or --engine=browser.');
    return await fetchWithHttpcloak(req);
  }
  return await fetchWithWreq(req);
}

/**
 * Run a non-browser engine fetch and render its result in the requested
 * output mode.
 *
 * @param {import('./cliEnhancements').EngineRequest} engineRequest
 * @param {any} session
 * @param {{ env: NodeJS.ProcessEnv }} options
 * @param {{ json?: boolean, raw?: boolean } | undefined} runOptions
 * @param {(() => void) | undefined} [onEscalate] - when provided, a blocked
 *   challenge is escalated to the browser instead of emitted (sessionless path).
 * @returns {Promise<{ isError: boolean, text: string, escalate?: boolean }>}
 */
async function emitEngineFetchResult(engineRequest, session, options, runOptions, onEscalate) {
  let engineResult;
  try {
    engineResult = await runEngineFetch(engineRequest);
  } catch (error) {
    const payload = failurePayload(error, undefined, [], providerDetailsForSession(session, options.env));
    process.exitCode = 1;
    return { isError: true, text: JSON.stringify(payload, null, 2) };
  }
  // Surface challenge classification exactly like the browser path: a blocked
  // response is never presented as ordinary content, even at HTTP 200.
  const engineChallenge = detectChallengeFromText(
      null,
      typeof engineResult.body === 'string' ? engineResult.body : '',
      typeof engineResult.status === 'number' ? engineResult.status : null);
  if (engineChallenge.blocked) {
    engineResult.challenge = engineChallenge;
    // Escalate identified challenges, including HTTP 403/429, but never
    // automatically replay a potentially-mutating request: a POST that already
    // reached the server must not be sent again just because it was challenged
    // (issue #48). Only idempotent methods escalate implicitly.
    const idempotent = ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE', 'TRACE'].includes(String(engineRequest.method).toUpperCase());
    if (onEscalate && engineChallenge.type !== 'none' && engineRequest.engine !== 'browser') {
      if (idempotent) {
        process.env.PLAYWRIGHT_CLI_FORCE_BROWSER_FETCH = '1';
        return { isError: false, text: '', escalate: true };
      }
      engineResult.escalationSkipped = `challenge detected on a ${String(engineRequest.method).toUpperCase()} request; not replayed automatically`;
    }
  }
  const ok = !engineResult.failed && !engineChallenge.blocked;
  if (!runOptions?.json) {
    if (!ok)
      process.exitCode = 1;
    return { isError: false, text: runOptions?.raw && !engineResult.binary ? engineResult.body : JSON.stringify(engineResult, null, 2) };
  }
  if (!ok)
    process.exitCode = 1;
  return { isError: false, text: JSON.stringify({
    ...successPayload(null, engineResult, [], providerDetailsForSession(session, options.env), proxyDetails(options.env)),
    ok,
    ...(!ok && engineResult.failed ? { error: `HTTP ${engineResult.status} ${engineResult.statusText ?? ''}`.trim() } : {}),
    ...(!ok && !engineResult.failed ? { error: `Blocked by ${engineChallenge.type} challenge` } : {}),
  }, null, 2) };
}

/**
 * Run an engine fetch directly from main() and emit the result, bypassing the
 * upstream program (whose session gate would exit before our run wrapper can
 * dispatch a sessionless engine request). Returns true when the argv was an
 * engine fetch and fully handled.
 *
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<boolean>}
 */
async function runEngineFetchFromArgv(argv, env) {
  const command = argv.find(arg => !arg.startsWith('-'));
  if (command !== 'fetch')
    return false;
  // Help takes precedence over validation and dispatch: asking for usage must
  // never execute the supplied request (issue #47).
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${FETCH_HELP}\n`);
    return true;
  }
  // Build the args object the way upstream's parser (minimist) would so
  // --method=POST, --method POST, --engine httpcloak, --data=... etc. reach
  // prepareCommandArgs as top-level keys instead of being stranded inside the
  // positional array.
  const { positional, flags } = parseCliArgv(argv, 'fetch', { json: true, raw: true });
  const prepared = prepareCommandArgs({ _: ['fetch', ...positional], ...flags });
  if (prepared._?.[0] !== 'engine-fetch' || !prepared._engineRequest)
    return false;
  if (prepared._engineRequest.engine === 'browser')
    return false; // needs a live session; let the daemon path handle it
  // Auto escalation to the browser on challenge applies only to the default
  // engine; an explicit --engine= (either syntax) keeps the chosen transport.
  const explicitEngine = typeof flags.engine === 'string' && flags.engine !== '';
  const outputMode = { json: argv.includes('--json'), raw: argv.includes('--raw') };
  const result = await emitEngineFetchResult(
      prepared._engineRequest,
      undefined,
      { env },
      outputMode,
      explicitEngine ? undefined : () => true);
  if (result.escalate)
    return false; // program() re-enters with the browser engine forced
  if (outputMode.json)
    process.stdout.write(`${result.text}\n`);
  else
    process.stdout.write(result.text);
  return true;
}

/**
 * Parse an argv list minimist-style: `--key=value`, `--key value` (string keys
 * consume the following token), and bare `--boolean` for keys in `booleanKeys`.
 * Single-dash tool flags (`-s=`, `-h`) and the bare command token are skipped.
 *
 * @param {string[]} argv
 * @param {string} command
 * @param {Record<string, true>} booleanKeys - static lookup of boolean flags
 * @returns {{ positional: string[], flags: Record<string, string | boolean> }}
 */
function parseCliArgv(argv, command, booleanKeys) {
  const positional = [];
  const flags = /** @type {Record<string, string | boolean>} */ ({});
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === command || arg.startsWith('-s='))
      continue;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
        continue;
      }
      const key = arg.slice(2);
      if (booleanKeys[key]) {
        flags[key] = true;
        continue;
      }
      const next = argv[i + 1];
      // A value may legitimately start with a single dash (e.g. `--data -1`);
      // only a following `--flag` should be treated as a new option (issue #52).
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
      continue;
    }
    if (!arg.startsWith('-'))
      positional.push(arg);
  }
  return { positional, flags };
}

/**
 * Parse the upstream `### <title>\n<content>` sections from a text response.
 *
 * @param {string} text
 * @returns {Map<string, string>}
 */
function parseUpstreamSections(text) {
  const sections = new Map();
  for (const section of text.split(/^### /m).slice(1)) {
    const firstNewline = section.indexOf('\n');
    if (firstNewline === -1)
      continue;
    sections.set(section.slice(0, firstNewline), section.slice(firstNewline + 1).trim());
  }
  return sections;
}

/**
 * Parse console text output into trimmed non-empty lines, dropping the
 * upstream "Total messages:" summary header.
 *
 * @param {string} text
 * @returns {string[]}
 */
function parseConsoleText(text) {
  return text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !/^Total messages:/i.test(line));
}
/**
 * Extract the host from a URL for cross-host redirect warnings.
 *
 * @param {string} url
 * @returns {string}
 */
function hostOfUrl(url) {
  const match = typeof url === 'string' ? url.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i) : null;
  return match ? match[1].toLowerCase() : '';
}

/**
 * Keyword-based challenge detection for text bodies that lack DOM widget
 * signals (e.g. the challenge lives inside a cross-origin iframe).
 *
 * @param {string | null} title
 * @param {string} bodyText
 * @param {number | null} [status]
 * @returns {{ type: string, blocked: boolean }}
 */
function detectChallengeFromText(title, bodyText, status) {
  const lower = `${title ?? ''} ${bodyText ?? ''}`.toLowerCase();
  const has = (/** @type {string[]} */ ...needles) => needles.some(needle => lower.includes(needle));
  // Corroborating signals for soft keywords: a public article mentioning a
  // vendor, or a plain <noscript> notice, is not a challenge (issue #46).
  const challengeContext = has('challenge', 'captcha', 'turnstile', 'verify', 'security check', 'cf-', 'ray id', 'protected by', 'blocked');
  if (has('just a moment', 'checking your browser', 'performing security verification', 'ray id'))
    return { type: 'cloudflare', blocked: true };
  if (has('enable javascript') && challengeContext)
    return { type: 'cloudflare', blocked: true };
  if (has('please enable js and disable any ad blocker'))
    return { type: 'datadome', blocked: true };
  // Vendor mention alone is not proof; require challenge context or a 403.
  if (has('datadome') && (challengeContext || status === 403))
    return { type: 'datadome', blocked: true };
  if (has('you have been blocked', 'your access has been') || (status === 403 && has('access denied', "you don't have permission")))
    return { type: 'blocked', blocked: true };
  if (has('select all squares', 'i am not a robot', 'verify you are human', 'prove you are human', 'complete the security check'))
    return { type: 'captcha', blocked: true };
  if (status === 403)
    return { type: '403', blocked: true };
  if (status === 429)
    return { type: 'rate-limit', blocked: true };
  return { type: 'none', blocked: false };
}

/**
 * Detect a captcha challenge from DOM widget presence plus text signals.
 * Prefers the precise widget type (turnstile/recaptcha/hcaptcha) from the
 * browser DOM, falling back to text/keyword matching when the widget is not
 * directly observable (e.g. the challenge is inside a cross-origin iframe).
 *
 * @param {string | null} title
 * @param {string} bodyText
 * @param {{ turnstile?: boolean, recaptcha?: boolean, hcaptcha?: boolean } | undefined} captcha
 * @param {number | null} [status]
 */
function detectCaptchaChallenge(title, bodyText, captcha, status) {
  if (captcha?.turnstile)
    return { type: 'turnstile', blocked: true };
  if (captcha?.recaptcha)
    return { type: 'recaptcha', blocked: true };
  if (captcha?.hcaptcha)
    return { type: 'hcaptcha', blocked: true };
  return detectChallengeFromText(title, bodyText, status);
}

/**
 * Build the standard success payload returned by --json commands.
 *
 * @param {{ url: string | null, title: string | null, bodyLength?: number | null,
 *   emptyBody?: boolean, webdriver?: boolean, challenge?: { type: string, blocked: boolean } } | undefined} page
 * @param {unknown} result
 * @param {string[]} consoleEntries
 * @param {{ name: string, version: string } | undefined} provider
 * @param {{ server: string, bypass?: string } | undefined} proxy
 */
function successPayload(page, result, consoleEntries, provider, proxy) {
  return {
    ok: true,
    url: page?.url ?? null,
    title: page?.title ?? null,
    result: result ?? null,
    console: consoleEntries,
    provider: provider ?? null,
    ...(page?.challenge ? { challenge: page.challenge } : {}),
    ...(page?.bodyLength !== undefined ? { bodyLength: page.bodyLength, emptyBody: page.emptyBody } : {}),
    ...(page?.webdriver !== undefined ? { webdriver: page.webdriver } : {}),
    ...(proxy ? { proxy } : {}),
  };
}

/**
 * @param {unknown} error
 * @param {{ url: string | null, title: string | null } | undefined} [page]
 * @param {string[]} [consoleEntries]
 * @param {{ name: string, version: string } | undefined} [provider]
 */
function failurePayload(error, page, consoleEntries = [], provider) {
  return {
    ok: false,
    url: page?.url ?? null,
    title: page?.title ?? null,
    result: null,
    console: consoleEntries,
    error: errorMessage(error),
    ...(provider ? { provider } : {}),
  };
}

/**
 * Surface the effective proxy configuration so agents can tell where traffic
 * is actually going. Reports the resolved proxy server and bypass rules from
 * the upstream env contract (PLAYWRIGHT_MCP_*) plus conventional HTTP(S)_PROXY.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ server: string, bypass?: string } | undefined}
 */
function proxyDetails(env) {
  const server = env.PLAYWRIGHT_MCP_PROXY_SERVER || env.HTTPS_PROXY || env.HTTP_PROXY;
  if (!server)
    return undefined;
  const bypass = env.PLAYWRIGHT_MCP_PROXY_BYPASS || env.NO_PROXY;
  // Never surface embedded credentials in diagnostics (issue #60); routing
  // still uses the raw value internally.
  const sanitized = redactProxyCredentials(server);
  return bypass ? { server: sanitized, bypass } : { server: sanitized };
}

/**
 * Strip userinfo (`user:pass@`) from a proxy URL before exposing it in output.
 * @param {string} server
 * @returns {string}
 */
function redactProxyCredentials(server) {
  try {
    const parsed = new URL(server.includes('://') ? server : `http://${server}`);
    if (!parsed.username && !parsed.password)
      return server;
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return server.replace(/\/\/[^/@]*@/, '//');
  }
}

/**
 * Resolve the proxy an HTTP engine should use for a URL, honoring the bypass
 * list. Returns undefined when no proxy applies. Both wreq and httpcloak must
 * actually route through it — the reported metadata must not claim a proxy the
 * engine ignores (issue #44).
 *
 * @param {string} url
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | undefined}
 */
function proxyForEngine(url, env = process.env) {
  const server = env.PLAYWRIGHT_MCP_PROXY_SERVER || env.HTTPS_PROXY || env.HTTP_PROXY;
  if (!server)
    return undefined;
  const bypass = env.PLAYWRIGHT_MCP_PROXY_BYPASS || env.NO_PROXY;
  return bypass && isProxyBypassed(url, bypass) ? undefined : server;
}

/**
 * @param {string} url
 * @param {string} bypass comma-separated NO_PROXY-style list
 * @returns {boolean}
 */
function isProxyBypassed(url, bypass) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return bypass
      .split(',')
      .map(entry => entry.trim().toLowerCase())
      .filter(Boolean)
      .some((entry) => {
        const suffix = entry.replace(/^\./, '');
        return host === suffix || host.endsWith(`.${suffix}`);
      });
}

/**
 * @param {NodeJS.ProcessEnv} env
 */
function providerDetails(env) {
  const provider = env[activeProviderEnvName];
  if (!provider)
    return undefined;
  return { name: provider, version: providerVersion(provider) };
}

/**
 * @param {any} session
 * @param {NodeJS.ProcessEnv} env
 */
function providerDetailsForSession(session, env) {
  const active = providerDetails(env);
  if (active)
    return active;
  if (session?.__stealthProviderDetails)
    return session.__stealthProviderDetails;
  const metadata = readProviderMetadata(session?._sessionFile?.daemonDir, session?.name);
  if (metadata)
    return { name: metadata.provider, version: metadata.version };
  return inferProviderDetails(session?.config);
}

/**
 * Recovers provider identity for sessions created before sidecar metadata was
 * written, or when a sidecar was lost.
 *
 * CloakBrowser is the sole provider, so claims are conservative and
 * evidence-based: only a CloakBrowser binary path or `--fingerprint` launch
 * arg proves provenance. An ambient upstream chromium config (issue #28)
 * carries neither, so it reports no provider.
 *
 * @param {any} config
 */
function inferProviderDetails(config) {
  const browser = config?.browser;
  const launchOptions = browser?.launchOptions ?? {};
  const executablePath = typeof launchOptions.executablePath === 'string' ? launchOptions.executablePath.toLowerCase() : '';
  const args = /** @type {unknown[]} */ (Array.isArray(launchOptions.args) ? launchOptions.args : []);
  if (executablePath.includes('cloakbrowser') || args.some(arg => typeof arg === 'string' && arg.startsWith('--fingerprint=')))
    return { name: 'cloakbrowser', version: providerVersion('cloakbrowser') };
  return undefined;
}

/**
 * @param {string} provider
 */
function providerVersion(provider) {
  return require('./browserProviders').providerVersion(provider);
}

/**
 * @param {string | undefined} daemonDir
 * @param {string} sessionName
 */
function readProviderMetadata(daemonDir, sessionName) {
  if (!daemonDir)
    return undefined;
  try {
    const value = JSON.parse(fs.readFileSync(providerMetadataPath(daemonDir, sessionName), 'utf8'));
    if (value.provider === 'cloakbrowser' && typeof value.version === 'string') {
      return {
        provider: value.provider,
        version: value.version,
      };
    }
  } catch {
  }
  return undefined;
}

/**
 * @param {string} daemonDir
 * @param {string} sessionName
 * @param {{ provider: string, version: string }} metadata
 */
function writeProviderMetadata(daemonDir, sessionName, metadata) {
  try {
    fs.mkdirSync(daemonDir, { recursive: true });
    fs.writeFileSync(providerMetadataPath(daemonDir, sessionName), JSON.stringify(metadata));
  } catch {
  }
}

/**
 * @param {string} daemonDir
 * @param {string} sessionName
 */
function providerMetadataPath(daemonDir, sessionName) {
  return path.join(daemonDir, `${sessionName}${providerMetadataSuffix}`);
}

/**
 * @param {unknown} value
 */
function stringOrNull(value) {
  return typeof value === 'string' ? value : null;
}

/**
 * @param {unknown} error
 */
/**
 * Runs on the failure path, so it must never throw: `JSON.stringify` raises on
 * circular structures and on BigInt, which would replace the real diagnostic
 * with an unrelated TypeError.
 *
 * @param {unknown} error
 */
function serializeUnknownError(error) {
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    try {
      return String(error);
    } catch {
      return 'Unknown error';
    }
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : serializeUnknownError(error);
  // eslint-disable-next-line no-control-regex -- the regex exists to strip ANSI escape control characters
  return message.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}
/**
 * Remove accumulated snapshot/console artifacts from `.playwright-cli/`.
 * `--all` removes everything; `--days=N` (default 7) removes files older than N
 * days. Long-running agent sessions otherwise grow this directory without bound.
 *
 * @param {string[]} argv
 */
function runCleanup(argv) {
  const fsSync = require('fs');
  const pathSync = require('path');
  const outputDir = pathSync.join(process.cwd(), '.playwright-cli');
  const all = argv.includes('--all');
  const json = argv.includes('--json');
  const daysArg = argv.find(arg => arg.startsWith('--days='));
  const days = daysArg ? parseFloat(daysArg.split('=')[1]) : 7;

  if (!fsSync.existsSync(outputDir)) {
    const empty = { removed: 0, remaining: 0, dir: outputDir };
    if (json)
      process.stdout.write(`${JSON.stringify(empty, null, 2)}\n`);
    else
      console.log('No .playwright-cli directory to clean.');
    return;
  }
  const cutoff = Date.now() - (isFinite(days) && days >= 0 ? days : 7) * 24 * 60 * 60 * 1000;
  const entries = fsSync.readdirSync(outputDir);
  let removed = 0;
  for (const name of entries) {
    if (!/^(page-.*\.yml|console-.*\.log|snapshot-.*|video-.*)$/.test(name))
      continue;
    const fullPath = pathSync.join(outputDir, name);
    try {
      const stat = fsSync.statSync(fullPath);
      if (all || stat.mtimeMs < cutoff) {
        fsSync.unlinkSync(fullPath);
        removed++;
      }
    } catch {
    }
  }

  const remaining = fsSync.readdirSync(outputDir).length;
  const result = { removed, remaining, dir: outputDir };
  if (json)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else
    console.log(`Removed ${removed} artifact(s); ${remaining} file(s) remain in ${outputDir}`);
}

/**
 * @param {string[]} argv
 */
function firstCommand(argv) {
  return argv.find(arg => !arg.startsWith('-'));
}

module.exports = {
  configureCliEnhancements,
  detectChallengeFromText,
  failurePayload,
  inferProviderDetails,
  normalizeUpstreamResult,
  parseCliArgv,
  parseConsoleText,
  parseTimeoutMs,
  parseTabList,
  prepareCommandArgs,
  resolveEvalOutputPath,
  runCleanup,
  runEngineFetch,
  runEngineFetchFromArgv,
  successPayload,
};
