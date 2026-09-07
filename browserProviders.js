/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

// @ts-check

const fs = require('fs');
const os = require('os');
const path = require('path');

const providerEnvName = 'PLAYWRIGHT_CLI_BROWSER_PROVIDER';
const activeProviderEnvName = 'PLAYWRIGHT_CLI_ACTIVE_BROWSER_PROVIDER';
const configEnvName = 'PLAYWRIGHT_MCP_CONFIG';

/**
 * @param {{
 *   argv?: string[],
 *   command?: string,
 *   env?: NodeJS.ProcessEnv,
 *   sessionModule: { Session?: { startDaemon?: Function } },
 *   activateProvider?: typeof activateProvider,
 * }} options
 */
async function configureBrowserProvider(options) {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const command = options.command ?? firstCommand(argv);
  const state = createProviderState(command, argv, env);
  if (!state.enabled)
    return { enabled: false };

  const sessionClass = options.sessionModule.Session;
  if (!sessionClass || typeof sessionClass.startDaemon !== 'function')
    throw new Error('Unable to configure CloakBrowser: Session.startDaemon was not found.');
  const originalStartDaemon = /** @type {typeof sessionClass.startDaemon & { __cloakBrowserProvider?: boolean }} */ (sessionClass.startDaemon);
  if (originalStartDaemon.__cloakBrowserProvider)
    return { enabled: true };

  await (options.activateProvider ?? activateProvider)(state, env);
  sessionClass.startDaemon = async function(/** @type {any[]} */ ...args) {
    // An explicit generated config prevents the default-path config from
    // overriding the CloakBrowser executable in the daemon (issue #37).
    const cliArgs = args[1];
    if (cliArgs && !cliArgs.config)
      cliArgs.config = env[configEnvName];
    return await originalStartDaemon.apply(this, args);
  };
  const taggedDaemon = /** @type {typeof sessionClass.startDaemon & { __cloakBrowserProvider?: boolean }} */ (sessionClass.startDaemon);
  taggedDaemon.__cloakBrowserProvider = true;
  return { enabled: true };
}

/**
 * @param {string | undefined} command
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @returns {{
 *   enabled: boolean,
 *   configDir?: string,
 *   hostResolverRules?: string | undefined,
 *   dnsServers?: string | undefined,
 * }}
 */
function createProviderState(command, argv, env) {
  const providerOverride = env[providerEnvName];
  if (command !== 'open')
    return { enabled: false };
  if (!providerOverride && hasExplicitBrowserConfig(argv, env))
    return { enabled: false };
  resolveProvider(providerOverride);
  return {
    enabled: true,
    configDir: createConfigDir(),
    hostResolverRules: flagValue(argv, 'host-resolver-rules'),
    dnsServers: flagValue(argv, 'dns-servers'),
  };
}

/**
 * Extract the value of a `--flag=value` or `--flag value` argument.
 * @param {string[]} argv
 * @param {string} flag
 * @returns {string | undefined}
 */
function flagValue(argv, flag) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${flag}`)
      return argv[i + 1];
    if (argv[i].startsWith(`--${flag}=`))
      return argv[i].slice(`--${flag}=`.length);
  }
  return undefined;
}

/**
 * Generated provider configs are scratch state for a single run, and they embed
 * the resolved launch options. Remove the directory on exit instead of leaving
 * one behind per invocation.
 */
function createConfigDir() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'playwright-cli-browser-'));
  process.once('exit', () => {
    try {
      fs.rmSync(configDir, { recursive: true, force: true });
    } catch {
    }
  });
  return configDir;
}

/**
 * @param {string | undefined} providerOverride
 */
function resolveProvider(providerOverride) {
  if (!providerOverride || providerOverride === 'auto' || providerOverride === 'cloakbrowser')
    return 'cloakbrowser';
  throw new Error(`Unsupported browser provider '${providerOverride}': other providers were removed. Expected cloakbrowser.`);
}

/**
 * @param {ReturnType<typeof createProviderState>} state
 * @param {NodeJS.ProcessEnv} env
 */
async function activateProvider(state, env) {
  delete env.PLAYWRIGHT_MCP_BROWSER;
  delete env.PLAYWRIGHT_MCP_EXECUTABLE_PATH;
  const config = await cloakBrowserConfig(state);
  const configPath = path.join(state.configDir ?? createConfigDir(), 'cloakbrowser.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  env[activeProviderEnvName] = 'cloakbrowser';
  env[configEnvName] = configPath;
}

/**
 * @param {ReturnType<typeof createProviderState>} state
 */
async function cloakBrowserConfig(state) {
  const { buildLaunchOptions, CHROMIUM_VERSION } = await import('cloakbrowser');
  const launchOptions = await buildLaunchOptions();
  const launchArgs = dnsLaunchArgs(state);
  if (launchArgs.length)
    launchOptions.args = [...(launchOptions.args ?? []), ...launchArgs];
  return mergeDefaultPathConfig({
    browser: {
      browserName: 'chromium',
      launchOptions,
      contextOptions: { userAgent: chromeUserAgent(CHROMIUM_VERSION.split('.')[0]) },
    },
  });
}

/**
 * Preserve default-path settings while keeping the provider's browser identity.
 * @param {Record<string, any>} config
 */
function mergeDefaultPathConfig(config) {
  const defaultPath = path.join(process.cwd(), '.playwright', 'cli.config.json');
  if (!fs.existsSync(defaultPath)) return config;
  let user;
  try {
    user = JSON.parse(fs.readFileSync(defaultPath, 'utf8'));
  } catch {
    throw new Error(`Unable to parse ${defaultPath}: expected valid JSON.`);
  }
  if (!user || typeof user !== 'object' || Array.isArray(user))
    throw new Error(`Invalid ${defaultPath}: expected a config object.`);
  const userLaunch = { ...user.browser?.launchOptions };
  for (const key of ['executablePath', 'args', 'channel'])
    delete userLaunch[key];
  writeProviderNotice(process.stderr, `Merged ${path.relative(process.cwd(), defaultPath)} into the CloakBrowser config.`);
  return {
    ...user,
    ...config,
    browser: {
      ...user.browser,
      ...config.browser,
      launchOptions: { ...userLaunch, ...config.browser.launchOptions },
      contextOptions: { ...user.browser?.contextOptions, ...config.browser.contextOptions },
    },
  };
}

/**
 * @param {string[]} argv
 */
function firstCommand(argv) {
  return argv.find(arg => !arg.startsWith('-'));
}

/**
 * Decide whether the user explicitly configured a browser for this invocation.
 * Only real invocation-level intent (--browser, --config, PLAYWRIGHT_MCP_CONFIG)
 * skips the stealth providers. Ambient upstream environment variables such as
 * PLAYWRIGHT_MCP_BROWSER are set system-wide for other tools (e.g. playwright
 * MCP) and previously silenced provider selection entirely, launching a stock
 * headless Chromium whose UA leaks "HeadlessChrome" (issue #28). When our
 * providers activate they delete those ambient variables, so honoring them is
 * no longer needed for correctness.
 *
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 */
function hasExplicitBrowserConfig(argv, env) {
  if (env[configEnvName])
    return true;
  return hasFlag(argv, 'config') || hasFlag(argv, 'browser');
}

/**
 * @param {string[]} argv
 * @param {string} flag
 */
function hasFlag(argv, flag) {
  return argv.some(arg => arg === `--${flag}` || arg.startsWith(`--${flag}=`));
}

/**
 * @param {NodeJS.WriteStream} stderr
 * @param {string} message
 */
function writeProviderNotice(stderr, message) {
  stderr.write(`[playwright-cli] ${message}\n`);
}

/**
 * Build a platform-appropriate Chrome User-Agent string without the "Headless"
 * marker that anti-bot systems key on. CloakBrowser's --fingerprint flag should
 * handle this, but as a safety net we set an explicit non-headless UA so the
 * browser never sends "HeadlessChrome" even if the binary is a version whose
 * fingerprint engine predates the UA fix.
 *
 * @param {string} majorVersion - Chrome major version (e.g. "146")
 * @returns {string}
 */
function chromeUserAgent(majorVersion) {
  const platform = process.platform;
  let platformToken;
  if (platform === 'darwin')
    platformToken = 'Macintosh; Intel Mac OS X 10_15_7';
  else if (platform === 'win32')
    platformToken = 'Windows NT 10.0; Win64; x64';
  else
    platformToken = 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorVersion}.0.0.0 Safari/537.36`;
}

/**
 * Build Chromium launch args for DNS override flags. `--host-resolver-rules`
 * pins hostname→IP resolution (e.g. `MAP example.com 1.2.3.4`). There is no
 * stable Chromium flag for custom DNS servers; `--dns-servers` is accepted for
 * API compatibility but maps to `--host-resolver-rules` with an explicit
 * MAP rule.
 *
 * @param {ReturnType<typeof createProviderState> | undefined} state
 * @returns {string[]}
 */
function dnsLaunchArgs(state) {
  if (state?.hostResolverRules)
    return [`--host-resolver-rules=${state.hostResolverRules}`];
  return [];
}
/**
 * @param {string} provider
 * @param {(packageName: string) => string} [installedVersion]
 */
function providerVersion(provider, installedVersion = installedProviderVersion) {
  return installedVersion(provider);
}

/**
 * @param {string} packageName
 */
function installedProviderVersion(packageName) {
  // CloakBrowser exports only ESM entry points, not its package.json. Read the
  // installed manifest from Node's package search paths instead of reporting
  // a dependency range from our own manifest as an installed version.
  for (const directory of require.resolve.paths(packageName) ?? []) {
    const manifest = path.join(directory, packageName, 'package.json');
    if (!fs.existsSync(manifest))
      continue;
    const installed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (installed.name !== packageName || typeof installed.version !== 'string')
      throw new Error(`Invalid installed package manifest for '${packageName}'.`);
    return installed.version;
  }
  throw new Error(`Browser provider package '${packageName}' is not installed.`);
}

module.exports = {
  configureBrowserProvider,
  chromeUserAgent,
  createProviderState,
  resolveProvider,
  hasExplicitBrowserConfig,
  providerVersion,
};
