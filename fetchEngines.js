/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

// @ts-check

/**
 * Plain-HTTP fingerprint-matched fetch engines that run directly in the CLI
 * process, bypassing the browser for targets that do not need JS rendering.
 *
 * Engines:
 *  - wreq:       wreq-js (@0x676e67/wreq, the rquest successor) — Chrome JA3/JA4
 *                TLS+HTTP2 fingerprints at curl speed.
 *  - httpcloak:  httpcloak — managed Chrome/Edge/Firefox fingerprint presets with
 *                optional TLS-session-ticket rotation and local-proxy routing.
 *
 * The result shape matches the browser `fetch` run-code output so the rest of
 * the CLI pipeline (challenge detection, --raw stripping, --json payloads)
 * treats both paths identically.
 */

const RETRY_DELAY_MS = 1500;
const DEFAULT_TIMEOUT_MS = 30000;
const BINARY_CONTENT_RE = /octet-stream|image\/|application\/pdf|application\/zip|application\/gzip|audio\/|video\/|font\//;

/**
 * @param {number} status
 */
function statusTextFor(status) {
  const known = {
    200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
    301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
    405: 'Method Not Allowed', 408: 'Request Timeout', 429: 'Too Many Requests',
    500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
  };
  return known[status] ?? '';
}

/**
 * @param {string} contentType
 */
function isBinaryContentType(contentType) {
  return BINARY_CONTENT_RE.test(contentType ?? '');
}

/**
 * @param {string} message
 */
function friendlyLoadError(engine, error) {
  const message = error instanceof Error ? error.message : String(error);
  return `Unable to load the '${engine}' fetch engine: ${message}`;
}

/**
 * Detect an anti-bot challenge from a plain-HTTP response (status + body text).
 * Reuses cliEnhancements' shared detector; required lazily to avoid a require
 * cycle (cliEnhancements -> fetchEngines since both ship to the CLI process).
 *
 * @param {string} engineName
 * @param {{ status: number | null, body: string }} response
 */
async function detectPlainChallenge(engineName, response) {
  const { detectChallengeFromText } = require('./cliEnhancements');
  return detectChallengeFromText(null, response.body, response.status);
}

/**
 * Perform a GET-style request through wreq-js.
 *
 * @param {{ url: string, method: string, headers: Record<string, string>, body?: string, timeoutMs: number }} options
 */
async function wreqRequest({ url, method, headers, body, timeoutMs }) {
  const wreq = require('wreq-js');
  const init = {
    method,
    timeout: timeoutMs || DEFAULT_TIMEOUT_MS,
    browser: 'chrome_149',
    os: 'macos',
  };
  if (Object.keys(headers).length)
    init.headers = headers;
  if (body !== undefined)
    init.body = body;
  const response = await wreq.fetch(url, init);
  const headerObject = typeof response.headers?.toObject === 'function' ? response.headers.toObject() : {};
  const headerMap = {};
  for (const [key, value] of Object.entries(headerObject))
    headerMap[key.toLowerCase()] = String(value);
  return {
    status: response.status,
    statusText: typeof response.statusText === 'string' ? response.statusText : statusTextFor(response.status),
    finalUrl: typeof response.url === 'string' ? response.url : url,
    headers: headerMap,
    readBody: async () => {
      const contentType = headerMap['content-type'] ?? '';
      if (isBinaryContentType(contentType)) {
        const buf = Buffer.from(await response.arrayBuffer());
        return { body: buf.toString('base64'), binary: true };
      }
      return { body: await response.text(), binary: false };
    },
  };
}

/**
 * Perform a GET-style request through httpcloak.
 *
 * @param {{ url: string, method: string, headers: Record<string, string>, body?: string, timeoutMs: number }} options
 */
async function httpcloakRequest({ url, method, headers, body, timeoutMs }) {
  const httpcloak = require('httpcloak');
  const session = new httpcloak.Session({
    preset: 'chrome-latest',
    timeout: Math.max(1, Math.round((timeoutMs || DEFAULT_TIMEOUT_MS) / 1000)),
    httpVersion: 'auto',
  });
  try {
    const requestOptions = {};
    if (Object.keys(headers).length)
      requestOptions.headers = headers;
    if (body !== undefined)
      requestOptions.body = body;
    const response = await session.request(method.toUpperCase(), url, requestOptions);
    const headerMap = {};
    for (const [key, value] of Object.entries(response.headers ?? {})) {
      const headerValue = Array.isArray(value) ? value.join(', ') : String(value);
      headerMap[key.toLowerCase()] = headerValue;
    }
    return {
      status: response.statusCode,
      statusText: typeof response.statusText === 'string' ? response.statusText : statusTextFor(response.statusCode),
      finalUrl: typeof response.finalUrl === 'string' && response.finalUrl ? response.finalUrl : url,
      headers: headerMap,
      readBody: async () => {
        const contentType = headerMap['content-type'] ?? '';
        if (isBinaryContentType(contentType)) {
          const buf = Buffer.isBuffer(response.body) ? response.body : Buffer.from('');
          return { body: buf.toString('base64'), binary: true };
        }
        return { body: typeof response.text === 'string' ? response.text : '', binary: false };
      },
    };
  } finally {
    session.close();
  }
}

/**
 * @param {'wreq' | 'httpcloak'} engine
 * @param {{ url: string, method: string, headers: Record<string, string>, body?: string, timeoutMs: number }} options
 */
function engineRequester(engine, options) {
  return engine === 'wreq' ? wreqRequest(options) : httpcloakRequest(options);
}

/**
 * Run a single plain-engine request, mapping the library response into the
 * normalized fetch contract shared with the browser engine.
 *
 * @param {'wreq' | 'httpcloak'} engine
 * @param {{ url: string, method: string, headers: Record<string, string>, body?: string, timeoutMs: number }} options
 */
async function singleRequest(engine, { url, method, headers, body, timeoutMs }) {
  const startedAt = Date.now();
  const response = await engineRequester(engine, { url, method, headers, body, timeoutMs });
  const { body: bodyText, binary } = await response.readBody();
  let json = null;
  try {
    json = binary ? null : JSON.parse(bodyText);
  } catch (_) { /* not JSON */ }
  return {
    status: response.status,
    statusText: response.statusText,
    url: response.finalUrl,
    redirected: response.finalUrl !== url,
    headers: response.headers,
    body: bodyText,
    attempts: 1,
    retried: false,
    durationMs: Date.now() - startedAt,
    ...(binary ? { binary: true } : {}),
    ...(json !== null && !binary ? { json } : {}),
    failed: response.status >= 400,
  };
}

/**
 * Run a plain-engine fetch with the same retry semantics as the browser path.
 *
 * @param {{
 *   engine: 'wreq' | 'httpcloak' | 'auto',
 *   url: string,
 *   method: string,
 *   headers: Record<string, string>,
 *   data?: string,
 *   timeoutMs?: number,
 *   retryCount: number,
 * }} options
 * @returns {Promise<{ result: any } | { escalate: true, challenge: { type: string, blocked: boolean } }>}
 */
async function runPlainFetchEngine({ engine, url, method, headers, data, timeoutMs = DEFAULT_TIMEOUT_MS, retryCount = 0 }) {
  const plainEngine = engine === 'httpcloak' ? 'httpcloak' : 'wreq';
  const maxAttempts = retryCount + 1;
  let lastResult = null;
  let lastError = null;
  let attempts = 0;
  for (let i = 0; i < maxAttempts; i++) {
    attempts++;
    lastError = null;
    try {
      lastResult = await singleRequest(plainEngine, { url, method, headers, body: data, timeoutMs });
    } catch (error) {
      lastError = error;
    }
    const status = lastResult?.status ?? null;
    const shouldRetry = retryCount > 0 && i < maxAttempts - 1 && (lastError !== null || (status !== null && status >= 500));
    if (!shouldRetry)
      break;
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
  }
  if (lastError && !lastResult)
    throw lastError;
  const result = { ...lastResult, attempts, retried: attempts > 1 };
  const challenge = await detectPlainChallenge(plainEngine, { status: result.status, body: result.body });
  if (challenge.blocked) {
    result.challenge = challenge;
    if (engine === 'auto')
      return { escalate: true, challenge };
  }
  return { result };
}

module.exports = {
  runPlainFetchEngine,
  parsePlainFetchPlan,
  printPlainFetchResult,
};

/**
 * Parse a `fetch` command's argv into a plain-engine plan. Returns null when
 * the command should fall through to the browser path (explicit --engine=browser
 * or anything the standard CLI validation should report).
 *
 * @param {string[]} argv
 * @returns {{ options: { engine: 'wreq' | 'httpcloak' | 'auto', url: string, method: string, headers: Record<string, string>, data?: string, timeoutMs: number, retryCount: number }, json: boolean } | null}
 */
function parsePlainFetchPlan(argv) {
  const positional = [];
  const flags = {};
  for (const arg of argv) {
    if (arg === 'fetch')
      continue;
    if (arg.startsWith('-s=')) {
      flags.session = arg.slice(3);
      continue;
    }
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
    return null;
  // Plain engines are for network targets; data/about/blob schemes keep the
  // browser path that handles them natively.
  if (!/^https?:\/\//i.test(url))
    return null;
  const engine = (flags.engine ?? 'auto').toLowerCase();
  if (engine === 'browser')
    return null;
  if (!['wreq', 'httpcloak', 'auto'].includes(engine))
    throw new Error(`Unsupported fetch engine '${flags.engine}'. Expected one of: wreq, httpcloak, browser, auto.`);
  const method = (flags.method ?? 'GET').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method))
    return null;
  const headers = {};
  if (typeof flags.header === 'string')
    Object.assign(headers, parseHeaderArg(flags.header));
  if (flags.user !== undefined || flags.password !== undefined) {
    const creds = Buffer.from(`${flags.user ?? ''}:${flags.password ?? ''}`).toString('base64');
    headers['Authorization'] = `Basic ${creds}`;
  }
  const timeoutMs = flags.timeout !== undefined ? require('./cliEnhancements').parseTimeoutMs(flags.timeout) : DEFAULT_TIMEOUT_MS;
  const retryCount = flags.retry !== undefined ? Math.max(0, parseInt(flags.retry, 10) || 0) : 0;
  return {
    options: {
      engine,
      url,
      method,
      headers,
      ...(flags.data !== undefined ? { data: flags.data } : {}),
      timeoutMs,
      retryCount,
    },
    json: flags.json === true,
  };
}

/**
 * Print a plain-engine fetch result matching the browser fetch contract:
 * raw body on stdout by default (composes with jq), structured JSON with
 * --json.
 *
 * @param {any} result
 * @param {{ json: boolean }} options
 */
function printPlainFetchResult(result, { json }) {
  const { successPayload, proxyDetails } = require('./cliEnhancements');
  if (!json) {
    const body = typeof result.body === 'string' ? result.body : '';
    process.stdout.write(body + (body.endsWith('\n') ? '' : '\n'));
    return;
  }
  const proxy = proxyDetails(process.env);
  const payload = result.failed
      ? { ...successPayload(undefined, null, [], null, undefined, proxy), ok: false, result, error: `HTTP ${result.status} ${result.statusText ?? ''}`.trim() }
      : successPayload(undefined, result, [], null, undefined, proxy);
  if (result.failed)
    process.exitCode = 1;
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

/**
 * Parse a comma-separated "Key: Value" header list into an object.
 * @param {string} arg
 */
function parseHeaderArg(arg) {
  const headers = {};
  for (const part of arg.split(',')) {
    const idx = part.indexOf(':');
    if (idx === -1)
      continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key)
      headers[key] = value;
  }
  return headers;
}
