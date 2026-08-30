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
const path = require('path');

const DETECT_SELECTORS = {
  turnstile: '.cf-turnstile, [data-turnstile-widget], iframe[src*="challenges.cloudflare.com"]',
  recaptcha: '.g-recaptcha, [class*="g-recaptcha"], iframe[src*="recaptcha/api"], iframe[src*="google.com/recaptcha"], iframe[src*="recaptcha.net"]',
  hcaptcha: '.h-captcha, iframe[src*="hcaptcha.com"], iframe[src*="hcaptcha.net"], [data-hcaptcha-widget-id]',
};

/**
 * @param {string[]} argv
 */
function parseScrapeArgs(argv) {
  const positional = [];
  const flags = {};
  for (const arg of argv) {
    if (arg === 'scrape')
      continue;
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
  if (!/^https?:\/\//i.test(url))
    throw new Error(`Invalid URL '${url}': missing protocol. Use http:// or https://.`);
  const maxRequests = flags['max-requests'] !== undefined ? Math.max(1, parseInt(flags['max-requests'], 10) || 1) : (flags.crawl === true ? 20 : 1);
  const maxDepth = flags['max-depth'] !== undefined ? Math.max(0, parseInt(flags['max-depth'], 10) || 0) : 10;
  const concurrency = flags.concurrency !== undefined ? Math.max(1, parseInt(flags.concurrency, 10) || 1) : 1;
  const sameOrigin = flags['same-origin'] !== 'false';
  const outputFormat = (flags['output-format'] ?? 'json').toLowerCase();
  if (!['json', 'text', 'markdown', 'csv'].includes(outputFormat))
    throw new Error(`Unsupported --output-format '${flags['output-format']}'. Expected one of: json, text, markdown, csv.`);
  return {
    url,
    crawl: flags.crawl === true,
    maxRequests,
    maxDepth,
    concurrency,
    sameOrigin,
    outputFormat,
    outputFile: typeof flags.output === 'string' && flags.output ? flags.output : null,
    select: typeof flags.select === 'string' && flags.select ? flags.select : null,
    schema: typeof flags.schema === 'string' && flags.schema ? flags.schema : null,
    timeoutSecs: flags.timeout !== undefined ? Math.max(1, parseInt(flags.timeout, 10) || 60) : 60,
    retries: flags.retry !== undefined ? Math.max(0, parseInt(flags.retry, 10) || 0) : 3,
  };
}

/**
 * Read a --schema file into an object of field extractors.
 * Shape: { "field": { "selector": "h1", "attr": "href"?, "all": true? } }
 * @param {string} schemaFile
 */
function loadSchema(schemaFile) {
  const raw = fs.readFileSync(schemaFile, 'utf8');
  let schema;
  try {
    schema = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid --schema JSON in '${schemaFile}': ${error.message}`);
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
 * @param {{ selector: string, attr?: string, all?: boolean } | { [field: string]: { selector: string, attr?: string, all?: boolean } }} schema
 */
async function extractBySchema(context, schema) {
  const result = {};
  for (const [name, extractor] of Object.entries(schema)) {
    const { selector, attr, all } = extractor;
    if (all) {
      result[name] = await context.page.$$eval(selector, (elements, opts) => elements.slice(0, 2000).map((el) => {
        if (opts.attr)
          return el.getAttribute(opts.attr);
        return (el.textContent ?? el.innerText ?? '').trim();
      }), { attr: attr ?? null });
    } else {
      result[name] = await context.page.$eval(selector, (el, opts) => {
        if (opts.attr)
          return el.getAttribute(opts.attr);
        return (el.textContent ?? el.innerText ?? '').trim();
      }, { attr: attr ?? null }).catch(() => null);
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
  return context.page.$$eval(selector, (elements) => elements.slice(0, 5000).map((el) => ({
    text: (el.innerText ?? el.textContent ?? '').trim(),
    html: el.outerHTML,
    attrs: Object.fromEntries([...el.attributes].map((a) => [a.name, a.value])),
  })));
}

/**
 * Detect an anti-bot challenge on the rendered page (DOM widgets + text).
 * @param {import('crawlee').PlaywrightCrawlingContext} context
 */
async function detectRenderedChallenge(context) {
  try {
    const dom = await context.page.evaluate((selectors) => {
      const has = (selector) => !!document.querySelector(selector);
      return {
        turnstile: has(selectors.turnstile),
        recaptcha: has(selectors.recaptcha),
        hcaptcha: has(selectors.hcaptcha),
      };
    }, DETECT_SELECTORS);
    if (dom.turnstile)
      return { type: 'turnstile', blocked: true };
    if (dom.recaptcha)
      return { type: 'recaptcha', blocked: true };
    if (dom.hcaptcha)
      return { type: 'hcaptcha', blocked: true };
  } catch (_) { /* page may be mid-navigation */ }
  const { detectChallengeFromText } = require('./cliEnhancements');
  const bodyText = await getTextContent(context).catch(() => '');
  const title = await context.page.title().catch(() => '');
  const response = context.response;
  const status = typeof response?.status === 'function' ? response.status() : null;
  const detected = detectChallengeFromText(title, bodyText, status);
  return detected.type === 'none' && status !== null && status >= 400
      ? { type: 'http-' + status, blocked: true }
      : detected;
}

/**
 * @param {import('crawlee').PlaywrightCrawlingContext} context
 */
async function getTextContent(context) {
  return context.page.evaluate(() => document.body ? document.body.innerText.slice(0, 200_000) : '').catch(() => '');
}

/**
 * @param {import('crawlee').PlaywrightCrawlingContext} context
 */
async function getLinks(context) {
  return context.page.evaluate(() => [...document.querySelectorAll('a[href]')]
      .map((a) => a.href)
      .filter((href) => /^https?:\/\//i.test(href))
      .slice(0, 5000)).catch(() => []);
}

/**
 * @param {ReturnType<typeof parseScrapeArgs>} plan
 * @param {{ instanceId: string }} state
 */
async function buildCrawler(plan, state) {
  // Keep Crawlee's own logging off stdout so structured output stays parseable,
  // and point its runtime storage at a scratch dir instead of the CWD.
  process.env.CRAWLEE_LOG_LEVEL = process.env.CRAWLEE_LOG_LEVEL || 'OFF';
  const storageDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'playwright-cli-scrape-'));
  process.env.CRAWLEE_STORAGE_DIR = storageDir;
  process.once('exit', () => {
    try {
      fs.rmSync(storageDir, { recursive: true, force: true });
    } catch {
    }
  });
  const { PlaywrightCrawler, EnqueueStrategy } = require('crawlee');
  const { buildLaunchOptions, CHROMIUM_VERSION } = await import('cloakbrowser');
  const launchOptions = await buildLaunchOptions();
  const majorVersion = CHROMIUM_VERSION.split('.')[0];

  const schema = plan.schema ? loadSchema(plan.schema) : null;
  const crawler = new PlaywrightCrawler({
    maxConcurrency: plan.concurrency,
    maxRequestsPerCrawl: plan.maxRequests,
    maxRequestRetries: plan.retries,
    requestHandlerTimeoutSecs: plan.timeoutSecs,
    // Let the challenge detector classify blocked responses (403/429) instead
    // of Crawlee failing them outright, so types (cloudflare/captcha/...) are
    // surfaced and retried with backoff.
    sessionPoolOptions: {
      blockedStatusCodes: [],
    },
    launchContext: {
      launchOptions: {
        ...launchOptions,
        headless: true,
      },
    },
    requestHandler: async (context) => {
      const request = context.request;
      const depth = request.userData?.depth ?? 0;
      const durationStart = Date.now();
      const response = context.response ?? request.response ?? null;
      const status = response?.status?.() ?? null;
      const url = context.page.url();
      const title = await context.page.title().catch(() => '');
      const challenge = await detectRenderedChallenge(context);
      // Never capture a challenge as content: retry instead.
      if (challenge.blocked && request.retryCount < plan.retries) {
        const { RetryRequestError } = require('crawlee');
        throw new RetryRequestError(`Challenge detected (${challenge.type}); retrying`);
      }
      const text = await getTextContent(context);
      const links = await getLinks(context);
      const html = await context.page.content().catch(() => '');
      const record = {
        type: 'result',
        url,
        title,
        status,
        depth,
        text,
        html,
        links,
        challenge,
        attempts: request.retryCount + 1,
        retried: request.retryCount > 0,
        retries: request.retryCount,
        durationMs: Date.now() - durationStart,
        requestId: request.id,
      };
      if (plan.select)
        record.selected = await selectElements(context, plan.select);
      if (schema)
        record.extracted = await extractBySchema(context, schema);
      state.results.push(record);

      if (plan.crawl && depth < plan.maxDepth) {
        const strategy = plan.sameOrigin ? EnqueueStrategy.SameHostname : EnqueueStrategy.All;
        await context.enqueueLinks({
          strategy,
          userData: { depth: depth + 1 },
        });
      }
    },
    failedRequestHandler: async ({ request }, error) => {
      state.failedRequests.push({ url: request.url, error: error ? error.message : String(error), attempts: (request.retryCount ?? 0) + 1 });
    },
  });
  return { crawler, schema };
}

/**
 * Run the full scrape and emit the result.
 * @param {string[]} argv
 */
async function runScrape(argv) {
  const plan = parseScrapeArgs(argv);
  const state = { results: [], failedRequests: [] };
  const startedAt = Date.now();
  const { crawler, schema } = await buildCrawler(plan, state);
  await crawler.run([plan.url]);

  const summary = {
    startUrl: plan.url,
    results: state.results,
    requestsProcessed: state.results.length,
    failedRequests: state.failedRequests,
    durationMs: Date.now() - startedAt,
  };
  let payload;
  if (plan.crawl) {
    payload = summary;
  } else if (state.results.length) {
    payload = state.results[0];
  } else {
    const failed = state.failedRequests[0];
    payload = failed
        ? {
            url: failed.url,
            title: null,
            status: null,
            ok: false,
            error: failed.error,
            attempts: failed.attempts,
            retried: failed.attempts > 1,
            retries: failed.attempts - 1,
            challenge: { type: 'blocked', blocked: true },
            text: '',
            html: '',
            links: [],
            durationMs: Date.now() - startedAt,
          }
        : { url: plan.url, title: null, status: null, text: '', html: '', links: [], challenge: null, attempts: 1, retried: false, retries: 0, durationMs: 0 };
  }
  payload.ok = payload.ok ?? (payload.status === null || payload.status < 400);
  payload.retries = payload.retries ?? 0;

  const rendered = formatScrape(payload, plan.outputFormat, schema, plan);
  const textOut = plan.outputFile ? null : rendered;
  if (plan.outputFile)
    fs.writeFileSync(plan.outputFile, rendered);
  else
    process.stdout.write(rendered + (rendered.endsWith('\n') ? '' : '\n'));
}

/**
 * Render a scrape payload in the requested output format.
 * @param {any} payload
 * @param {string} format
 * @param {object | null} schema
 * @param {ReturnType<typeof parseScrapeArgs>} plan
 */
function formatScrape(payload, format, schema, plan) {
  if (format === 'text')
    return payload.text ?? '';
  if (format === 'markdown') {
    const parts = [];
    if (payload.title)
      parts.push(`# ${payload.title}`);
    parts.push(payload.text ?? '');
    return parts.join('\n\n');
  }
  if (format === 'csv') {
    const records = plan.crawl ? payload.results : [payload];
    const extracted = records.flatMap((r) => r.extracted ?? (r.selected ? { selected: r.selected } : []));
    const columns = [...new Set(extracted.flatMap((r) => Object.keys(r)))];
    if (!columns.length)
      throw new Error('CSV output requires --select or --schema extraction.');
    const escape = (v) => {
      const s = Array.isArray(v) ? v.join(' | ') : (v == null ? '' : String(v));
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = [columns.map(escape).join(',')];
    for (const r of extracted)
      rows.push(columns.map((c) => escape(r[c])).join(','));
    return rows.join('\n');
  }
  return JSON.stringify(payload, null, 2);
}

module.exports = {
  runScrape,
  parseScrapeArgs,
};
