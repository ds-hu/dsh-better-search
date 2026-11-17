/**
 * Public adapter registry for `@ds-hu/dsh-better-search`.
 *
 * `ADAPTERS` maps every supported catalog type id to an async adapter with the
 * contract signature `(ctx: SearchContext) => Promise<SearchOutcome>`. The Host
 * (`lib/registry.js`) uses it for both real searches and the panel's
 * "connectivity test", which calls an adapter with `query: "connectivity test"`
 * and `maxResults: 1`.
 *
 * Implemented (26 catalog types):
 *
 * | family      | types |
 * |-------------|-------|
 * | json-api    | tavily, exa, ollama, deepseek, jina, kimi, kagi, firecrawl, parallel, perplexity, anysearch |
 * | envelopes   | zhipu, metaso, bocha, doubao, querit, stepfun, linkup, grok |
 * | flat        | serper, you, tinyfish, brave, bing_local, duckduckgo |
 * | searxng     | searxng |
 *
 * Intentionally absent (so `hasAdapter()` answers false and the panel reports
 * the type as unsupported):
 *
 * - `exa_mcp` — not plain REST: the reference drives Exa's hosted MCP server
 *   over Streamable HTTP / JSON-RPC (`web_search_exa`, `web_fetch_exa`). That
 *   needs an MCP client transport, which is out of scope here.
 * - `kelivo` — hidden built-in provider whose bearer token is embedded and
 *   obfuscated inside the Kelivo app; there is no user credential to store, and
 *   the port deliberately does not ship a hard-coded credential.
 *
 * All adapters receive `ctx.service.apiKey` already selected from the rotation
 * pool; the raw key pool is ignored. Every search adapter returns sources
 * already sliced to `ctx.maxResults`; {@link searchWith} slices again
 * defensively because the seam requires the bound (`lib/registry.js` also
 * enforces it).
 *
 * ## v2 registries
 *
 * `FETCH_ADAPTERS` (13 types: tavily, exa, linkup, metaso, ollama, deepseek,
 * jina, querit, firecrawl, tinyfish, anysearch, parallel, you) backs
 * `ctx.web.registerFetchProvider`; each resolves to
 * `{ statusCode, content, title?, finalUrl? }` (plus `truncated: true` when the
 * 100 000-character page cap fired). `exa_mcp` is the only fetch-capable
 * Kelivo type without an adapter (MCP transport, see above).
 *
 * `USAGE_ADAPTERS` covers the two providers with a usage API (tavily, linkup)
 * and resolves to `{ remaining, used?, limit? }`.
 *
 * @module @ds-hu/dsh-better-search/lib/search
 */
import { providerOf } from '../catalog.js';
import { ENVELOPE_ADAPTERS } from './envelopes.js';
import { bingLocal, brave, duckduckgo, serper, tinyfish, you } from './flat.js';
import { resultLimit } from './http.js';
import { JSON_API_ADAPTERS } from './json-api.js';
import { FETCH_ADAPTERS } from './fetch.js';
import { searxng } from './searxng.js';
import { USAGE_ADAPTERS } from './usage.js';

/**
 * @typedef {object} SearchContext
 * @property {string} query - query text.
 * @property {number} maxResults - upper bound on returned sources (1–50).
 * @property {object} service - stored service; `apiKey` is already rotated.
 * @property {object} descriptor - catalog entry for `service.type`.
 * @property {AbortSignal} [signal] - caller cancellation signal.
 * @property {number} timeoutMs - request deadline.
 *
 * @typedef {object} SearchOutcome
 * @property {string} [content] - provider answer text, when the API returns one.
 * @property {{url: string, title?: string, snippet?: string, summary?: string, publishedAt?: string}[]} sources
 */

/** @type {Readonly<Record<string, (context: SearchContext) => Promise<SearchOutcome>>>} */
export const ADAPTERS = Object.freeze({
  ...JSON_API_ADAPTERS,
  ...ENVELOPE_ADAPTERS,
  serper,
  you,
  tinyfish,
  brave,
  bing_local: bingLocal,
  duckduckgo,
  searxng,
});

/**
 * Web-fetch adapters keyed by catalog type id.
 *
 * @type {Readonly<Record<string, (context: {
 *   url: string,
 *   service: object,
 *   descriptor?: object,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 * }) => Promise<{
 *   statusCode: number,
 *   content: string,
 *   title?: string,
 *   finalUrl?: string,
 *   truncated?: boolean,
 * }>>}
 */
export { FETCH_ADAPTERS };

/**
 * Usage adapters keyed by catalog type id.
 *
 * @type {Readonly<Record<string, (context: {
 *   service: object,
 *   descriptor?: object,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 * }) => Promise<{remaining: number, used?: number, limit?: number}>>}
 */
export { USAGE_ADAPTERS };

/** Catalog type ids this build can execute. @type {readonly string[]} */
export const SUPPORTED_TYPES = Object.freeze(Object.keys(ADAPTERS));

/** Catalog type ids with a fetch adapter. @type {readonly string[]} */
export const SUPPORTED_FETCH_TYPES = Object.freeze(Object.keys(FETCH_ADAPTERS));

/** Catalog type ids with a usage adapter. @type {readonly string[]} */
export const SUPPORTED_USAGE_TYPES = Object.freeze(Object.keys(USAGE_ADAPTERS));

/**
 * Whether a fetch adapter exists for a catalog type id.
 *
 * @param {string} type - catalog type id.
 * @returns {boolean} true when {@link FETCH_ADAPTERS} has a callable adapter.
 */
export function hasFetch(type) {
  return typeof FETCH_ADAPTERS[type] === 'function';
}

/**
 * Whether a usage adapter exists for a catalog type id.
 *
 * @param {string} type - catalog type id.
 * @returns {boolean} true when {@link USAGE_ADAPTERS} has a callable adapter.
 */
export function hasUsage(type) {
  return typeof USAGE_ADAPTERS[type] === 'function';
}

/**
 * Whether an adapter exists for a catalog type id.
 *
 * @param {string} type - catalog type id.
 * @returns {boolean} true when {@link ADAPTERS} has a callable adapter.
 */
export function hasAdapter(type) {
  return typeof ADAPTERS[type] === 'function';
}

/**
 * Run one search through the adapter registered for a catalog type.
 *
 * Normalizes the context (fills a missing `descriptor` from the catalog so
 * direct callers and the Host agree), then enforces the contract's hard rules:
 * sources are always an array, always sliced to `maxResults`, and `content` is
 * only included when the provider actually returned a non-empty string.
 *
 * @param {string} type - catalog type id.
 * @param {SearchContext} context - adapter context.
 * @returns {Promise<{content?: string, sources: object[]}>} normalized outcome.
 * @throws {Error} when no adapter exists for the type.
 */
export async function searchWith(type, context) {
  const adapter = ADAPTERS[type];
  if (typeof adapter !== 'function') {
    throw new Error(`Unsupported search provider type: ${type}`);
  }
  const descriptor = context?.descriptor ?? providerOf(type);
  const maxResults = resultLimit(context);
  const outcome = await adapter({
    ...context,
    descriptor,
    maxResults,
  });

  const sources = Array.isArray(outcome?.sources)
    ? outcome.sources.slice(0, maxResults)
    : [];
  /** @type {{content?: string, sources: object[]}} */
  const result = { sources };
  const content = outcome?.content;
  if (typeof content === 'string' && content.trim().length > 0) {
    result.content = content.trim();
  }
  return result;
}
