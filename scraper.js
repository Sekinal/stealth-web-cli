/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

// @ts-check

/**
 * Adaptable scraping built on Crawlee, rendered through the CloakBrowser
 * stealth provider. Complements the single-URL `goto`/`fetch` commands with
 * retry-aware, rate-limited crawling and structured extraction.
 *
 * `scrape <url>` renders one page; `--crawl` follows same-origin links with
 * deduplication, exponential-backoff retries and bounded concurrency. Rendered
 * content, extracted fields (--select/--schema), retry/attempt counts and
 * failed-request reports are emitted as structured output.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_MAX_REQUESTS = 20;
const DEFAULT_RETRIES = 3;
const DEFAULT_TIMEOUT_SECS = 60;
const DEFAULT_MAX_DEPTH = 10;

/**
 * Extract the origin (protocol + host + port) of a URL, or the input as-is
 * when it cannot be parsed.
 * @param {string} input
 */
function originOf(input) {
  try {
    const parsed = new URL(input);
    return parsed.origin;
  } catch {
    return input;
  }
}

const SCRAPE_HELP = `playwright-cli scrape <url>               scrape rendered content on stdout or --output=<file>
  --crawl                                 crawl the site following same-origin links
  --max-requests=<N>                      max pages (default 1, or 20 with --crawl)
  --max-depth=<N>                         max link depth to follow with --crawl
  --same-origin=true|false                only follow same-origin links (default true)
  --concurrency=<N> / --requests-per-minute=<N>
                                          parallel pages / request rate limit
  --select=<css>                          extract matching elements
  --output-format=json|text|markdown|csv  output format (default json)
  --schema=<json-file>                    extract fields: { field: { selector, attr?, all? } }
  --output=<file>                         write output to a file instead of stdout
  --timeout=<seconds> / --retry=<N>       navigation timeout / retries with backoff (default 60 / 3)`;


const DETECT_SELECTORS = {
  turnstile: '.cf-turnstile, [data-turnstile-widget], iframe[src*="challenges.cloudflare.com"]',
  recaptcha:
    '.g-recaptcha, [class*="g-recaptcha"], iframe[src*="recaptcha/api"], iframe[src*="google.com/recaptcha"], iframe[src*="recaptcha.net"]',
  hcaptcha: '.h-captcha, iframe[src*="hcaptcha.com"], iframe[src*="hcaptcha.net"], [data-hcaptcha-widget-id]',
};

/**
 * @param {string[]} argv
 */
function parseScrapeArgs(argv) {
  const { parseCliArgv } = require('./cliEnhancements');
  const { positional, flags } = parseCliArgv(
      argv.map(arg => arg === '-h' ? '--help' : arg), 'scrape',
      { help: true, crawl: true, 'same-origin': true, json: true });

  if (flags.help === true || flags.h === true) {
    return {
      help: true,
      url: null,
      crawl: false,
      maxRequests: 1,
      maxDepth: 0,
      concurrency: 1,
      requestsPerMinute: 0,
      sameOrigin: true,
      outputFormat: 'json',
      outputFile: null,
      select: null,
      schema: null,
      timeoutSecs: DEFAULT_TIMEOUT_SECS,
      retries: DEFAULT_RETRIES,
      hostResolverRules: undefined,
    };
  }

  const url = positional[0];
  if (typeof url !== 'string' || !url)
    throw new Error('scrape requires a URL (for example, scrape https://example.com).');
  if (!/^https?:\/\//i.test(url)) throw new Error(`Invalid URL '${url}': missing protocol. Use http:// or https://.`);

  const crawl = flags.crawl === true || flags.crawl === 'true';
  const maxRequests =
    flags['max-requests'] !== undefined
      ? Math.max(1, parseInt(String(flags['max-requests']), 10) || 1)
      : crawl
        ? DEFAULT_MAX_REQUESTS
        : 1;
  const maxDepth =
    flags['max-depth'] !== undefined ? Math.max(0, parseInt(String(flags['max-depth']), 10) || 0) : DEFAULT_MAX_DEPTH;
  const concurrency = flags.concurrency !== undefined ? Math.max(1, parseInt(String(flags.concurrency), 10) || 1) : 1;
  const requestsPerMinute =
    flags['requests-per-minute'] !== undefined ? Math.max(1, parseInt(String(flags['requests-per-minute']), 10) || 1) : 0;
  const sameOrigin = flags['same-origin'] !== 'false';
  const outputFormat = String(flags['output-format'] ?? 'json').toLowerCase();
  if (!['json', 'text', 'markdown', 'csv'].includes(outputFormat))
    throw new Error(
      `Unsupported --output-format '${flags['output-format']}'. Expected one of: json, text, markdown, csv.`,
    );

  return {
    url,
    origin: originOf(url),
    crawl,
    maxRequests,
    maxDepth,
    concurrency,
    requestsPerMinute,
    sameOrigin,
    outputFormat,
    outputFile: typeof flags.output === 'string' && flags.output ? flags.output : null,
    select: typeof flags.select === 'string' && flags.select ? flags.select : null,
    schema: typeof flags.schema === 'string' && flags.schema ? flags.schema : null,
    timeoutSecs:
      flags.timeout !== undefined
        ? Math.max(1, parseInt(String(flags.timeout), 10) || DEFAULT_TIMEOUT_SECS)
        : DEFAULT_TIMEOUT_SECS,
    retries: flags.retry !== undefined ? Math.max(0, parseInt(String(flags.retry), 10) || 0) : DEFAULT_RETRIES,
    hostResolverRules: argvFlagValue(argv, 'host-resolver-rules'),
  };
}

/**
 * @param {string[]} argv
 * @param {string} flag
 */
function argvFlagValue(argv, flag) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${flag}`) return argv[i + 1];
    if (argv[i].startsWith(`--${flag}=`)) return argv[i].slice(`--${flag}=`.length);
  }
  return undefined;
}

/**
 * @param {string} schemaFile
 */
function loadSchema(schemaFile) {
  const raw = fs.readFileSync(schemaFile, 'utf8');
  let schema;
  try {
    schema = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid --schema JSON in '${schemaFile}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!schema || typeof schema !== 'object' || Array.isArray(schema))
    throw new Error(`Invalid --schema '${schemaFile}': expected an object of field extractors.`);
  for (const [name, extractor] of Object.entries(schema)) {
    if (!extractor || typeof extractor !== 'object' || typeof extractor.selector !== 'string')
      throw new Error(`Invalid --schema field '${name}': expected { selector, attr?, all? }.`);
  }
  return schema;
}

/**
 * Extract fields from the rendered page according to a schema.
 * @param {import('crawlee').PlaywrightCrawlingContext} context
 * @param {Record<string, { selector: string, attr?: string | undefined, all?: boolean | undefined }>} schema
 */
async function extractBySchema(context, schema) {
  const result = {};
  for (const [name, extractor] of Object.entries(schema)) {
    const { selector, attr, all } = extractor;
    const attrName = attr ?? null;
    if (all) {
      result[name] = await context.page.$$eval(
        selector,
        (elements, opts) =>
          elements.slice(0, 2000).map((el) => {
            if (opts.attr) return el.getAttribute(opts.attr);
            const node = /** @type {HTMLElement} */ (el);
            return (node.innerText ?? el.textContent ?? '').trim();
          }),
        { attr: attrName },
      );
    } else {
      result[name] = await context.page
        .$eval(
          selector,
          (el, opts) => {
            if (opts.attr) return el.getAttribute(opts.attr);
            const node = /** @type {HTMLElement} */ (el);
            return (node.innerText ?? el.textContent ?? '').trim();
          },
          { attr: attrName },
        )
        .catch(() => null);
    }
  }
  return result;
}

/**
 * Select matching elements as records (text, html, attributes).
 * @param {import('crawlee').PlaywrightCrawlingContext} context
 * @param {string} selector
 */
async function selectElements(context, selector) {
  return context.page.$$eval(selector, (elements) =>
    elements.slice(0, 5000).map((el) => {
      const node = /** @type {HTMLElement} */ (el);
      return {
        text: (node.innerText ?? el.textContent ?? '').trim(),
        html: el.outerHTML,
        attrs: Object.fromEntries([...el.attributes].map((attribute) => [attribute.name, attribute.value])),
      };
    }),
  );
}

/**
 * @param {import('crawlee').PlaywrightCrawlingContext} context
 */
async function getTextContent(context) {
  return context.page.evaluate(() => (document.body ? document.body.innerText.slice(0, 200000) : '')).catch(() => '');
}

/**
 * @param {import('crawlee').PlaywrightCrawlingContext} context
 */
async function getLinks(context) {
  return context.page
    .evaluate(() =>
      [...document.querySelectorAll('a[href]')]
        .map((anchor) => /** @type {HTMLAnchorElement} */ (anchor).href)
        .filter((hrefText) => /^https?:\/\//i.test(hrefText))
        .slice(0, 5000),
    )
    .catch(() => []);
}

/**
 * Detect an anti-bot challenge on the rendered page (DOM widgets + text/status).
 * @param {import('crawlee').PlaywrightCrawlingContext} context
 * @param {number | null} status
 * @returns {Promise<{ type: string, blocked: boolean, solved?: boolean }>}
 */
async function detectRenderedChallenge(context, status) {
  try {
    const dom = await context.page.evaluate((selectors) => {
      const has = (selector) => !!document.querySelector(selector);
      return {
        turnstile: has(selectors.turnstile),
        recaptcha: has(selectors.recaptcha),
        hcaptcha: has(selectors.hcaptcha),
      };
    }, DETECT_SELECTORS);
    if (dom.turnstile) return { type: 'turnstile', blocked: true };
    if (dom.recaptcha) return { type: 'recaptcha', blocked: true };
    if (dom.hcaptcha) return { type: 'hcaptcha', blocked: true };
  } catch {
    // Page may be mid-navigation; fall through to text/status detection.
  }
  const { detectChallengeFromText } = require('./cliEnhancements');
  const bodyText = await getTextContent(context);
  const title = await context.page.title().catch(() => '');
  const detected = detectChallengeFromText(title, bodyText, status);
  // Only genuine challenge signals (widget, marker text, 403/429) block a
  // page; ordinary HTTP errors (404/500...) are reported as content with a
  // non-2xx status rather than redacted as anti-bot.
  if (detected.type !== 'none') return detected;
  return { type: 'none', blocked: false };
}

/**
 * Attempt to solve a rendered challenge via CapSolver and inject the token.
 * No-op when no CAPSOLVER_API_KEY is configured.
 *
 * @param {import('crawlee').PlaywrightCrawlingContext} context
 * @param {{ type: string, blocked: boolean }} challenge
 * @param {number} timeoutMs
 */
async function solveRenderedChallenge(context, challenge, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const apiKey = process.env.CAPSOLVER_API_KEY;
  if (!apiKey) return false;
  const sitekey = await context.page
    .evaluate(() => {
      const element = document.querySelector('[data-sitekey]');
      if (element && element.getAttribute('data-sitekey')) return element.getAttribute('data-sitekey');
      return null;
    })
    .catch(() => null);
  if (!sitekey) return false;
  const tokenSelector =
    challenge.type === 'turnstile'
      ? '[name="cf-turnstile-response"]'
      : challenge.type === 'hcaptcha'
        ? '[name="h-captcha-response"], textarea[name="h-captcha-response"]'
        : '[name="g-recaptcha-response"], textarea[name="g-recaptcha-response"]';
  const taskType =
    challenge.type === 'turnstile'
      ? 'AntiTurnstileTaskProxyLess'
      : challenge.type === 'hcaptcha'
        ? 'HCaptchaTaskProxyLess'
        : 'ReCaptchaV2TaskProxyLess';
  const solverUrl = process.env.CAPSOLVER_API_URL || 'https://api.capsolver.com';
  try {
    const createResponse = await context.page.request.post(`${solverUrl}/createTask`, {
      timeout: Math.max(1, deadline - Date.now()),
      data: { clientKey: apiKey, task: { type: taskType, websiteURL: context.page.url(), websiteKey: sitekey } },
    });
    const createJson = await createResponse.json();
    if (createJson.errorId !== 0) return false;
    for (let i = 0; i < 40 && Date.now() < deadline; i++) {
      const resultResponse = await context.page.request.post(`${solverUrl}/getTaskResult`, {
        timeout: Math.max(1, deadline - Date.now()),
        data: { clientKey: apiKey, taskId: createJson.taskId },
      });
      const resultJson = await resultResponse.json();
      if (resultJson.status === 'ready' && (resultJson.solution?.token ?? resultJson.solution?.gRecaptchaResponse)) {
        const token = resultJson.solution.token ?? resultJson.solution.gRecaptchaResponse;
        const injected = await context.page.evaluate(
          ({ selector, value }) => {
            const element = /** @type {HTMLInputElement | HTMLTextAreaElement} */ (document.querySelector(selector));
            if (element) {
              element.value = value;
              element.dispatchEvent(new Event('input', { bubbles: true }));
              element.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }
            return false;
          },
          { selector: tokenSelector, value: token },
        );
        if (!injected) return false;
        while (Date.now() < deadline) {
          if (!(await detectRenderedChallenge(context, null)).blocked) return true;
          await context.page.waitForTimeout(100);
        }
        return false;
      }
      await context.page.waitForTimeout(Math.min(3000, Math.max(0, deadline - Date.now())));
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Convert the conventional proxy env vars into a Playwright launchOptions.proxy.
 * @param {NodeJS.ProcessEnv} env
 */
function proxyForEnv(env) {
  const server = env.PLAYWRIGHT_MCP_PROXY_SERVER || env.HTTPS_PROXY || env.HTTP_PROXY;
  const bypass = env.PLAYWRIGHT_MCP_PROXY_BYPASS || env.NO_PROXY;
  if (!server) return null;
  const bypassList = bypass
    ? bypass
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .join(',')
    : undefined;
  try {
    const parsed = new URL(server.includes('://') ? server : `http://${server}`);
    return {
      server: `${parsed.protocol}//${parsed.host}`,
      ...(bypassList ? { bypass: bypassList } : {}),
      ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
      ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    };
  } catch {
    return { server, ...(bypassList ? { bypass: bypassList } : {}) };
  }
}

/**
 * Build the CloakBrowser launch config for the crawler, carrying the stealth
 * invariants: non-Headless UA, DNS override flags and proxy details.
 *
 * @param {ReturnType<typeof parseScrapeArgs>} plan
 */
async function buildLaunchConfig(plan) {
  const cloakbrowser = await import('cloakbrowser');
  const launchOptions = await cloakbrowser.buildLaunchOptions();
  launchOptions.headless = true;
  const dnsArgs = plan.hostResolverRules ? [`--host-resolver-rules=${plan.hostResolverRules}`] : [];
  if (dnsArgs.length) launchOptions.args = [...(launchOptions.args ?? []), ...dnsArgs];
  const proxy = proxyForEnv(process.env);
  if (proxy) launchOptions.proxy = proxy;
  // Crawlee injects a local forwarding proxy even without a configured proxy.
  // Its upstream sockets can outlive a timed-out navigation and keep the CLI
  // alive. Direct crawls do not need that forwarding layer.
  if (!launchOptions.proxy)
    launchOptions.args = [...(launchOptions.args ?? []), '--no-proxy-server'];
  const { chromeUserAgent, fingerprintPlatform } = require('./browserProviders');
  const majorVersion = cloakbrowser.CHROMIUM_VERSION.split('.')[0];
  return { launchOptions, userAgent: chromeUserAgent(majorVersion, fingerprintPlatform(launchOptions)) };
}

/**
 * @param {ReturnType<typeof parseScrapeArgs>} plan
 */
function createScrapeState(plan) {
  return { plan, results: [], failedRequests: [], blocked: 0 };
}

/**
 * @param {ReturnType<typeof parseScrapeArgs>} plan
 * @param {ReturnType<typeof createScrapeState>} state
 * @param {{ launchOptions: any, userAgent: string }} launchConfig
 * @param {Record<string, { selector: string, attr?: string | undefined, all?: boolean | undefined }> | null} schema
 */
async function buildScrapeCrawler(plan, state, launchConfig, schema) {
  process.env.CRAWLEE_LOG_LEVEL = process.env.CRAWLEE_LOG_LEVEL || 'OFF';
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stealth-web-cli-scrape-'));
  process.env.CRAWLEE_STORAGE_DIR = storageDir;
  process.once('exit', () => {
    try {
      fs.rmSync(storageDir, { recursive: true, force: true });
    } catch {}
  });
  const { PlaywrightCrawler, EnqueueStrategy } = require('crawlee');
  const crawler = new PlaywrightCrawler({
    maxConcurrency: plan.concurrency,
    maxRequestsPerCrawl: plan.maxRequests,
    maxRequestRetries: plan.retries,
    maxRequestsPerMinute: plan.requestsPerMinute || undefined,
    requestHandlerTimeoutSecs: plan.timeoutSecs,
    // Bound navigation and session rotation so --timeout=1 / --retry=0 really
    // mean one fast attempt per URL (no unbounded Crawlee-native retries).
    navigationTimeoutSecs: plan.timeoutSecs,
    maxSessionRotations: plan.retries,
    // Let the challenge detector classify blocked responses (403/429) instead
    // of Crawlee failing them outright, so types and redaction stay ours.
    sessionPoolOptions: { blockedStatusCodes: [] },
    launchContext: {
      launchOptions: launchConfig.launchOptions,
      userAgent: launchConfig.userAgent,
    },
    errorHandler: async ({ request }) => {
      await new Promise(resolve => setTimeout(resolve, Math.min(500 * 2 ** request.retryCount, 5000)));
    },
    requestHandler: async (context) => {
      const { request } = context;
      const depth = Number(request.userData?.depth ?? 0);
      const startedAt = Date.now();
      const status = typeof context.response?.status === 'function' ? context.response.status() : null;
      const url = context.page.url();
      const title = await context.page.title().catch(() => '');
      // Same-origin boundary is enforced on the *final* URL: a link that
      // redirected to another origin (host or port) is dropped here, so it is
      // never captured as content.
      if (plan.sameOrigin && originOf(url) !== plan.origin) return;
      let challenge = await detectRenderedChallenge(context, status);
      if (challenge.blocked && (await solveRenderedChallenge(context, challenge, plan.timeoutSecs * 500))) {
        // Success requires observing the page unblocked after token injection.
        challenge = { ...challenge, blocked: false, solved: true };
      }
      if (challenge.blocked) {
        if (request.retryCount < plan.retries) {
          const { RetryRequestError } = require('crawlee');
          throw new RetryRequestError(`Challenge detected (${challenge.type}); retrying`);
        }
        // Final attempt: never capture challenge content — redact body/html.
        state.blocked++;
        state.results.push({
          type: 'result',
          url,
          title,
          status,
          depth,
          text: '',
          html: '',
          links: [],
          challenge,
          attempts: request.retryCount + 1,
          retried: request.retryCount > 0,
          retries: request.retryCount,
          durationMs: Date.now() - startedAt,
          requestId: request.id,
          blocked: true,
        });
      } else {
        const text = await getTextContent(context);
        const failed = (status !== null && status >= 400) || !text.trim();
        if (((status !== null && status >= 500) || !text.trim()) && request.retryCount < plan.retries)
          throw new Error(status !== null && status >= 500 ? `HTTP ${status}; retrying` : 'Empty body; retrying');
        const html = await context.page.content().catch(() => '');
        const record = {
          type: 'result',
          failed,
          url,
          title,
          status,
          depth,
          text,
          html,
          links: await getLinks(context),
          challenge,
          attempts: request.retryCount + 1,
          retried: request.retryCount > 0,
          retries: request.retryCount,
          durationMs: Date.now() - startedAt,
          requestId: request.id,
        };
        if (plan.select) record.selected = await selectElements(context, plan.select);
        if (schema) record.extracted = await extractBySchema(context, schema);
        state.results.push(record);
      }
      if (!challenge.blocked && plan.crawl && depth < plan.maxDepth) {
        const links = await getLinks(context);
        if (plan.sameOrigin) {
          // Origin boundary (scheme+host+port), stricter than hostname-only.
          await context.enqueueLinks({
            urls: links.filter((link) => originOf(link) === plan.origin),
            userData: { depth: depth + 1 },
          });
        } else {
          await context.enqueueLinks({ strategy: EnqueueStrategy.All, userData: { depth: depth + 1 } });
        }
      }
    },
    failedRequestHandler: async ({ request }, error) => {
      state.failedRequests.push({
        url: request.url,
        error: error ? error.message : String(error),
        attempts: (request.retryCount ?? 0) + 1,
      });
    },
  });
  return crawler;
}

/**
 * Render a scrape payload in the requested output format. Crawl summaries have
 * only `results` (no scalar text), so text/markdown join per-page content.
 *
 * @param {any} payload
 * @param {string} format
 * @param {boolean} crawl
 */
function formatScrape(payload, format, crawl) {
  if (format === 'json') return JSON.stringify(payload, null, 2);
  if (format === 'csv') {
    const records = crawl ? payload.results : [payload];
    const rows = [];
    for (const record of records) {
      if (record.extracted) {
        rows.push(record.extracted);
      } else if (record.selected) {
        // Flatten each selected element into its own row (text/html/attrs).
        for (const element of record.selected)
          rows.push({ text: element.text, html: element.html, ...element.attrs });
      }
    }
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    if (!columns.length) throw new Error('CSV output requires --select or --schema extraction.');
    const escape = (value) => {
      const text = Array.isArray(value) ? value.join(' ') : value == null ? '' : String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = [columns.map(escape).join(',')];
    for (const row of rows) lines.push(columns.map((column) => escape(row[column])).join(','));
    return lines.join('\n');
  }
  const records = crawl ? payload.results : [payload];
  const sections = records
    .filter((record) => !record.blocked)
    .map((record) =>
      format === 'text' ? (record.text ?? '') : `# ${record.title ?? ''}\n\n${record.text ?? ''}`.trim(),
    );
  return format === 'text' ? sections.join('\n\n---\n\n') : sections.join('\n\n---\n\n');
}

/**
 * Run the full scrape and emit the result. Blocked/failed outcomes exit nonzero.
 * @param {string[]} argv
 */
async function runScrape(argv) {
  const plan = parseScrapeArgs(argv);
  if (plan.help) {
    console.log(SCRAPE_HELP);
    return;
  }
  const state = createScrapeState(plan);
  const startedAt = Date.now();
  const schema = plan.schema ? loadSchema(plan.schema) : null;
  const launchConfig = await buildLaunchConfig(plan);
  const crawler = await buildScrapeCrawler(plan, state, launchConfig, schema);
  await crawler.run([plan.url]);

  const failedCount = state.failedRequests.length;
  let payload = /** @type {any} */ (null);
  if (plan.crawl) {
    payload = {
      startUrl: plan.url,
      results: state.results,
      requestsProcessed: state.results.length,
      blocked: state.blocked,
      failedRequests: state.failedRequests,
      durationMs: Date.now() - startedAt,
    };
    payload.ok = state.blocked === 0 && failedCount === 0 && state.results.length > 0 && !state.results.some(record => record.failed);
  } else if (state.results.length) {
    payload = state.results[0];
    payload.ok = !payload.failed && !payload.blocked && !payload.challenge?.blocked && (payload.status === null || payload.status < 400);
  } else {
    const failed = state.failedRequests[0];
    payload = failed
      ? {
          url: failed.url,
          title: null,
          status: null,
          text: '',
          html: '',
          links: [],
          challenge: { type: 'none', blocked: false },
          attempts: failed.attempts,
          retried: failed.attempts > 1,
          retries: failed.attempts - 1,
          durationMs: Date.now() - startedAt,
          error: failed.error,
        }
      : {
          url: plan.url,
          title: null,
          status: null,
          text: '',
          html: '',
          links: [],
          challenge: null,
          attempts: 1,
          retried: false,
          retries: 0,
          durationMs: 0,
        };
    payload.ok = false;
  }

  if (!payload.ok) process.exitCode = 1;

  const rendered = formatScrape(payload, plan.outputFormat, plan.crawl);
  if (plan.outputFile) fs.writeFileSync(plan.outputFile, rendered);
  else process.stdout.write(rendered + (rendered.endsWith('\n') ? '' : '\n'));
}

module.exports = {
  parseScrapeArgs,
  runScrape,
};
