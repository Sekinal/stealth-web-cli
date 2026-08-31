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
  const positional = [];
  const flags = {};
  for (const arg of argv) {
    if (arg === 'scrape') continue;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      flags[key] = eq === -1 ? true : arg.slice(eq + 1);
      continue;
    }
    positional.push(arg);
  }

  const url = positional[0];
  if (typeof url !== 'string' || !url)
    throw new Error('scrape requires a URL (for example, scrape https://example.com).');
  if (!/^https?:\/\//i.test(url)) throw new Error(`Invalid URL '${url}': missing protocol. Use http:// or https://.`);

  const crawl = flags.crawl === true;
  const maxRequests =
    flags['max-requests'] !== undefined
      ? Math.max(1, parseInt(flags['max-requests'], 10) || 1)
      : crawl
        ? DEFAULT_MAX_REQUESTS
        : 1;
  const maxDepth =
    flags['max-depth'] !== undefined ? Math.max(0, parseInt(flags['max-depth'], 10) || 0) : DEFAULT_MAX_DEPTH;
  const concurrency = flags.concurrency !== undefined ? Math.max(1, parseInt(flags.concurrency, 10) || 1) : 1;
  const requestsPerMinute =
    flags['requests-per-minute'] !== undefined ? Math.max(1, parseInt(flags['requests-per-minute'], 10) || 1) : 0;
  const sameOrigin = flags['same-origin'] !== 'false';
  const outputFormat = (flags['output-format'] ?? 'json').toLowerCase();
  if (!['json', 'text', 'markdown', 'csv'].includes(outputFormat))
    throw new Error(
      `Unsupported --output-format '${flags['output-format']}'. Expected one of: json, text, markdown, csv.`,
    );

  return {
    url,
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
        ? Math.max(1, parseInt(flags.timeout, 10) || DEFAULT_TIMEOUT_SECS)
        : DEFAULT_TIMEOUT_SECS,
    retries: flags.retry !== undefined ? Math.max(0, parseInt(flags.retry, 10) || 0) : DEFAULT_RETRIES,
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
  if (detected.type !== 'none') return detected;
  return status !== null && status >= 400
    ? { type: `http-${status}`, blocked: true }
    : { type: 'none', blocked: false };
}

/**
 * Attempt to solve a rendered challenge via CapSolver and inject the token.
 * No-op when no CAPSOLVER_API_KEY is configured.
 *
 * @param {import('crawlee').PlaywrightCrawlingContext} context
 * @param {{ type: string, blocked: boolean }} challenge
 */
async function solveRenderedChallenge(context, challenge) {
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
      data: { clientKey: apiKey, task: { type: taskType, websiteURL: context.page.url(), websiteKey: sitekey } },
    });
    const createJson = await createResponse.json();
    if (createJson.errorId !== 0) return false;
    for (let i = 0; i < 40; i++) {
      const resultResponse = await context.page.request.post(`${solverUrl}/getTaskResult`, {
        data: { clientKey: apiKey, taskId: createJson.taskId },
      });
      const resultJson = await resultResponse.json();
      if (resultJson.status === 'ready' && (resultJson.solution?.token ?? resultJson.solution?.gRecaptchaResponse)) {
        const token = resultJson.solution.token ?? resultJson.solution.gRecaptchaResponse;
        await context.page.evaluate(
          ({ selector, value }) => {
            const element = /** @type {HTMLInputElement | HTMLTextAreaElement} */ (document.querySelector(selector));
            if (element) {
              element.value = value;
              element.dispatchEvent(new Event('input', { bubbles: true }));
              element.dispatchEvent(new Event('change', { bubbles: true }));
            }
          },
          { selector: tokenSelector, value: token },
        );
        return true;
      }
      await context.page.waitForTimeout(3000);
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
  if (!server) return null;
  try {
    const parsed = new URL(server.includes('://') ? server : `http://${server}`);
    return {
      server: `${parsed.protocol}//${parsed.host}`,
      ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
      ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    };
  } catch {
    return { server };
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
  const { chromeUserAgent } = require('./browserProviders');
  const majorVersion = cloakbrowser.CHROMIUM_VERSION.split('.')[0];
  return { launchOptions, userAgent: chromeUserAgent(majorVersion) };
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
    // Let the challenge detector classify blocked responses (403/429) instead
    // of Crawlee failing them outright, so types and redaction stay ours.
    sessionPoolOptions: { blockedStatusCodes: [] },
    launchContext: {
      launchOptions: launchConfig.launchOptions,
      userAgent: launchConfig.userAgent,
    },
    requestHandler: async (context) => {
      const { request } = context;
      const depth = Number(request.userData?.depth ?? 0);
      const startedAt = Date.now();
      const status = typeof context.response?.status === 'function' ? context.response.status() : null;
      const url = context.page.url();
      const title = await context.page.title().catch(() => '');
      let challenge = await detectRenderedChallenge(context, status);
      if (challenge.blocked && (await solveRenderedChallenge(context, challenge)))
        challenge = await detectRenderedChallenge(context, status);
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
        const html = await context.page.content().catch(() => '');
        const record = {
          type: 'result',
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
      if (plan.crawl && depth < plan.maxDepth) {
        await context.enqueueLinks({
          strategy: plan.sameOrigin ? EnqueueStrategy.SameHostname : EnqueueStrategy.All,
          userData: { depth: depth + 1 },
        });
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
    const rows = records.flatMap(
      (record) => record.extracted ?? (record.selected ? { selected: record.selected } : {}),
    );
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    if (!columns.length) throw new Error('CSV output requires --select or --schema extraction.');
    const escape = (value) => {
      const text = Array.isArray(value) ? value.join(' | ') : value == null ? '' : String(value);
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
    payload.ok = state.blocked === 0 && failedCount === 0 && state.results.length > 0;
  } else if (state.results.length) {
    payload = state.results[0];
    payload.ok = !payload.blocked && !payload.challenge?.blocked && (payload.status === null || payload.status < 400);
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
          challenge: { type: 'blocked', blocked: true },
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
