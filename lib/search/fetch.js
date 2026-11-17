/**
 * Web-fetch adapters (v2) — Kelivo porting group §4.
 *
 * One adapter per fetch-capable catalog type. Each receives the fetch context
 * `{ url, service, descriptor, signal, timeoutMs }` (service.apiKey is already
 * rotated by the registry) and resolves to
 *
 * ```js
 * { statusCode, content, title?, finalUrl? }
 * ```
 *
 * where `content` is Markdown/plain text, `title` falls back to the first
 * Markdown `#` heading when the provider returns none, and `finalUrl` is the
 * provider-reported page URL (or the requested URL when it reports none).
 * As in Kelivo's `WebFetchService` (§4 common behaviour) content is trimmed,
 * empty content is an error, and pages are capped at 100 000 characters; when
 * the cap cuts a page the outcome also carries `truncated: true`.
 *
 * Request/response shapes are ported from `docs/reference/kelivo-providers.md` §4
 * (`Fetch:` line of each provider section):
 *
 * | type | method + endpoint | body / response |
 * |---|---|---|
 * | tavily | sibling `/search`→`/extract` | `{urls:"<url>", format:"markdown"}` (bare string) → `results[0].raw_content` |
 * | exa | sibling `/search`→`/contents` | `{urls:[url], text:{maxCharacters:100000}}` → `results[0].text` |
 * | linkup | fixed `/v1/fetch` | `{url}` → `markdown` |
 * | metaso | fixed `/api/v1/reader` (Accept: text/plain) | `{url}` → raw Markdown body |
 * | ollama | fixed `/api/web_fetch` | `{url}` → `title` + `content` |
 * | deepseek | fixed `/v1/tools/fetch` | `{url}` → `title` + `content` |
 * | jina | fixed `https://r.jina.ai/` | `{url}`, `X-Retain-Images: none` → `data.content` |
 * | querit | fixed `/v1/contents` | `{urls:[url], format:"markdown", extrasMeta:true}` → `results[0].content` |
 * | firecrawl | sibling `/search`→`/scrape` | `{url, formats:["markdown"], onlyMainContent:true}` → `data.markdown` |
 * | tinyfish | host swap `api.search.tinyfish.ai`→`api.fetch.tinyfish.ai`, else sibling `/search`→`/fetch` | `{urls:[url], format:"markdown"}` → `results[0].text` |
 * | anysearch | sibling `/search`→`/extract` | `{url}` → `data.content` |
 * | parallel | fixed `/v1/extract` | `{urls:[url], advanced_settings:{full_content:true}}` → `results[0].full_content` |
 * | you | fixed `/v1/contents` | `{urls:[url], formats:["markdown"]}` → `[0].markdown` |
 *
 * Non-2xx handling follows the v2 contract: throw {@link HttpFailure} on
 * transport/auth/empty-body failures, but a non-2xx response that still carries
 * a parseable page is returned as `{ statusCode, content }` (the `ctx.web`
 * fetch seam reports a status code rather than treating it as an error).
 *
 * Custom base URLs: only the providers whose search endpoint is sibling-derived
 * (tavily, exa, firecrawl, anysearch, tinyfish) honour `service.baseURL`; the
 * fixed-endpoint providers use their vendor host exactly like Kelivo.
 *
 * @module @ds-hu/dsh-better-search/lib/search/fetch
 */
import {
  asText,
  authHeaders,
  httpFailure,
  requestResponse,
  requestText,
  requestTimeout,
  resolveEndpoint,
} from './http.js';

/** Exa's `text.maxCharacters` value ported from Kelivo (100 000). */
const EXA_MAX_TEXT_CHARACTERS = 100_000;

/** Upper bound on fetched page characters (`webFetchMaxContentLength`). */
const MAX_CONTENT_LENGTH = 100_000;

/**
 * Cap page text at {@link MAX_CONTENT_LENGTH} without splitting a UTF-16
 * surrogate pair (Dart's `substring` guard ported to JS).
 *
 * @param {string} text - trimmed page text.
 * @returns {{content: string, truncated: boolean}} capped content plus whether the cap fired.
 */
function capContent(text) {
  if (text.length <= MAX_CONTENT_LENGTH) return { content: text, truncated: false };
  let end = MAX_CONTENT_LENGTH;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { content: text.slice(0, end), truncated: true };
}

/**
 * First Markdown H1 in a page, used when a provider returns no title.
 *
 * @param {string} content - Markdown/plain text.
 * @returns {string} heading text, or '' when there is none.
 */
export function firstMarkdownHeading(content) {
  const match = /^#\s+(.+)$/mu.exec(content);
  return match === null ? '' : match[1].trim();
}

/**
 * Resolve a provider's search endpoint from the service/descriptor pair.
 *
 * @param {{service: object, descriptor?: object}} context - fetch context.
 * @param {string} canonical - canonical Kelivo search endpoint.
 * @returns {string} resolved search endpoint.
 */
function searchEndpoint(context, canonical) {
  return resolveEndpoint({
    service: context.service,
    descriptor: context.descriptor,
    endpoint: canonical,
  });
}

/**
 * Swap the trailing search path of an endpoint for the provider's fetch path.
 *
 * Mirrors Kelivo's `siblingFetchEndpoint`: a custom search URL must end with
 * `searchPath` or the user gets a short, actionable error instead of a 404.
 *
 * @param {string} searchUrl - resolved search endpoint.
 * @param {string} searchPath - trailing path to replace, e.g. `/search`.
 * @param {string} fetchPath - replacement path, e.g. `/extract`.
 * @param {string} provider - label used in the error message.
 * @returns {string} fetch endpoint.
 */
function siblingEndpoint(searchUrl, searchPath, fetchPath, provider) {
  const url = new URL(searchUrl);
  const path = url.pathname.replace(/\/+$/u, '');
  if (!path.endsWith(searchPath)) {
    throw new Error(`${provider} custom URL must end with ${searchPath} to read pages`);
  }
  url.pathname = `${path.slice(0, path.length - searchPath.length)}${fetchPath}`;
  return url.toString();
}

/**
 * Send a JSON-body POST through {@link requestResponse} (non-2xx tolerated).
 *
 * @param {{signal?: AbortSignal, timeoutMs?: number}} context - fetch context.
 * @param {{url: string, headers: Record<string, string>, body: object, provider: string}} request - request data.
 * @returns {Promise<{response: {status: number, text: string}, data: any}>} response plus parsed JSON (undefined when invalid).
 */
async function postJson(context, { url, headers, body, provider }) {
  const response = await requestResponse(url, {
    method: 'POST',
    headers,
    body,
    signal: context.signal,
    timeoutMs: requestTimeout(context),
    provider,
  });
  let data;
  try {
    data = JSON.parse(response.text);
  } catch {
    data = undefined;
  }
  return { response, data };
}

/**
 * Project an extracted page into the fetch outcome, enforcing the "no readable
 * content" rules.
 *
 * @param {{url?: string}} context - fetch context (fallback final URL).
 * @param {{status: number, text: string}} response - HTTP response.
 * @param {{provider: string, content: unknown, title?: unknown, finalUrl?: unknown}} page - extracted page.
 * @returns {{statusCode: number, content: string, title?: string, finalUrl?: string}} outcome.
 * @throws {HttpFailure} when the response is non-2xx and no page was parsed.
 * @throws {Error} when a 2xx response has no readable content.
 */
function finish(context, response, { provider, content, title, finalUrl }) {
  const text = asText(content).trim();
  if (text.length === 0) {
    if (response.status < 200 || response.status >= 300) {
      throw httpFailure(provider, response.status, response.text);
    }
    throw new Error(`${provider} fetch returned no readable content`);
  }
  const resolvedTitle = asText(title).trim() || firstMarkdownHeading(text);
  const resolvedFinalUrl = asText(finalUrl).trim() || asText(context?.url).trim();
  const capped = capContent(text);
  /** @type {{statusCode: number, content: string, title?: string, finalUrl?: string, truncated?: boolean}} */
  const outcome = { statusCode: response.status, content: capped.content };
  if (resolvedTitle.length > 0) outcome.title = resolvedTitle;
  if (resolvedFinalUrl.length > 0) outcome.finalUrl = resolvedFinalUrl;
  if (capped.truncated) outcome.truncated = true;
  return outcome;
}

/**
 * Build the provider-specific failure for an envelope error, mapping it onto
 * {@link HttpFailure} when the HTTP status itself failed too.
 *
 * @param {string} provider - provider label.
 * @param {{status: number, text: string}} response - HTTP response.
 * @param {string} message - short provider-specific message.
 * @returns {Error} the failure to throw.
 */
function providerError(provider, response, message) {
  if (response.status < 200 || response.status >= 300) {
    return httpFailure(provider, response.status, response.text);
  }
  return new Error(message);
}

/**
 * Read an array element as a plain object.
 *
 * @param {unknown} value - candidate.
 * @returns {Record<string, any>|null} object or null.
 */
function objectOf(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : null;
}

/**
 * Pick the first element of a JSON array.
 *
 * @param {unknown} value - candidate array.
 * @returns {unknown} first element (undefined when not an array/empty).
 */
function firstOf(value) {
  return Array.isArray(value) ? value[0] : undefined;
}

/** Fetch adapters keyed by catalog type id. @type {Readonly<Record<string, Function>>} */
export const FETCH_ADAPTERS = Object.freeze({
  /** Tavily extract: bare-string `urls`, markdown, heading-derived title. */
  tavily: async (context) => {
    const endpoint = siblingEndpoint(
      searchEndpoint(context, 'https://api.tavily.com/search'),
      '/search',
      '/extract',
      'Tavily',
    );
    const { response, data } = await postJson(context, {
      url: endpoint,
      headers: authHeaders({ service: context.service, auth: 'bearer', name: 'Tavily' }),
      body: { urls: context.url, format: 'markdown' },
      provider: 'Tavily',
    });
    const page = objectOf(firstOf(data?.results));
    const failed = objectOf(firstOf(data?.failed_results));
    const content = page?.raw_content;
    if (asText(content).trim().length === 0) {
      const detail = asText(failed?.error).trim();
      if (detail.length > 0) {
        throw providerError('Tavily', response, `Tavily fetch failed: ${detail}`);
      }
    }
    return finish(context, response, {
      provider: 'Tavily',
      content,
      title: page?.title,
      finalUrl: page?.url,
    });
  },

  /** Exa contents: array of URLs, `text.maxCharacters`, explicit status array. */
  exa: async (context) => {
    const endpoint = siblingEndpoint(
      searchEndpoint(context, 'https://api.exa.ai/search'),
      '/search',
      '/contents',
      'Exa',
    );
    const { response, data } = await postJson(context, {
      url: endpoint,
      headers: authHeaders({ service: context.service, auth: 'bearer', name: 'Exa' }),
      body: { urls: [context.url], text: { maxCharacters: EXA_MAX_TEXT_CHARACTERS } },
      provider: 'Exa',
    });
    const status = objectOf(firstOf(data?.statuses));
    if (status?.status === 'error') {
      const detail =
        asText(objectOf(status.error)?.tag).trim() || asText(status.error).trim() || 'crawl failed';
      throw providerError('Exa', response, `Exa fetch failed: ${detail}`);
    }
    const page = objectOf(firstOf(data?.results));
    return finish(context, response, {
      provider: 'Exa',
      content: page?.text,
      title: page?.title,
      finalUrl: page?.url,
    });
  },

  /** LinkUp fetch: `{url}` → `markdown`. */
  linkup: async (context) => {
    const { response, data } = await postJson(context, {
      url: 'https://api.linkup.so/v1/fetch',
      headers: authHeaders({ service: context.service, auth: 'bearer', name: 'LinkUp' }),
      body: { url: context.url },
      provider: 'LinkUp',
    });
    return finish(context, response, {
      provider: 'LinkUp',
      content: data?.markdown,
      title: data?.title,
    });
  },

  /** Metaso reader: plain-text Markdown response body. */
  metaso: async (context) => {
    const endpoint = 'https://metaso.cn/api/v1/reader';
    const content = await requestText(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'text/plain',
        ...authHeaders({ service: context.service, auth: 'bearer', name: 'Metaso' }),
      },
      body: { url: context.url },
      signal: context.signal,
      timeoutMs: requestTimeout(context),
      provider: 'Metaso',
    });
    return finish(context, { status: 200, text: content }, {
      provider: 'Metaso',
      content,
    });
  },

  /** Ollama web fetch: top-level `title` + `content`. */
  ollama: async (context) => {
    const { response, data } = await postJson(context, {
      url: 'https://ollama.com/api/web_fetch',
      headers: authHeaders({ service: context.service, auth: 'bearer', name: 'Ollama' }),
      body: { url: context.url },
      provider: 'Ollama',
    });
    return finish(context, response, {
      provider: 'Ollama',
      content: data?.content,
      title: data?.title,
    });
  },

  /** DeepSeek tools fetch: top-level `title` + `content`. */
  deepseek: async (context) => {
    const { response, data } = await postJson(context, {
      url: 'https://api.deepseek.com/v1/tools/fetch',
      headers: authHeaders({ service: context.service, auth: 'bearer', name: 'DeepSeek' }),
      body: { url: context.url },
      provider: 'DeepSeek',
    });
    return finish(context, response, {
      provider: 'DeepSeek',
      content: data?.content,
      title: data?.title,
    });
  },

  /** Jina reader: optional Bearer (only when a key exists), `data.content`. */
  jina: async (context) => {
    const apiKey = asText(context.service?.apiKey).trim();
    /** @type {Record<string, string>} */
    const headers = { 'X-Retain-Images': 'none' };
    if (apiKey.length > 0) headers.Authorization = `Bearer ${apiKey}`;
    const { response, data } = await postJson(context, {
      url: 'https://r.jina.ai/',
      headers,
      body: { url: context.url },
      provider: 'Jina',
    });
    const page = objectOf(data?.data);
    return finish(context, response, {
      provider: 'Jina',
      content: page?.content,
      title: page?.title,
      finalUrl: page?.url,
    });
  },

  /** Querit contents: markdown + `extrasMeta.title`, `error_code` envelope. */
  querit: async (context) => {
    const { response, data } = await postJson(context, {
      url: 'https://api.querit.ai/v1/contents',
      headers: authHeaders({ service: context.service, auth: 'bearer', name: 'Querit' }),
      body: { urls: [context.url], format: 'markdown', extrasMeta: true },
      provider: 'Querit',
    });
    const errorCode = data?.error_code;
    if (errorCode !== undefined && errorCode !== null && errorCode !== 200) {
      throw new Error(
        `Querit fetch failed: ${[asText(errorCode), asText(data?.error_msg).trim()]
          .filter((part) => part.length > 0)
          .join(' ')}`,
      );
    }
    const page = objectOf(firstOf(data?.results));
    if (page === null) {
      throw providerError('Querit', response, 'Querit fetch failed: crawl failed');
    }
    return finish(context, response, {
      provider: 'Querit',
      content: page?.content,
      title: objectOf(page?.extrasMeta)?.title,
      finalUrl: page?.url,
    });
  },

  /** Firecrawl scrape: sibling `/search`→`/scrape`, `data.markdown`. */
  firecrawl: async (context) => {
    const endpoint = siblingEndpoint(
      searchEndpoint(context, 'https://api.firecrawl.dev/v2/search'),
      '/search',
      '/scrape',
      'Firecrawl',
    );
    const apiKey = asText(context.service?.apiKey).trim();
    /** @type {Record<string, string>} */
    const headers = {};
    if (apiKey.length > 0) headers.Authorization = `Bearer ${apiKey}`;
    const { response, data } = await postJson(context, {
      url: endpoint,
      headers,
      body: { url: context.url, formats: ['markdown'], onlyMainContent: true },
      provider: 'Firecrawl',
    });
    if (data?.success !== true) {
      throw providerError(
        'Firecrawl',
        response,
        `Firecrawl fetch failed: ${asText(data?.error).trim() || 'scrape failed'}`,
      );
    }
    const page = objectOf(data?.data);
    const metadata = objectOf(page?.metadata);
    const rawTitle = metadata?.title;
    const title = Array.isArray(rawTitle) ? firstOf(rawTitle) : rawTitle;
    return finish(context, response, {
      provider: 'Firecrawl',
      content: page?.markdown,
      title,
      finalUrl: metadata?.url ?? metadata?.sourceURL,
    });
  },

  /** TinyFish: host swap (or sibling `/fetch`), markdown `results[0].text`. */
  tinyfish: async (context) => {
    const searchUrl = searchEndpoint(context, 'https://api.search.tinyfish.ai');
    const parsed = new URL(searchUrl);
    let endpoint;
    if (parsed.hostname.toLowerCase() === 'api.search.tinyfish.ai') {
      parsed.hostname = 'api.fetch.tinyfish.ai';
      endpoint = parsed.toString();
    } else {
      endpoint = siblingEndpoint(searchUrl, '/search', '/fetch', 'TinyFish');
    }
    const { response, data } = await postJson(context, {
      url: endpoint,
      headers: authHeaders({ service: context.service, auth: 'x-api-key', name: 'TinyFish' }),
      body: { urls: [context.url], format: 'markdown' },
      provider: 'TinyFish',
    });
    const page = objectOf(firstOf(data?.results));
    if (page === null) {
      const failure = objectOf(firstOf(data?.errors));
      const detail = asText(failure?.error).trim();
      if (detail.length > 0) {
        throw providerError('TinyFish', response, `TinyFish fetch failed: ${detail}`);
      }
    }
    const rawText = page?.text;
    const content =
      typeof rawText === 'string' ? rawText : rawText === null || rawText === undefined ? '' : JSON.stringify(rawText);
    return finish(context, response, {
      provider: 'TinyFish',
      content,
      title: page?.title,
      finalUrl: page?.final_url ?? page?.url,
    });
  },

  /** AnySearch extract: `{code,data}` envelope, `data.content`. */
  anysearch: async (context) => {
    const endpoint = siblingEndpoint(
      searchEndpoint(context, 'https://api.anysearch.com/v1/search'),
      '/search',
      '/extract',
      'AnySearch',
    );
    const apiKey = asText(context.service?.apiKey).trim();
    /** @type {Record<string, string>} */
    const headers = {};
    if (apiKey.length > 0) headers.Authorization = `Bearer ${apiKey}`;
    const { response, data } = await postJson(context, {
      url: endpoint,
      headers,
      body: { url: context.url },
      provider: 'AnySearch',
    });
    const code = data?.code;
    if (code !== undefined && code !== null && code !== 0) {
      throw providerError(
        'AnySearch',
        response,
        `AnySearch fetch failed: ${asText(data?.message) || asText(code) || 'Unknown error'}`,
      );
    }
    const page = objectOf(data?.data);
    return finish(context, response, {
      provider: 'AnySearch',
      content: page?.content,
      title: page?.title,
      finalUrl: page?.url,
    });
  },

  /** Parallel extract: `advanced_settings.full_content`, `errors[]` detail. */
  parallel: async (context) => {
    const { response, data } = await postJson(context, {
      url: 'https://api.parallel.ai/v1/extract',
      headers: authHeaders({ service: context.service, auth: 'x-api-key-lower', name: 'Parallel' }),
      body: { urls: [context.url], advanced_settings: { full_content: true } },
      provider: 'Parallel',
    });
    const page = objectOf(firstOf(data?.results));
    if (page === null) {
      const failure = objectOf(firstOf(data?.errors));
      if (failure !== null) {
        const detail = [asText(failure.error_type).trim(), asText(failure.http_status_code).trim()]
          .filter((entry) => entry.length > 0)
          .join(' ');
        if (detail.length > 0) {
          throw providerError('Parallel', response, `Parallel fetch failed: ${detail}`);
        }
      }
    }
    return finish(context, response, {
      provider: 'Parallel',
      content: page?.full_content,
      title: page?.title,
      finalUrl: page?.url,
    });
  },

  /** You.com contents: response is a list; `[0].markdown`. */
  you: async (context) => {
    const { response, data } = await postJson(context, {
      url: 'https://ydc-index.io/v1/contents',
      headers: authHeaders({ service: context.service, auth: 'x-api-key', name: 'You.com' }),
      body: { urls: [context.url], formats: ['markdown'] },
      provider: 'You.com',
    });
    const page = objectOf(firstOf(data));
    return finish(context, response, {
      provider: 'You.com',
      content: page?.markdown,
      title: page?.title,
      finalUrl: page?.url,
    });
  },
});
