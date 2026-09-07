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
const fallbackEnvName = 'PLAYWRIGHT_CLI_BROWSER_PROVIDER_FALLBACK';
const configEnvName = 'PLAYWRIGHT_MCP_CONFIG';

// CloakBrowser is the sole browser provider. Patchright and Camoufox were
// removed; PLAYWRIGHT_CLI_BROWSER_PROVIDER only accepts 'cloakbrowser' now.
const defaultProviderOrder = ['cloakbrowser'];
const validProviders = new Set(defaultProviderOrder);

/**
 * @param {{
 *   argv?: string[],
 *   command?: string,
 *   env?: NodeJS.ProcessEnv,
 *   sessionModule: { Session?: { startDaemon?: Function } },
 *   stderr?: NodeJS.WriteStream,
 *   activateProvider?: typeof activateProvider,
 * }} options
 */
async function configureBrowserProviderFallbacks(options) {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const command = options.command ?? firstCommand(argv);
  const state = createProviderState(command, argv, env);
  if (!state.enabled)
    return { enabled: false };

  const sessionClass = options.sessionModule.Session;
  if (!sessionClass || typeof sessionClass.startDaemon !== 'function')
    throw new Error('Unable to configure browser providers: Session.startDaemon was not found.');

  const originalStartDaemon = /** @type {typeof sessionClass.startDaemon & { __browserProviderFallbacks?: boolean }} */ (sessionClass.startDaemon);
  if (originalStartDaemon.__browserProviderFallbacks)
    return { enabled: true, providers: state.providers };

  const stderr = options.stderr ?? process.stderr;
  const activate = options.activateProvider ?? activateProvider;
  delete env[fallbackEnvName];
  let providerIndex = await activateFirstAvailableProvider(state, env, stderr, activate);

  sessionClass.startDaemon = async function(/** @type {any[]} */ ...args) {
    // Issue #37: a config file at the default path (.playwright/cli.config.json)
    // is promoted to a CLI-level override that shadows PLAYWRIGHT_MCP_CONFIG,
    // silently reverting the daemon to vanilla Chrome. Forward the generated
    // provider config as an explicit --config so the daemon's CLI-level configFile
    // (daemonOverrides) wins over the promoted default-path file instead.
    const cliArgs = /** @type {any} */ (args?.[1]);
    if (cliArgs && typeof cliArgs === 'object' && !cliArgs.config) {
      const generatedConfig = env[configEnvName];
      if (generatedConfig) cliArgs.config = generatedConfig;
    }
    let lastError;
    while (providerIndex < state.providers.length) {
      const provider = state.providers[providerIndex];
      try {
        return await originalStartDaemon.apply(this, args);
      } catch (error) {
        lastError = error;
        const existingFallback = readProviderFallback(env);
        const failures = [
          ...(existingFallback?.reason ? [existingFallback.reason] : []),
          `${provider}: ${formatProviderError(error)}`,
        ];
        providerIndex++;
        let activated = false;
        const nextProvider = state.providers[providerIndex];
        if (nextProvider)
          writeProviderNotice(stderr, `Browser provider '${provider}' failed (${formatProviderError(error)}); falling back to '${nextProvider}'.`);
        while (providerIndex < state.providers.length) {
          const candidate = state.providers[providerIndex];
          try {
            await activate(state, candidate, env);
            setProviderFallback(env, existingFallback?.requested ?? state.providers[0], candidate, failures);
            activated = true;
            break;
          } catch (activationError) {
            lastError = activationError;
            failures.push(`${candidate}: ${formatProviderError(activationError)}`);
            const followingProvider = state.providers[providerIndex + 1];
            if (followingProvider)
              writeProviderNotice(stderr, `Browser provider '${candidate}' is unavailable (${formatProviderError(activationError)}); falling back to '${followingProvider}'.`);
            providerIndex++;
          }
        }
        if (!activated)
          break;
      }
    }
    throw lastError;
  };
  /** Marker so repeated configuration is a no-op. */
  const taggedDaemon = /** @type {typeof sessionClass.startDaemon & { __browserProviderFallbacks?: boolean }} */ (sessionClass.startDaemon);
  taggedDaemon.__browserProviderFallbacks = true;

  return { enabled: true, providers: state.providers };
}

/**
 * @param {string | undefined} command
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @returns {{
 *   enabled: boolean,
 *   providers: string[],
 *   originalConfig?: string | undefined,
 *   configDir?: string,
 *   configPaths?: Map<string, string>,
 *   hostResolverRules?: string | undefined,
 *   dnsServers?: string | undefined,
 * }}
 */
function createProviderState(command, argv, env) {
  const providerOverride = env[providerEnvName];
  if (command !== 'open')
    return { enabled: false, providers: [] };
  if (!providerOverride && hasExplicitBrowserConfig(argv, env))
    return { enabled: false, providers: [] };
  const providers = resolveProviderOrder(providerOverride);
  return {
    enabled: providers.length > 0,
    providers,
    originalConfig: env[configEnvName],
    configDir: createConfigDir(),
    configPaths: new Map(),
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
function resolveProviderOrder(providerOverride) {
  if (!providerOverride || providerOverride === 'auto')
    return defaultProviderOrder;
  const providers = providerOverride.split(',').map(provider => provider.trim()).filter(Boolean);
  for (const provider of providers) {
    if (provider === 'patchright' || provider === 'camoufox')
      throw new Error(`Browser provider '${provider}' was removed. CloakBrowser is the sole browser provider.`);
    if (!validProviders.has(provider))
      throw new Error(`Unsupported ${providerEnvName}: ${provider}. Expected one of ${[...validProviders].join(', ')}.`);
  }
  return providers;
}

/**
 * @param {ReturnType<typeof createProviderState>} state
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.WriteStream} stderr
 * @param {typeof activateProvider} activate
 */
async function activateFirstAvailableProvider(state, env, stderr, activate = activateProvider) {
  let lastError;
  const failures = [];
  for (let i = 0; i < state.providers.length; i++) {
    try {
      await activate(state, state.providers[i], env);
      if (failures.length)
        setProviderFallback(env, state.providers[0], state.providers[i], failures);
      return i;
    } catch (error) {
      lastError = error;
      failures.push(`${state.providers[i]}: ${formatProviderError(error)}`);
      const nextProvider = state.providers[i + 1];
      if (nextProvider)
        writeProviderNotice(stderr, `Browser provider '${state.providers[i]}' is unavailable (${formatProviderError(error)}); falling back to '${nextProvider}'.`);
    }
  }
  throw lastError;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} requested
 * @param {string} active
 * @param {string[]} reasons
 */
function setProviderFallback(env, requested, active, reasons) {
  env[fallbackEnvName] = JSON.stringify({ requested, active, reason: reasons.join('; ') });
}

/**
 * @param {NodeJS.ProcessEnv} env
 */
function readProviderFallback(env) {
  try {
    const value = JSON.parse(env[fallbackEnvName] ?? '');
    if (typeof value.requested === 'string' && typeof value.active === 'string' && typeof value.reason === 'string')
      return value;
  } catch {
  }
  return undefined;
}

/**
 * @param {ReturnType<typeof createProviderState>} state
 * @param {string} provider
 * @param {NodeJS.ProcessEnv} env
 */
async function activateProvider(state, provider, env) {
  // Once provider selection is enabled, do not let ambient upstream browser
  // settings override its generated config inside the daemon.
  delete env.PLAYWRIGHT_MCP_BROWSER;
  delete env.PLAYWRIGHT_MCP_EXECUTABLE_PATH;
  env[activeProviderEnvName] = provider;
  env[configEnvName] = await configPathForProvider(state, provider);
}

/**
 * @param {ReturnType<typeof createProviderState>} state
 * @param {string} provider
 */
async function configPathForProvider(state, provider) {
  const configPaths = state.configPaths ?? new Map();
  const configDir = state.configDir ?? createConfigDir();
  const existingPath = configPaths.get(provider);
  if (existingPath)
    return existingPath;

  const config = await configForProvider(provider, state);
  const configPath = path.join(configDir, `${provider}.json`);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  configPaths.set(provider, configPath);
  return configPath;
}

/**
 * @param {string} provider
 * @param {ReturnType<typeof createProviderState>} [state]
 */
async function configForProvider(provider, state) {
  const launchArgs = dnsLaunchArgs(state);
  if (provider === 'cloakbrowser') {
    const { buildLaunchOptions, CHROMIUM_VERSION } = await import('cloakbrowser');
    const majorVersion = CHROMIUM_VERSION.split('.')[0];
    const ua = chromeUserAgent(majorVersion);
    const launchOptions = await buildLaunchOptions();
    if (launchArgs.length)
      launchOptions.args = [...(launchOptions.args ?? []), ...launchArgs];
    return mergeDefaultPathConfig({
      browser: {
        browserName: 'chromium',
        launchOptions,
        contextOptions: { userAgent: ua },
      },
    });
  }

  throw new Error(`Provider '${provider}' does not use a generated config.`);
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
 * @param {unknown} error
 */
function formatProviderError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim() || 'unknown error';
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
  try {
    return installedVersion(provider);
  } catch {
    const packageJson = /** @type {{ dependencies?: Record<string, string>, optionalDependencies?: Record<string, string> }} */ (require('./package.json'));
    const version = packageJson.dependencies?.[provider] ?? packageJson.optionalDependencies?.[provider];
    if (!version)
      throw new Error(`Unable to determine the installed or declared version of browser provider '${provider}'.`);
    return version;
  }
}

/**
 * @param {string} packageName
 */
function installedProviderVersion(packageName) {
  return require(`${packageName}/package.json`).version;
}

module.exports = {
  configureBrowserProviderFallbacks,
  chromeUserAgent,
  createProviderState,
  resolveProviderOrder,
  hasExplicitBrowserConfig,
  formatProviderError,
  providerVersion,
  readProviderFallback,
};
