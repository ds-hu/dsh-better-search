/**
 * Configurable JSON-POST search adapters — Kelivo porting group §5.1(1).
 *
 * Eleven providers share one request shape: a JSON `POST` with a
 * provider-specific body, a count field, and one nested array of results whose
 * field names barely change. Instead of eleven near-identical files, each
 * provider is a declarative {@link JsonAdapterConfig} consumed by
 * {@link defineJsonAdapter}.
 *
 * Per §5.2 of the porting spec the count discipline differs per provider and is
 * encoded here:
 *
 * - `countRange: null`        → send `maxResults` verbatim (Tavily, Exa, Jina,
 *                               Parallel: no client-side cap either way).
 * - `countRange: [min, max]`  → send `clamp(maxResults, min, max)`; the final
 *                               `maxResults` slice still happens afterwards, so
 *                               the returned count matches Kelivo (e.g. Ollama
 *                               asks the API for at most 10 but may return 10
 *                               even when 50 were requested).
 *
 * Response-shape quirks kept from the reference:
 * - DeepSeek prefers `summary` over `snippet` and exposes the UTC `date` as
 *   `publishedAt` (Kelivo prefixed the text instead; the seam has a field).
 * - Jina needs a 15 s minimum deadline and accepts `data[]` or `results[]`.
 * - Kimi joins `chunks[].text` and uses the pro endpoint by default.
 * - Kagi requires a non-empty `error[]` check and decodes HTML entities.
 * - Firecrawl appends `data.news[]` after `data.web[]` under one limit.
 * - Perplexity's `results` can be flat or a list of lists (multi-query).
 * - AnySearch wraps results in `{code,message,request_id,data}`.
 *
 * @module @ds-hu/dsh-better-search/lib/search/json-api
 */
import {
  asText,
  authHeaders,
  clampInt,
  decodeHtmlEntities,
  excerptFields,
  joinTexts,
  mapSources,
  requestJson,
  requestTimeout,
  resolveEndpoint,
  resultLimit,
} from './http.js';

/**
 * Read `service.options` defensively.
 *
 * @param {object} service - stored service.
 * @returns {Record<string, any>} options bag (never null).
 */
function optionsOf(service) {
  const options = service?.options;
  return options !== null && typeof options === 'object' ? options : {};
}

/**
 * Return the raw timestamp only when it carries an explicit UTC designator.
 *
 * Mirrors Dart's `DateTime.parse(...).isUtc`: a zone-less string parses as local
 * time and is not treated as a publication date.
 *
 * @param {unknown} value - provider date string.
 * @returns {string} the original string when it is an explicit UTC timestamp, else ''.
 */
function utcTimestamp(value) {
  const raw = asText(value).trim();
  if (raw.length === 0) return '';
  if (!Number.isFinite(new Date(raw).getTime())) return '';
  return /(?:Z|[+-]00:?00)$/iu.test(raw) ? raw : '';
}

/**
 * @typedef {object} JsonAdapterConfig
 * @property {string} name - provider label used in error messages.
 * @property {string|((args: {context: any, service: any, descriptor: any, limit: number, maxResults: number}) => string)} endpoint - canonical endpoint, or resolver.
 * @property {string} [auth] - auth header style, default `bearer`.
 * @property {boolean} [requiredKey] - throw locally on an empty key.
 * @property {boolean} [optionalKey] - omit the auth header when the key is empty.
 * @property {Record<string, string>|((args: object) => Record<string, string>)} [headers] - extra headers.
 * @property {number} [timeoutFloor] - minimum deadline in ms.
 * @property {[number, number]|null} [countRange] - clamp applied to the server count.
 * @property {(args: {context: any, service: any, descriptor: any, query: string, limit: number, maxResults: number}) => object} body - request body.
 * @property {(data: any, args: object) => void} [validate] - envelope error check.
 * @property {(data: any, args: object) => unknown[]} items - result array extraction.
 * @property {(item: any, args: object) => object|null} mapItem - item → source fields.
 * @property {(data: any, args: object) => unknown} [answer] - answer text extractor.
 */

/**
 * Build one adapter function from a declarative config.
 *
 * @param {JsonAdapterConfig} config - provider configuration.
 * @returns {(context: any) => Promise<{content?: string, sources: object[]}>} adapter.
 */
function defineJsonAdapter(config) {
  return async function jsonAdapter(context) {
    const { query, service, descriptor, signal } = context;
    const maxResults = resultLimit(context);
    const limit = config.countRange
      ? clampInt(maxResults, config.countRange[0], config.countRange[1])
      : maxResults;
    const callArgs = { context, service, descriptor, query, limit, maxResults };

    const endpoint =
      typeof config.endpoint === 'function'
        ? config.endpoint(callArgs)
        : resolveEndpoint({ service, descriptor, endpoint: config.endpoint });

    const extraHeaders =
      typeof config.headers === 'function'
        ? config.headers(callArgs)
        : (config.headers ?? {});
    const headers = {
      ...extraHeaders,
      ...authHeaders({
        service,
        auth: /** @type {any} */ (config.auth ?? 'bearer'),
        name: config.name,
        required: config.requiredKey === true,
        optional: config.optionalKey === true,
      }),
    };

    const data = await requestJson(endpoint, {
      method: 'POST',
      headers,
      body: config.body(callArgs),
      signal,
      timeoutMs: requestTimeout(context, config.timeoutFloor ?? 0),
      provider: config.name,
    });

    if (config.validate !== undefined) config.validate(data, callArgs);
    const items = config.items(data, callArgs);
    const sources = mapSources(items, (item) => config.mapItem(item, callArgs)).slice(
      0,
      maxResults,
    );

    /** @type {{content?: string, sources: object[]}} */
    const outcome = { sources };
    if (config.answer !== undefined) {
      const answer = asText(config.answer(data, callArgs)).trim();
      if (answer.length > 0) outcome.content = answer;
    }
    return outcome;
  };
}

/**
 * Normalize a provider mode option.
 *
 * @param {unknown} value - raw option value.
 * @param {readonly string[]} allowed - accepted values.
 * @param {string} fallback - value used when unrecognized.
 * @returns {string} normalized mode.
 */
function normalizeMode(value, allowed, fallback) {
  const mode = asText(value).trim();
  return allowed.includes(mode) ? mode : fallback;
}

/** Tavily: no count clamp, `results[].content`, optional `answer`. */
export const JSON_API_ADAPTERS = {
  tavily: defineJsonAdapter({
    name: 'Tavily',
    endpoint: 'https://api.tavily.com/search',
    auth: 'bearer',
    body: ({ query, maxResults }) => ({ query, max_results: maxResults }),
    items: (data) => (Array.isArray(data?.results) ? data.results : []),
    mapItem: (item) => ({
      title: item?.title,
      url: item?.url,
      ...excerptFields(item?.content),
    }),
    answer: (data) => (typeof data?.answer === 'string' ? data.answer : ''),
  }),

  /**
   * Exa: `numResults` is server-side; `searchType` is a DSH catalog extra that
   * maps to Exa's `type` field (`auto` / `keyword` / `neural` / `fast`) and is a
   * deliberate extension over Kelivo (which never sent it).
   */
  exa: defineJsonAdapter({
    name: 'Exa',
    endpoint: 'https://api.exa.ai/search',
    auth: 'bearer',
    body: ({ query, maxResults, service }) => {
      /** @type {Record<string, unknown>} */
      const body = {
        query,
        numResults: maxResults,
        contents: { text: true },
      };
      const searchType = asText(optionsOf(service).searchType).trim().toLowerCase();
      if (['auto', 'keyword', 'neural', 'fast'].includes(searchType)) {
        body.type = searchType;
      }
      return body;
    },
    items: (data) => (Array.isArray(data?.results) ? data.results : []),
    mapItem: (item) => ({
      title: item?.title,
      url: item?.url,
      ...excerptFields(item?.text),
    }),
  }),

  /** Ollama hosted web search: server count is clamped to 1–10. */
  ollama: defineJsonAdapter({
    name: 'Ollama',
    endpoint: 'https://ollama.com/api/web_search',
    auth: 'bearer',
    countRange: [1, 10],
    body: ({ query, limit }) => ({ query, max_results: limit }),
    items: (data) => (Array.isArray(data?.results) ? data.results : []),
    mapItem: (item) => ({
      title: item?.title,
      url: item?.url,
      ...excerptFields(item?.content),
    }),
  }),

  /** DeepSeek tools search: server count clamped to 1–50, UTC date surfaced. */
  deepseek: defineJsonAdapter({
    name: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/v1/tools/search',
    auth: 'bearer',
    headers: { Accept: 'application/json' },
    countRange: [1, 50],
    body: ({ query, limit }) => ({
      query,
      count: limit,
      need_content: false,
    }),
    items: (data) => (Array.isArray(data?.results) ? data.results : []),
    mapItem: (item) => {
      const summary = asText(item?.summary).trim();
      const text = summary.length > 0 ? summary : asText(item?.snippet);
      const publishedAt = utcTimestamp(item?.date);
      return {
        title: item?.title,
        url: item?.url,
        ...excerptFields(text),
        ...(publishedAt.length > 0 ? { publishedAt } : {}),
      };
    },
  }),

  /** Jina: no count field, 15 s minimum deadline, `data[]` with `results[]` fallback. */
  jina: defineJsonAdapter({
    name: 'Jina',
    endpoint: 'https://s.jina.ai/',
    auth: 'bearer',
    headers: { Accept: 'application/json' },
    timeoutFloor: 15_000,
    body: ({ query }) => ({ q: query }),
    items: (data) => {
      if (Array.isArray(data?.data)) return data.data;
      return Array.isArray(data?.results) ? data.results : [];
    },
    mapItem: (item) => ({
      title: item?.title,
      url: item?.url,
      ...excerptFields(item?.description),
    }),
  }),

  /**
   * Kimi: `limit` clamped to 1–20; `search_pro` is the reference default, with
   * the optional `mode: 'basic'` selecting `/v1/tools/search`. Kelivo also sent
   * `timeout_seconds`, derived here from the common timeout.
   */
  kimi: defineJsonAdapter({
    name: 'Kimi',
    endpoint: ({ service, descriptor }) => {
      const mode = normalizeMode(optionsOf(service).mode, ['pro', 'basic'], 'pro');
      return resolveEndpoint({
        service,
        descriptor,
        endpoint:
          mode === 'basic'
            ? 'https://api.moonshot.cn/v1/tools/search'
            : 'https://api.moonshot.cn/v1/tools/search_pro',
      });
    },
    auth: 'bearer',
    countRange: [1, 20],
    body: ({ query, limit, context }) => ({
      text_query: query,
      limit,
      timeout_seconds: clampInt(Math.ceil(requestTimeout(context) / 1000), 1, 60),
    }),
    items: (data) => (Array.isArray(data?.search_results) ? data.search_results : []),
    mapItem: (item) => {
      const chunks = Array.isArray(item?.chunks) ? joinTexts(item.chunks.map((chunk) => chunk?.text)) : '';
      const text = chunks.length > 0 ? chunks : asText(item?.snippet);
      return {
        title: item?.title,
        url: item?.url,
        ...excerptFields(text),
      };
    },
  }),

  /** Kagi: v0 JSON API, `limit` clamped to 1–1024, entity-decoded fields. */
  kagi: defineJsonAdapter({
    name: 'Kagi',
    endpoint: 'https://kagi.com/api/v0/search',
    auth: 'bearer',
    headers: { Accept: 'application/json' },
    countRange: [1, 1024],
    body: ({ query, limit }) => ({
      query,
      workflow: 'search',
      format: 'json',
      limit,
    }),
    validate: (data) => {
      if (Array.isArray(data?.error) && data.error.length > 0) {
        const detail = data.error
          .map((error) => asText(error?.message).trim() || asText(error?.code).trim())
          .filter((entry) => entry.length > 0)
          .join('; ');
        const trace = asText(data?.meta?.trace).trim();
        throw new Error(
          `Kagi API error: ${detail.length > 0 ? detail : 'unknown error'}${
            trace.length > 0 ? ` (Kagi trace: ${trace})` : ''
          }`,
        );
      }
    },
    items: (data) => {
      const search = data?.data?.search;
      return Array.isArray(search) ? search : [];
    },
    mapItem: (item) => {
      const title = decodeHtmlEntities(asText(item?.title)).trim();
      const url = asText(item?.url).trim();
      if (title.length === 0 || url.length === 0) return null;
      return {
        title,
        url,
        ...excerptFields(decodeHtmlEntities(asText(item?.snippet))),
      };
    },
  }),

  /** Firecrawl v2: optional key, count clamped to 1–100, web then news. */
  firecrawl: defineJsonAdapter({
    name: 'Firecrawl',
    endpoint: 'https://api.firecrawl.dev/v2/search',
    auth: 'bearer',
    optionalKey: true,
    countRange: [1, 100],
    body: ({ query, limit, service }) => {
      const options = optionsOf(service);
      const sources = Array.isArray(options.sources) ? options.sources : ['web'];
      const categories = Array.isArray(options.categories) ? options.categories : [];
      const country = asText(options.country).trim();
      const location = asText(options.location).trim();
      return {
        query,
        limit,
        ...(sources.length > 0 ? { sources: sources.map((type) => ({ type })) } : {}),
        ...(categories.length > 0
          ? { categories: categories.map((type) => ({ type })) }
          : {}),
        ...(country.length > 0 ? { country } : {}),
        ...(location.length > 0 ? { location } : {}),
      };
    },
    items: (data) => {
      const payload =
        data?.data !== null && typeof data?.data === 'object' && !Array.isArray(data.data)
          ? data.data
          : data;
      const web = Array.isArray(payload?.web) ? payload.web : [];
      const news = Array.isArray(payload?.news) ? payload.news : [];
      return [...web, ...news];
    },
    mapItem: (item) => ({
      title: item?.title,
      url: item?.url,
      ...excerptFields(item?.description ?? item?.snippet ?? item?.markdown),
    }),
  }),

  /**
   * Parallel: no count field; `objective` + `search_queries`; excerpts joined.
   * Canonical endpoint follows the catalog (`v1beta`); Kelivo's snapshot still
   * used `v1`, which also remains reachable through a custom base URL.
   */
  parallel: defineJsonAdapter({
    name: 'Parallel',
    endpoint: 'https://api.parallel.ai/v1beta/search',
    auth: 'x-api-key-lower',
    body: ({ query, service }) => ({
      objective: query,
      search_queries: [query],
      mode: normalizeMode(
        optionsOf(service).mode,
        ['advanced', 'basic', 'fast', 'turbo'],
        'advanced',
      ),
    }),
    items: (data) => (Array.isArray(data?.results) ? data.results : []),
    mapItem: (item) => ({
      title: item?.title,
      url: item?.url,
      ...excerptFields(joinTexts(item?.excerpts)),
    }),
  }),

  /**
   * Perplexity Search API: `max_results` clamped to 1–20, `results` may be a
   * list of lists for multi-query calls. The catalog flags `answer`; this
   * endpoint does not return one, but a gateway that adds `answer` is honoured.
   */
  perplexity: defineJsonAdapter({
    name: 'Perplexity',
    endpoint: 'https://api.perplexity.ai/search',
    auth: 'bearer',
    countRange: [1, 20],
    body: ({ query, limit, service }) => {
      const options = optionsOf(service);
      /** @type {Record<string, unknown>} */
      const body = { query, max_results: limit };
      const country = asText(options.country).trim();
      if (country.length > 0) body.country = country;
      if (Array.isArray(options.searchDomainFilter) && options.searchDomainFilter.length > 0) {
        body.search_domain_filter = options.searchDomainFilter;
      }
      const maxTokens = Number(options.maxTokensPerPage);
      if (Number.isFinite(maxTokens) && maxTokens > 0) {
        body.max_tokens_per_page = Math.round(maxTokens);
      }
      return body;
    },
    items: (data) => {
      const raw = Array.isArray(data?.results) ? data.results : [];
      /** @type {any[]} */
      const flat = [];
      for (const entry of raw) {
        if (Array.isArray(entry)) flat.push(...entry);
        else if (entry !== null && typeof entry === 'object') flat.push(entry);
      }
      return flat;
    },
    mapItem: (item) => ({
      title: item?.title,
      url: item?.url,
      ...excerptFields(item?.snippet),
    }),
    answer: (data) => asText(data?.answer),
  }),

  /** AnySearch: optional key, `{code,...}` envelope, `max_results` clamped 1–20. */
  anysearch: defineJsonAdapter({
    name: 'AnySearch',
    endpoint: 'https://api.anysearch.com/v1/search',
    auth: 'bearer',
    optionalKey: true,
    countRange: [1, 20],
    body: ({ query, limit }) => ({
      query,
      max_results: limit,
      format: 'json',
    }),
    validate: (data) => {
      const code = data?.code;
      if (code !== undefined && code !== null && code !== 0) {
        const message = asText(data?.message).trim() || 'Unknown API error';
        const requestId = asText(data?.request_id).trim();
        throw new Error(
          `AnySearch API error: ${message}${requestId.length > 0 ? ` (request_id: ${requestId})` : ''}`,
        );
      }
    },
    items: (data) => {
      const payload =
        data?.data !== null && typeof data?.data === 'object' && !Array.isArray(data.data)
          ? data.data
          : data;
      return Array.isArray(payload?.results) ? payload.results : [];
    },
    mapItem: (item) => {
      const snippet = asText(item?.snippet).trim();
      return {
        title: item?.title,
        url: item?.url,
        ...excerptFields(snippet.length > 0 ? snippet : asText(item?.content)),
      };
    },
  }),
};
