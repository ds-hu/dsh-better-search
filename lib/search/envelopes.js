/**
 * Envelope-style search adapters — Kelivo porting group §5.1(3) + §5.1(4).
 *
 * These providers all wrap their hits inside a named envelope object (rather
 * than answering with a bare `results` array) and share Bearer auth. Some also
 * return generated answer text, which is projected into the seam's `content`:
 *
 * - `zhipu`    `search_result[].{title,link,content}`
 * - `metaso`   `webpages[].{title,link,snippet}` (`includeSummary:false`)
 * - `bocha`    `{code,data.webPages.value[]}` (`code` must be 200)
 * - `doubao`   PascalCase `Result.WebResults[]` (Volcengine envelope)
 * - `querit`   `results.result[]` + optional filters builder
 * - `stepfun`  `results[].{title,url,snippet|content}`
 * - `linkup`   `sources[]` + `answer` (sourced answer API)
 * - `grok`     xAI Responses API: `output_text` → content, citations/
 *              annotations → sources
 *
 * Count discipline follows §5.2: Zhipu/Metaso/Doubao send the count only,
 * Bocha/Querit/StepFun send the count and are additionally sliced to
 * `maxResults`, LinkUp/Grok have no count field at all. The final slice is
 * applied everywhere by {@link createEnvelopeAdapter}.
 *
 * @module @ds-hu/dsh-better-search/lib/search/envelopes
 */
import {
  asText,
  authHeaders,
  clampInt,
  excerptFields,
  mapSources,
  requestJson,
  requestTimeout,
  resolveEndpoint,
  resultLimit,
} from './http.js';

/** Grok's default system prompt, copied from `GrokOptions.defaultSystemPrompt`. */
const GROK_DEFAULT_SYSTEM_PROMPT =
  "You are a helpful search assistant. Search the web to find accurate and up-to-date information for the user's query. Provide a comprehensive answer with citations.";

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
 * Split a comma/newline separated filter string the way Kelivo's Querit
 * options do.
 *
 * @param {unknown} value - raw option string.
 * @returns {string[]} trimmed, non-empty entries.
 */
function splitFilterList(value) {
  return asText(value)
    .split(/[\n,]/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Build Querit's optional `filters` object; returns `{}` when nothing is set.
 *
 * @param {Record<string, any>} options - service options.
 * @returns {Record<string, unknown>} filters (empty when unset).
 */
function buildQueritFilters(options) {
  const siteIncludes = splitFilterList(options.sitesInclude);
  const siteExcludes = splitFilterList(options.sitesExclude);
  const countries = splitFilterList(options.countries);
  const languages = splitFilterList(options.languages);
  const date = asText(options.timeRange).trim();

  /** @type {Record<string, unknown>} */
  const filters = {};
  if (siteIncludes.length > 0 || siteExcludes.length > 0) {
    filters.sites = {
      ...(siteIncludes.length > 0 ? { include: siteIncludes } : {}),
      ...(siteExcludes.length > 0 ? { exclude: siteExcludes } : {}),
    };
  }
  if (date.length > 0) filters.timeRange = { date };
  if (countries.length > 0) filters.geo = { countries: { include: countries } };
  if (languages.length > 0) filters.languages = { include: languages };
  return filters;
}

/**
 * Find the assistant `output_text` block in a Responses API payload.
 *
 * @param {any} data - xAI Responses API JSON.
 * @returns {{type: string, text?: string, annotations?: unknown[]}|null} output text block.
 */
function grokOutputText(data) {
  const output = Array.isArray(data?.output) ? data.output : [];
  const message = output.find(
    (item) => item !== null && typeof item === 'object' && item.type === 'message' && item.role === 'assistant',
  );
  const content = Array.isArray(message?.content) ? message.content : [];
  const textContent = content.find(
    (item) => item !== null && typeof item === 'object' && item.type === 'output_text',
  );
  return textContent ?? null;
}

/**
 * @typedef {object} EnvelopeAdapterConfig
 * @property {string} name - provider label used in error messages.
 * @property {string} endpoint - canonical Kelivo endpoint.
 * @property {string} [auth] - auth header style, default `bearer`.
 * @property {boolean} [requiredKey] - throw locally on an empty key.
 * @property {[number, number]|null} [countRange] - clamp applied to the server count.
 * @property {Record<string, string>} [headers] - extra headers.
 * @property {(args: {context: any, service: any, descriptor: any, query: string, limit: number, maxResults: number}) => object} body - request body.
 * @property {(data: any, args: object) => void} [validate] - envelope error check.
 * @property {(data: any, args: object) => unknown[]} items - result array extraction.
 * @property {(item: any, args: object) => object|null} mapItem - item → source fields.
 * @property {(data: any, args: object) => unknown} [answer] - answer text extractor.
 */

/**
 * Build one adapter from a declarative envelope config.
 *
 * @param {EnvelopeAdapterConfig} config - provider configuration.
 * @returns {(context: any) => Promise<{content?: string, sources: object[]}>} adapter.
 */
function createEnvelopeAdapter(config) {
  return async function envelopeAdapter(context) {
    const { query, service, descriptor, signal } = context;
    const maxResults = resultLimit(context);
    const limit = config.countRange
      ? clampInt(maxResults, config.countRange[0], config.countRange[1])
      : maxResults;
    const callArgs = { context, service, descriptor, query, limit, maxResults };

    const endpoint = resolveEndpoint({ service, descriptor, endpoint: config.endpoint });
    const headers = {
      ...(config.headers ?? {}),
      ...authHeaders({
        service,
        auth: /** @type {any} */ (config.auth ?? 'bearer'),
        name: config.name,
        required: config.requiredKey === true,
      }),
    };

    const data = await requestJson(endpoint, {
      method: 'POST',
      headers,
      body: config.body(callArgs),
      signal,
      timeoutMs: requestTimeout(context),
      provider: config.name,
    });

    if (config.validate !== undefined) config.validate(data, callArgs);
    const sources = mapSources(config.items(data, callArgs), (item) =>
      config.mapItem(item, callArgs),
    ).slice(0, maxResults);

    /** @type {{content?: string, sources: object[]}} */
    const outcome = { sources };
    if (config.answer !== undefined) {
      const answer = asText(config.answer(data, callArgs)).trim();
      if (answer.length > 0) outcome.content = answer;
    }
    return outcome;
  };
}

/** Envelope adapters keyed by catalog type id. */
export const ENVELOPE_ADAPTERS = {
  /** Zhipu (智谱): fixed `search_std` engine, `count` only, no client cap. */
  zhipu: createEnvelopeAdapter({
    name: 'Zhipu',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/web_search',
    auth: 'bearer',
    body: ({ query, maxResults }) => ({
      search_query: query,
      search_engine: 'search_std',
      count: maxResults,
    }),
    items: (data) => (Array.isArray(data?.search_result) ? data.search_result : []),
    mapItem: (item) => ({
      title: item?.title,
      url: item?.link,
      ...excerptFields(item?.content),
    }),
  }),

  /** Metaso (秘塔): `webpages[]`, server `size`, no answer requested. */
  metaso: createEnvelopeAdapter({
    name: 'Metaso',
    endpoint: 'https://metaso.cn/api/v1/search',
    auth: 'bearer',
    headers: { Accept: 'application/json' },
    body: ({ query, maxResults }) => ({
      q: query,
      scope: 'webpage',
      size: maxResults,
      includeSummary: false,
    }),
    items: (data) => (Array.isArray(data?.webpages) ? data.webpages : []),
    mapItem: (item) => ({
      title: item?.title,
      url: item?.link,
      ...excerptFields(item?.snippet),
    }),
  }),

  /** Bocha (博查): `code` must be 200; `count` + client cap; preset-only knobs honoured. */
  bocha: createEnvelopeAdapter({
    name: 'Bocha',
    endpoint: 'https://api.bochaai.com/v1/web-search',
    auth: 'bearer',
    body: ({ query, maxResults, service }) => {
      const options = optionsOf(service);
      const freshness = asText(options.freshness).trim();
      const include = asText(options.include).trim();
      const exclude = asText(options.exclude).trim();
      const summary = options.summary === undefined ? true : options.summary !== false;
      return {
        query,
        ...(freshness.length > 0 ? { freshness } : {}),
        summary,
        count: maxResults,
        ...(include.length > 0 ? { include } : {}),
        ...(exclude.length > 0 ? { exclude } : {}),
      };
    },
    validate: (data) => {
      if (Number(data?.code) !== 200) {
        throw new Error(`Bocha API error code: ${asText(data?.code) || 'unknown'}`);
      }
    },
    items: (data) => {
      const pages = data?.data?.webPages?.value;
      return Array.isArray(pages) ? pages : [];
    },
    mapItem: (item) => ({
      title: item?.name,
      url: item?.url,
      ...excerptFields(item?.summary ?? item?.snippet),
    }),
  }),

  /** Doubao (豆包 / Volcengine): PascalCase body + envelope, `Count` clamped 1–50. */
  doubao: createEnvelopeAdapter({
    name: 'Doubao',
    endpoint: 'https://open.feedcoopapi.com/search_api/web_search',
    auth: 'bearer',
    requiredKey: true,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    countRange: [1, 50],
    body: ({ query, limit }) => ({
      Query: query,
      SearchType: 'web',
      Count: limit,
      Filter: { NeedUrl: true },
    }),
    validate: (data) => {
      const error = data?.ResponseMetadata?.Error;
      if (error !== null && typeof error === 'object') {
        throw new Error(
          asText(error.Message).trim() || asText(error.Code).trim() || 'Doubao API error',
        );
      }
    },
    items: (data) => {
      const results = data?.Result?.WebResults;
      return Array.isArray(results) ? results : [];
    },
    mapItem: (item) => {
      const url = asText(item?.Url).trim();
      if (url.length === 0) return null;
      const summary = asText(item?.Summary);
      const content = asText(item?.Content);
      const text =
        summary.trim().length > 0
          ? summary
          : content.trim().length > 0
            ? content
            : asText(item?.Snippet);
      return {
        title: item?.Title,
        url,
        ...excerptFields(text),
      };
    },
  }),

  /** Querit: `count` + client cap; filters built from service options. */
  querit: createEnvelopeAdapter({
    name: 'Querit',
    endpoint: 'https://api.querit.ai/v1/search',
    auth: 'bearer',
    requiredKey: true,
    body: ({ query, maxResults, service }) => {
      /** @type {Record<string, unknown>} */
      const body = { query, count: maxResults };
      const filters = buildQueritFilters(optionsOf(service));
      if (Object.keys(filters).length > 0) body.filters = filters;
      return body;
    },
    validate: (data) => {
      const code = data?.error_code;
      if (typeof code === 'number' && code !== 200) {
        throw new Error(
          `Querit API error ${code}: ${asText(data?.error_msg) || 'Unknown error'}`,
        );
      }
    },
    items: (data) => {
      const results = data?.results?.result;
      return Array.isArray(results) ? results : [];
    },
    mapItem: (item) => {
      const snippet = asText(item?.snippet).trim();
      const rawExtras = Array.isArray(item?.snippets)
        ? item.snippets
        : Array.isArray(item?.sentence)
          ? item.sentence
          : [];
      const extras = rawExtras
        .map((entry) => asText(entry).trim())
        .filter((entry) => entry.length > 0 && entry !== snippet);
      const url = asText(item?.url);
      const title = asText(item?.title).trim();
      return {
        title: title.length > 0 ? title : url,
        url,
        ...excerptFields([snippet, ...extras].filter((entry) => entry.length > 0).join('\n\n')),
      };
    },
  }),

  /** StepFun: `n` clamped 1–20 + client cap; harmless category passthrough. */
  stepfun: createEnvelopeAdapter({
    name: 'StepFun',
    endpoint: 'https://api.stepfun.com/v1/search',
    auth: 'bearer',
    requiredKey: true,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    countRange: [1, 20],
    body: ({ query, limit, service }) => {
      const category = asText(optionsOf(service).category).trim();
      return {
        query,
        n: limit,
        ...(category.length > 0 ? { category } : {}),
      };
    },
    items: (data) => (Array.isArray(data?.results) ? data.results : []),
    mapItem: (item) => ({
      title: item?.title,
      url: item?.url,
      ...excerptFields(item?.snippet ?? item?.content),
    }),
  }),

  /** LinkUp: sourced-answer response; `includeImages` is the string "false". */
  linkup: createEnvelopeAdapter({
    name: 'LinkUp',
    endpoint: 'https://api.linkup.so/v1/search',
    auth: 'bearer',
    body: ({ query }) => ({
      q: query,
      depth: 'standard',
      outputType: 'sourcedAnswer',
      includeImages: 'false',
    }),
    items: (data) => (Array.isArray(data?.sources) ? data.sources : []),
    mapItem: (item) => ({
      title: item?.name,
      url: item?.url,
      ...excerptFields(item?.snippet),
    }),
    answer: (data) => asText(data?.answer),
  }),

  /**
   * Grok: xAI Responses API. The assistant `output_text` is the answer and the
   * citation list is the sources: top-level `citations` first, then
   * `output_text.annotations` when fewer than `maxResults` were collected,
   * de-duplicated by URL — exactly Kelivo's merge order.
   */
  grok: createEnvelopeAdapter({
    name: 'Grok',
    endpoint: 'https://api.x.ai/v1/responses',
    auth: 'bearer',
    requiredKey: true,
    body: ({ query, service }) => {
      const options = optionsOf(service);
      const rawModel = asText(options.model).trim();
      const model = rawModel.length > 0 ? rawModel : 'grok-4.5';
      let reasoningEffort = asText(options.reasoningEffort).trim();
      // Kelivo only defaults the effort when the model is empty or the default.
      if (reasoningEffort.length === 0 && (rawModel.length === 0 || rawModel === 'grok-4.5')) {
        reasoningEffort = 'low';
      }
      const systemPrompt =
        asText(options.systemPrompt).trim() || GROK_DEFAULT_SYSTEM_PROMPT;
      return {
        model,
        input: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: query },
        ],
        tools: [{ type: 'web_search' }, { type: 'x_search' }],
        store: false,
        stream: false,
        ...(reasoningEffort.length > 0 ? { reasoning: { effort: reasoningEffort } } : {}),
      };
    },
    items: (data, { maxResults }) => {
      /** @type {Array<{url: string, title: string}>} */
      const citations = [];
      const seen = new Set();
      /** @param {unknown} citation - string URL or url_citation object. */
      const add = (citation) => {
        if (citations.length >= maxResults) return;
        let url = '';
        let title = '';
        if (typeof citation === 'string') {
          url = citation.trim();
        } else if (
          citation !== null &&
          typeof citation === 'object' &&
          /** @type {any} */ (citation).type === 'url_citation'
        ) {
          url = asText(/** @type {any} */ (citation).url).trim();
          title = asText(/** @type {any} */ (citation).title).trim();
        }
        if (url.length === 0 || seen.has(url)) return;
        seen.add(url);
        citations.push({ url, title });
      };

      for (const citation of Array.isArray(data?.citations) ? data.citations : []) add(citation);
      if (citations.length < maxResults) {
        const annotations = grokOutputText(data)?.annotations;
        for (const citation of Array.isArray(annotations) ? annotations : []) add(citation);
      }
      return citations;
    },
    mapItem: (item) => ({
      title: item.title.length > 0 ? item.title : item.url,
      url: item.url,
    }),
    answer: (data) => asText(grokOutputText(data)?.text),
  }),
};
