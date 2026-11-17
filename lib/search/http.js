/**
 * Shared HTTP + text helpers for the search adapters.
 *
 * Every adapter funnels its network call through {@link requestJson} or
 * {@link requestText}, so four cross-cutting concerns live in exactly one
 * place:
 *
 * 1. **Cancellation and timeout** — one abort signal combined from the caller's
 *    `signal` and `AbortSignal.timeout(timeoutMs)` via `AbortSignal.any`.
 * 2. **Error shaping** — any non-2xx response throws {@link HttpFailure} whose
 *    message is `<provider> HTTP <status>: <truncated body>`, which is what the
 *    panel and the `web_search` tool surface to the user.
 * 3. **Credential hygiene** — this module never logs, stringifies or returns a
 *    request header. Error messages only ever contain the *response* body.
 * 4. **Test seam** — {@link setFetchForTests} swaps the `fetch` implementation
 *    so `test/adapters.test.mjs` can run offline with canned payloads.
 *
 * It also carries the small provider-agnostic utilities the family modules
 * share (count clamping, endpoint resolution, source projection, HTML entity
 * decoding) so those do not drift between adapters.
 *
 * @module @ds-hu/dsh-better-search/lib/search/http
 */

/** Timeout used when a caller forgets to pass one. Matches the store default. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Longest response body kept inside an error message. */
const ERROR_BODY_LIMIT = 300;

/**
 * @typedef {object} RequestOptions
 * @property {'GET'|'POST'|'PUT'|'DELETE'} [method] - HTTP method, default GET.
 * @property {Record<string, string>} [headers] - request headers.
 * @property {unknown} [body] - object (JSON-encoded here) or raw string body.
 * @property {AbortSignal} [signal] - caller cancellation signal.
 * @property {number} [timeoutMs] - total request deadline.
 * @property {string} [provider] - label used in error messages.
 * @property {'follow'|'error'|'manual'} [redirect] - redirect policy.
 * @property {boolean} [throwOnHttpError] - throw {@link HttpFailure} on non-2xx (default true; {@link requestResponse} disables it).
 */

/**
 * @typedef {object} RawResponse
 * @property {number} status - HTTP status code.
 * @property {Headers} headers - response headers.
 * @property {string} text - decoded response body.
 * @property {string} url - final URL after redirects.
 */

/**
 * Active fetch implementation. The wrapper keeps `globalThis.fetch` late-bound
 * so importing this module before a runtime polyfill exists still works, and
 * so the global is never captured as a stale function.
 *
 * @type {(input: string, init: Record<string, unknown>) => Promise<Response>}
 */
let fetchImpl = (input, init) => globalThis.fetch(input, init);

/**
 * Replace the fetch implementation used by every adapter.
 *
 * Passing a function installs a test double; passing `null`/`undefined`
 * restores the global `fetch`. This is the only supported test seam — adapters
 * never reach for `fetch` directly.
 *
 * @param {((input: string, init: Record<string, unknown>) => Promise<Response>)|null} [fn] - fake fetch, or null to restore.
 * @returns {void}
 */
export function setFetchForTests(fn) {
  if (typeof fn === 'function') {
    fetchImpl = /** @type {(input: string, init: Record<string, unknown>) => Promise<Response>} */ (fn);
    return;
  }
  fetchImpl = (input, init) => globalThis.fetch(input, init);
}

/**
 * Error thrown when a provider answers with a non-2xx status.
 *
 * The message follows the contract exactly — `<provider> HTTP <status>:
 * <truncated body>` — and `.status` carries the numeric status for callers that
 * want to branch on auth (401/403) versus server (5xx) failures.
 */
export class HttpFailure extends Error {
  /**
   * @param {number} status - HTTP status code of the failed response.
   * @param {string} message - user-visible failure message.
   */
  constructor(status, message) {
    super(message);
    this.name = 'HttpFailure';
    /** @type {number} HTTP status code. */
    this.status = status;
  }
}

/**
 * Collapse a response body to one short line for an error message.
 *
 * @param {unknown} body - raw response text (or anything stringifiable).
 * @param {number} [limit] - maximum characters kept.
 * @returns {string} whitespace-collapsed, truncated text.
 */
export function truncateBody(body, limit = ERROR_BODY_LIMIT) {
  const text = String(body ?? '').replace(/\s+/gu, ' ').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

/**
 * Combine a caller signal with a timeout into one abort signal.
 *
 * Uses `AbortSignal.any` (Node ≥ 20.3) so either source cancels the request.
 * A missing/invalid `timeoutMs` falls back to the store default.
 *
 * @param {AbortSignal|undefined|null} signal - caller cancellation signal.
 * @param {number|undefined} timeoutMs - deadline in milliseconds.
 * @returns {AbortSignal} combined signal.
 */
export function combineAbortSignals(signal, timeoutMs) {
  const numeric = Number(timeoutMs);
  const deadline =
    Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : DEFAULT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(deadline);
  return signal === undefined || signal === null
    ? timeoutSignal
    : AbortSignal.any([signal, timeoutSignal]);
}

/**
 * Resolve the effective timeout for one request.
 *
 * @param {{timeoutMs?: number}} context - adapter context.
 * @param {number} [floorMs] - minimum deadline (Jina needs ≥ 15 s).
 * @returns {number} milliseconds.
 */
export function requestTimeout(context, floorMs = 0) {
  const numeric = Number(context?.timeoutMs);
  const base =
    Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : DEFAULT_TIMEOUT_MS;
  return floorMs > 0 ? Math.max(base, Math.round(floorMs)) : base;
}

/**
 * Case-insensitive header presence check.
 *
 * @param {Record<string, string>} headers - header bag.
 * @param {string} name - header name.
 * @returns {boolean} whether the header is present.
 */
function hasHeader(headers, name) {
  const wanted = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === wanted);
}

/**
 * Find the most specific transport error code in an error's cause chain.
 *
 * Node's `fetch` throws `TypeError: fetch failed` whose `cause` is the real
 * socket/DNS error (`code: "ECONNRESET"`, `"ENOTFOUND"`, `"UND_ERR_SOCKET"`, …);
 * happy-eyeballs setups wrap several attempts in an `AggregateError` under
 * `errors[]`. Walking a few levels keeps the panel message actionable.
 *
 * @param {unknown} error - thrown error.
 * @returns {string} cause code, or '' when none is found.
 */
function transportCode(error) {
  /** @type {Set<unknown>} */
  const seen = new Set();
  /** @type {unknown[]} */
  const queue = [error];
  for (let index = 0; index < queue.length && index < 8; index += 1) {
    const current = queue[index];
    if (current === null || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (typeof current.code === 'string' && current.code.length > 0) return current.code;
    if (Array.isArray(current.errors)) queue.push(...current.errors);
    if (current.cause !== undefined) queue.push(current.cause);
  }
  return '';
}

/**
 * Run one HTTP request and decode the body as text.
 *
 * @param {string} url - absolute request URL.
 * @param {RequestOptions} [options] - method, headers, body, signal, timeoutMs, provider.
 * @returns {Promise<RawResponse>} the response.
 */
async function request(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    signal = undefined,
    timeoutMs = undefined,
    provider = 'Search',
    redirect = 'follow',
    throwOnHttpError = true,
  } = options;
  const combined = combineAbortSignals(signal, timeoutMs);
  const requestHeaders = { ...headers };
  /** @type {Record<string, unknown>} */
  const init = { method, headers: requestHeaders, signal: combined, redirect };

  if (body !== undefined && body !== null) {
    if (typeof body === 'string' || body instanceof Uint8Array || body instanceof ArrayBuffer) {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
      if (!hasHeader(requestHeaders, 'content-type')) {
        requestHeaders['Content-Type'] = 'application/json';
      }
    }
  }

  let response;
  try {
    response = await fetchImpl(String(url), init);
  } catch (error) {
    if (combined.aborted) {
      if (signal !== undefined && signal !== null && signal.aborted) {
        throw new Error(`${provider} request cancelled`);
      }
      throw new Error(`${provider} request timed out after ${requestTimeout({ timeoutMs })}ms`);
    }
    const detail = error instanceof Error ? error.message : String(error);
    // Surface the low-level reason (ECONNRESET, ENOTFOUND, UND_ERR_*) so the panel
    // can show something actionable instead of a bare "fetch failed". Node fetch
    // wraps the transport error in `cause`; happy-eyeballs failures arrive as an
    // AggregateError of causes, so walk the chain instead of reading one level.
    const causeCode = transportCode(error);
    const suffix = causeCode.length > 0 && !detail.includes(causeCode) ? ` (${causeCode})` : '';
    throw new Error(`${provider} request failed: ${detail}${suffix}`);
  }

  let text;
  try {
    text = await response.text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${provider} failed to read the response: ${detail}`);
  }

  if (!response.ok && throwOnHttpError) {
    const detail = truncateBody(text) || '(empty response)';
    throw new HttpFailure(
      response.status,
      `${provider} HTTP ${response.status}: ${detail}`,
    );
  }

  return {
    status: response.status,
    headers: response.headers,
    text,
    url: typeof response.url === 'string' && response.url.length > 0 ? response.url : String(url),
  };
}

/**
 * Perform a request and parse the response as JSON.
 *
 * @param {string} url - absolute request URL.
 * @param {RequestOptions} [options] - see {@link RequestOptions}.
 * @returns {Promise<any>} parsed JSON body.
 * @throws {HttpFailure} on a non-2xx response.
 */
export async function requestJson(url, options = {}) {
  const provider = options.provider ?? 'Search';
  const response = await request(url, { ...options, provider });
  try {
    return JSON.parse(response.text);
  } catch {
    throw new Error(
      `${provider} returned invalid JSON: ${truncateBody(response.text) || '(empty response)'}`,
    );
  }
}

/**
 * Perform a request and return the response body as text.
 *
 * @param {string} url - absolute request URL.
 * @param {RequestOptions} [options] - see {@link RequestOptions}.
 * @returns {Promise<string>} decoded response body.
 * @throws {HttpFailure} on a non-2xx response.
 */
export async function requestText(url, options = {}) {
  const provider = options.provider ?? 'Search';
  const response = await request(url, { ...options, provider });
  return response.text;
}

/**
 * Perform a request and return the raw response without throwing on a non-2xx
 * status.
 *
 * Used by the fetch adapters: the `ctx.web` fetch seam reports a status code,
 * and the v2 contract keeps a readable page behind a 4xx when the provider
 * returned parsed content. Transport, timeout and body-read failures still
 * throw. Callers that get no usable content from a non-2xx response must raise
 * {@link HttpFailure} themselves via {@link httpFailure}.
 *
 * @param {string} url - absolute request URL.
 * @param {RequestOptions} [options] - see {@link RequestOptions}.
 * @returns {Promise<RawResponse>} status, headers, text and final URL.
 */
export async function requestResponse(url, options = {}) {
  const provider = options.provider ?? 'Search';
  return request(url, { ...options, provider, throwOnHttpError: false });
}

/**
 * Build the uniform non-2xx failure used by adapters.
 *
 * @param {string} provider - provider label.
 * @param {number} status - HTTP status code.
 * @param {unknown} body - response body (truncated in the message).
 * @returns {HttpFailure} the failure.
 */
export function httpFailure(provider, status, body) {
  const detail = truncateBody(body) || '(empty response)';
  return new HttpFailure(status, `${provider} HTTP ${status}: ${detail}`);
}

/**
 * POST a JSON body and parse a JSON reply (contract-name convenience wrapper).
 *
 * @param {string} url - absolute request URL.
 * @param {RequestOptions} [options] - see {@link RequestOptions}.
 * @returns {Promise<any>} parsed JSON body.
 */
export function postJson(url, options = {}) {
  return requestJson(url, { ...options, method: 'POST' });
}

/**
 * GET a JSON reply (contract-name convenience wrapper).
 *
 * @param {string} url - absolute request URL.
 * @param {RequestOptions} [options] - see {@link RequestOptions}.
 * @returns {Promise<any>} parsed JSON body.
 */
export function getJson(url, options = {}) {
  return requestJson(url, { ...options, method: 'GET' });
}

/**
 * GET a text/HTML reply (contract-name convenience wrapper).
 *
 * @param {string} url - absolute request URL.
 * @param {RequestOptions} [options] - see {@link RequestOptions}.
 * @returns {Promise<string>} decoded body.
 */
export function getText(url, options = {}) {
  return requestText(url, { ...options, method: 'GET' });
}

/* ------------------------------------------------------------------ */
/* Provider-agnostic helpers shared by the adapter family modules.    */
/* ------------------------------------------------------------------ */

/**
 * Clamp an integer into an inclusive range.
 *
 * @param {unknown} value - candidate value.
 * @param {number} min - lower bound.
 * @param {number} max - upper bound.
 * @returns {number} clamped integer.
 */
export function clampInt(value, min, max) {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, numeric));
}

/**
 * Effective `maxResults` for one adapter call.
 *
 * The registry always supplies a value in 1–50; direct callers (tests) may omit
 * it, in which case the store default (8) is used.
 *
 * @param {{maxResults?: number}} context - adapter context.
 * @returns {number} positive integer result limit.
 */
export function resultLimit(context) {
  const numeric = Math.floor(Number(context?.maxResults));
  if (!Number.isFinite(numeric) || numeric <= 0) return 8;
  return numeric;
}

/**
 * Turn `service.baseURL` into the endpoint actually called.
 *
 * - Empty `baseURL` → the adapter's canonical Kelivo endpoint.
 * - A `baseURL` equal to `descriptor.url` → the canonical endpoint. The panel
 *   seeds the URL field from the catalog, so this must not turn a provider's
 *   vendor base (`https://api.tavily.com`) into a 404.
 * - A bare origin (`https://gateway.example.com`) → the canonical request path
 *   is appended, which is what "custom gateway" means in practice.
 * - Anything else → used verbatim as the full endpoint, mirroring Kelivo's
 *   "custom url overrides it" behaviour.
 *
 * @param {object} input - resolution input.
 * @param {{baseURL?: string}} input.service - stored service.
 * @param {{url?: string}} [input.descriptor] - catalog descriptor.
 * @param {string} input.endpoint - canonical endpoint for the adapter.
 * @returns {string} endpoint to call.
 */
export function resolveEndpoint({ service, descriptor, endpoint }) {
  const raw = typeof service?.baseURL === 'string' ? service.baseURL.trim() : '';
  if (raw.length === 0) return endpoint;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    // Do not echo the raw value: a custom URL may embed credentials.
    throw new Error('Invalid custom URL');
  }

  const descriptorUrl = typeof descriptor?.url === 'string' ? descriptor.url.trim() : '';
  const stripSlash = (value) => value.replace(/\/+$/u, '');
  if (descriptorUrl.length > 0 && stripSlash(raw) === stripSlash(descriptorUrl)) {
    return endpoint;
  }

  if ((parsed.pathname === '' || parsed.pathname === '/') && parsed.search === '' && parsed.hash === '') {
    const canonical = new URL(endpoint);
    parsed.pathname = canonical.pathname;
    parsed.search = canonical.search;
    return parsed.toString();
  }

  return raw;
}

/**
 * Build the auth header for a provider.
 *
 * `service.apiKey` is the key the registry already picked from the rotation
 * pool; `service.apiKeys` is deliberately ignored here.
 *
 * @param {object} input - auth input.
 * @param {{apiKey?: string}} input.service - stored service (rotated key).
 * @param {'bearer'|'x-api-key'|'x-api-key-lower'|'x-subscription-token'|'none'} input.auth - header style.
 * @param {string} input.name - provider display name for error messages.
 * @param {boolean} [input.required] - throw when the key is empty.
 * @param {boolean} [input.optional] - omit the header when the key is empty.
 * @returns {Record<string, string>} headers to merge.
 */
export function authHeaders({ service, auth, name, required = false, optional = false }) {
  const key = typeof service?.apiKey === 'string' ? service.apiKey.trim() : '';
  if (required && key.length === 0) {
    throw new Error(`${name} API key is required`);
  }
  if (optional && key.length === 0) return {};
  switch (auth) {
    case 'bearer':
      return { Authorization: `Bearer ${key}` };
    case 'x-api-key':
      // Header names are case-insensitive; Kelivo spells this X-API-KEY for
      // Serper and X-API-Key for You/TinyFish, and both are wire-equivalent.
      return { 'X-API-Key': key };
    case 'x-api-key-lower':
      return { 'x-api-key': key };
    case 'x-subscription-token':
      return { 'X-Subscription-Token': key };
    case 'none':
    default:
      return {};
  }
}

/**
 * Coerce a JSON value to display text. Objects/arrays are stringified so a
 * provider that changes a scalar into a list cannot crash an adapter.
 *
 * @param {unknown} value - raw value.
 * @returns {string} display text ('' for null/undefined).
 */
export function asText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * Join a list of excerpt strings with a blank line, dropping empties.
 *
 * @param {unknown} value - array of excerpts, or a single string.
 * @param {string} [separator] - joiner.
 * @returns {string} joined text.
 */
export function joinTexts(value, separator = '\n\n') {
  if (Array.isArray(value)) {
    return value
      .map((entry) => asText(entry).trim())
      .filter((entry) => entry.length > 0)
      .join(separator);
  }
  return asText(value).trim();
}

/**
 * Project a provider item into the contract's `sources[]` shape.
 *
 * The `url` is mandatory (the seam's schema requires it), so items without one
 * are dropped. Empty optional strings are omitted rather than serialized as
 * `""`, matching how the web-search tool validates and renders sources.
 *
 * @param {object} input - source fields.
 * @param {unknown} input.url - source URL.
 * @param {unknown} [input.title] - page title.
 * @param {unknown} [input.snippet] - display excerpt.
 * @param {unknown} [input.summary] - longer model-facing excerpt.
 * @param {unknown} [input.publishedAt] - provider-supplied ISO timestamp.
 * @returns {{url: string, title?: string, snippet?: string, summary?: string, publishedAt?: string}|null} source, or null when URL-less.
 */
export function makeSource({ url, title, snippet, summary, publishedAt }) {
  const resolvedUrl = asText(url).trim();
  if (resolvedUrl.length === 0) return null;
  /** @type {{url: string, title?: string, snippet?: string, summary?: string, publishedAt?: string}} */
  const source = { url: resolvedUrl };
  const titleText = asText(title).trim();
  if (titleText.length > 0) source.title = titleText;
  const snippetText = asText(snippet).trim();
  if (snippetText.length > 0) source.snippet = snippetText;
  const summaryText = asText(summary).trim();
  if (summaryText.length > 0) source.summary = summaryText;
  const published = asText(publishedAt).trim();
  if (published.length > 0) source.publishedAt = published;
  return source;
}

/** Longest display excerpt kept in `sources[].snippet`. */
export const SNIPPET_MAX = 300;

/**
 * Split provider text into the seam's two excerpt fields.
 *
 * `snippet` is bounded for display and card payloads; `summary` carries the
 * full provider text for the model. Both are omitted when the text is empty.
 *
 * @param {unknown} text - provider excerpt/content.
 * @param {number} [limit] - maximum `snippet` length.
 * @returns {{snippet?: string, summary?: string}} excerpt fields.
 */
export function excerptFields(text, limit = SNIPPET_MAX) {
  const value = asText(text).trim();
  if (value.length === 0) return {};
  if (value.length <= limit) return { snippet: value, summary: value };
  return { snippet: `${value.slice(0, limit - 1)}…`, summary: value };
}

/**
 * Map provider items through {@link makeSource}, dropping URL-less rows.
 *
 * @param {unknown[]} items - raw provider items.
 * @param {(item: any, index: number) => object|null} mapper - item mapper returning source fields.
 * @returns {Array<{url: string, title?: string, snippet?: string, summary?: string, publishedAt?: string}>} sources.
 */
export function mapSources(items, mapper) {
  /** @type {Array<any>} */
  const sources = [];
  const list = Array.isArray(items) ? items : [];
  list.forEach((item, index) => {
    const fields = mapper(item, index);
    if (fields === null || fields === undefined) return;
    const source = makeSource(fields);
    if (source !== null) sources.push(source);
  });
  return sources;
}

/**
 * Decode HTML character references exactly once, without stripping tags.
 *
 * Mirrors Kelivo's Kagi behaviour (decode entities, keep literal tags readable)
 * and is reused by the HTML scrapers. Unknown named entities are left intact so
 * a bare `&word` in a title never disappears.
 *
 * @param {string} text - text containing HTML entities.
 * @returns {string} decoded text.
 */
export function decodeHtmlEntities(text) {
  const named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: '\u00a0',
    ndash: '–',
    mdash: '—',
    hellip: '…',
    copy: '©',
    reg: '®',
  };
  return String(text ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/gu, (match, entity) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    const replacement = named[/** @type {keyof typeof named} */ (entity)];
    return replacement ?? match;
  });
}

/**
 * Convert an HTML fragment to plain text: drop scripts/styles/comments, turn
 * tags into spaces, decode entities and collapse whitespace.
 *
 * @param {string} html - HTML fragment.
 * @returns {string} plain text.
 */
export function htmlToText(html) {
  const withoutHidden = String(html ?? '')
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, ' ')
    .replace(/<br\s*\/?>/giu, ' ')
    .replace(/<\/(p|div|li|h[1-6])>/giu, ' ');
  return collapseWhitespace(decodeHtmlEntities(withoutHidden.replace(/<[^>]*>/gu, ' ')));
}

/**
 * Collapse every whitespace run to one space and trim.
 *
 * @param {string} text - raw text.
 * @returns {string} normalized text.
 */
export function collapseWhitespace(text) {
  return String(text ?? '').replace(/\s+/gu, ' ').trim();
}
