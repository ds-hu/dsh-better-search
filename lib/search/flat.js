/**
 * Flat-result adapters — Kelivo porting group §5.1(2) and §5.1(5).
 *
 * `serper`, `you`, `tinyfish` and `brave` answer with a flat `organic` /
 * `results` / `web.results` list behind a custom auth header instead of
 * Bearer. `bing_local` and `duckduckgo` are HTML scrapers, which cannot share
 * the JSON adapters and are marked ⚠️ fragile below.
 *
 * Auth headers (per the porting spec; header names are case-insensitive):
 * - Serper  `X-API-KEY`
 * - You.com `X-API-Key`
 * - TinyFish `X-API-Key`
 * - Brave   `X-Subscription-Token`
 *
 * Count discipline (§5.2): Serper has no count field (only `page`); TinyFish,
 * Brave web and Brave llmContext send a count; none of them clamp it. The final
 * `maxResults` slice is applied by every adapter here.
 *
 * ⚠️ FRAGILE — `bing_local` and `duckduckgo` parse vendor HTML with regular
 * expressions because the plugin may not add a DOM dependency. They are
 * inherently coupled to the current markup: a class rename or bot-challenge
 * page breaks them, and they can legitimately return zero results. Keep the
 * extraction rules below in sync with `docs/reference/kelivo-providers.md` §2.1–2.2.
 * They send browser-like headers but are still best-effort scrapers, not APIs.
 *
 * @module @ds-hu/dsh-better-search/lib/search/flat
 */
import {
  asText,
  authHeaders,
  clampInt,
  collapseWhitespace,
  decodeHtmlEntities,
  excerptFields,
  htmlToText,
  joinTexts,
  mapSources,
  requestJson,
  requestText,
  requestTimeout,
  resolveEndpoint,
  resultLimit,
} from './http.js';

/** Desktop Chrome UA used by Kelivo's Bing scraper. */
const BING_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

/** Windows Chrome UA used by Kelivo's DuckDuckGo scraper. */
const DUCKDUCKGO_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';

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
 * Normalize Brave's mode option. The catalog spells it `llm_context`; Kelivo's
 * enum value is `llmContext`; both are accepted, everything else means `web`.
 *
 * @param {unknown} value - raw option.
 * @returns {'web'|'llmContext'} normalized mode.
 */
function normalizeBraveMode(value) {
  const normalized = asText(value).trim().toLowerCase().replace(/[\s_-]/gu, '');
  return normalized === 'llmcontext' ? 'llmContext' : 'web';
}

/* ------------------------------------------------------------------ */
/* Flat JSON adapters.                                                */
/* ------------------------------------------------------------------ */

/**
 * Serper (Google results): `organic[]` + `{title, link, snippet}`.
 *
 * @param {any} context - adapter context.
 * @returns {Promise<{sources: object[]}>} sources.
 */
export async function serper(context) {
  const { query, service, descriptor, signal } = context;
  const maxResults = resultLimit(context);
  const options = optionsOf(service);

  /** @type {Record<string, unknown>} */
  const body = { q: query };
  for (const key of ['gl', 'hl', 'tbs']) {
    const value = asText(options[key]).trim();
    if (value.length > 0) body[key] = value;
  }
  const page = Math.round(Number(options.page));
  if (Number.isFinite(page) && page > 1) body.page = page;

  const endpoint = resolveEndpoint({
    service,
    descriptor,
    endpoint: 'https://google.serper.dev/search',
  });
  const data = await requestJson(endpoint, {
    method: 'POST',
    headers: authHeaders({ service, auth: 'x-api-key', name: 'Serper' }),
    body,
    signal,
    timeoutMs: requestTimeout(context),
    provider: 'Serper',
  });

  const sources = mapSources(
    Array.isArray(data?.organic) ? data.organic : [],
    (item) => ({
      title: item?.title,
      url: item?.link,
      ...excerptFields(item?.snippet),
    }),
  ).slice(0, maxResults);
  return { sources };
}

/**
 * You.com: merged `results.web[]` then `results.news[]`; text falls back
 * highlights → snippets → description.
 *
 * @param {any} context - adapter context.
 * @returns {Promise<{sources: object[]}>} sources.
 */
export async function you(context) {
  const { query, service, descriptor, signal } = context;
  const maxResults = resultLimit(context);
  const contentMode =
    asText(optionsOf(service).contentMode).trim() === 'snippets' ? 'snippets' : 'highlights';

  /** @type {Record<string, unknown>} */
  const body = { query, count: maxResults };
  if (contentMode === 'highlights') {
    body.extraction = { extraction_mode: 'highlights' };
  }

  const endpoint = resolveEndpoint({
    service,
    descriptor,
    endpoint: 'https://ydc-index.io/v1/search',
  });
  const data = await requestJson(endpoint, {
    method: 'POST',
    headers: authHeaders({ service, auth: 'x-api-key', name: 'You.com' }),
    body,
    signal,
    timeoutMs: requestTimeout(context),
    provider: 'You.com',
  });

  const web = Array.isArray(data?.results?.web) ? data.results.web : [];
  const news = Array.isArray(data?.results?.news) ? data.results.news : [];
  const sources = mapSources([...web, ...news], (item) => {
    const highlights = joinTexts(item?.contents?.highlights);
    const snippets = joinTexts(item?.snippets);
    const text =
      highlights.length > 0
        ? highlights
        : snippets.length > 0
          ? snippets
          : asText(item?.description);
    return {
      title: item?.title,
      url: item?.url,
      ...excerptFields(text),
    };
  }).slice(0, maxResults);
  return { sources };
}

/**
 * TinyFish: `GET` with query params and `X-API-Key`; no count field.
 *
 * @param {any} context - adapter context.
 * @returns {Promise<{sources: object[]}>} sources.
 */
export async function tinyfish(context) {
  const { query, service, descriptor, signal } = context;
  const maxResults = resultLimit(context);
  const apiKey = asText(service?.apiKey).trim();
  if (apiKey.length === 0) throw new Error('TinyFish API key is required');

  const endpoint = resolveEndpoint({
    service,
    descriptor,
    endpoint: 'https://api.search.tinyfish.ai',
  });
  const url = new URL(endpoint);
  // Kelivo's `.replace(queryParameters:)` drops any pre-existing query string.
  url.search = '';
  const options = optionsOf(service);
  url.searchParams.set('query', query);
  for (const [optionKey, param] of [
    ['location', 'location'],
    ['language', 'language'],
    ['includeDomains', 'include_domains'],
    ['excludeDomains', 'exclude_domains'],
  ]) {
    const value = asText(options[optionKey]).trim();
    if (value.length > 0) url.searchParams.set(param, value);
  }

  const data = await requestJson(url.toString(), {
    method: 'GET',
    headers: { 'X-API-Key': apiKey },
    signal,
    timeoutMs: requestTimeout(context),
    provider: 'TinyFish',
  });

  const sources = mapSources(
    Array.isArray(data?.results) ? data.results : [],
    (item) => ({
      title: item?.title,
      url: item?.url,
      ...excerptFields(item?.snippet),
    }),
  ).slice(0, maxResults);
  return { sources };
}

/**
 * Brave: `GET /res/v1/web/search` (default) or `POST /res/v1/llm/context`.
 *
 * The catalog spells the mode `llm_context`, Kelivo's enum value is
 * `llmContext`; {@link normalizeBraveMode} accepts both. `country` is a DSH
 * catalog extra (not in Kelivo) and is forwarded as the web API's `country`
 * query parameter.
 *
 * @param {any} context - adapter context.
 * @returns {Promise<{sources: object[]}>} sources.
 */
export async function brave(context) {
  const { query, service, descriptor, signal } = context;
  const maxResults = resultLimit(context);
  const mode = normalizeBraveMode(optionsOf(service).mode);
  const tokenHeaders = authHeaders({
    service,
    auth: 'x-subscription-token',
    name: 'Brave',
  });

  if (mode === 'llmContext') {
    const endpoint = resolveBraveEndpoint(service, descriptor, 'llmContext');
    const tokens = clampInt(
      optionsOf(service).maximumNumberOfTokens ?? 8192,
      1024,
      32768,
    );
    const data = await requestJson(endpoint, {
      method: 'POST',
      headers: { ...tokenHeaders, Accept: 'application/json' },
      body: {
        q: query,
        count: maxResults,
        maximum_number_of_urls: maxResults,
        maximum_number_of_tokens: tokens,
      },
      signal,
      timeoutMs: requestTimeout(context),
      provider: 'Brave',
    });
    const generic = Array.isArray(data?.grounding?.generic) ? data.grounding.generic : [];
    const sources = mapSources(generic, (item) => ({
      title: item?.title,
      url: item?.url,
      ...excerptFields(joinTexts(item?.snippets)),
    })).slice(0, maxResults);
    return { sources };
  }

  const endpoint = resolveBraveEndpoint(service, descriptor, 'web');
  const url = new URL(endpoint);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(maxResults));
  const country = asText(optionsOf(service).country).trim();
  if (country.length > 0) url.searchParams.set('country', country);

  const data = await requestJson(url.toString(), {
    method: 'GET',
    headers: { ...tokenHeaders, Accept: 'application/json' },
    signal,
    timeoutMs: requestTimeout(context),
    provider: 'Brave',
  });

  const results = Array.isArray(data?.web?.results) ? data.web.results : [];
  const sources = mapSources(results, (item) => ({
    title: item?.title,
    url: item?.url,
    ...excerptFields(item?.description),
  })).slice(0, maxResults);
  return { sources };
}

/**
 * Resolve the Brave endpoint for a mode, deriving the llm/context sibling from
 * a custom `/web/search` URL when the user supplied one.
 *
 * @param {object} service - stored service.
 * @param {object|undefined} descriptor - catalog descriptor.
 * @param {'web'|'llmContext'} mode - Brave mode.
 * @returns {string} endpoint URL.
 */
function resolveBraveEndpoint(service, descriptor, mode) {
  const canonicalWeb = 'https://api.search.brave.com/res/v1/web/search';
  const canonicalLlm = 'https://api.search.brave.com/res/v1/llm/context';
  const canonical = mode === 'llmContext' ? canonicalLlm : canonicalWeb;
  const raw = asText(service?.baseURL).trim();
  if (mode === 'llmContext' && raw.length > 0) {
    try {
      const parsed = new URL(raw);
      if (parsed.pathname.endsWith('/web/search')) {
        parsed.pathname = parsed.pathname.replace(/\/web\/search$/u, '/llm/context');
        return parsed.toString();
      }
    } catch {
      // resolveEndpoint below reports the invalid URL consistently.
    }
  }
  return resolveEndpoint({ service, descriptor, endpoint: canonical });
}

/* ------------------------------------------------------------------ */
/* HTML scrapers (⚠️ fragile).                                        */
/* ------------------------------------------------------------------ */

/**
 * Extract class tokens from a raw attribute string.
 *
 * @param {string} attributes - tag attributes.
 * @returns {string[]} class tokens.
 */
function classTokens(attributes) {
  const match = /\bclass\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/iu.exec(attributes);
  if (match === null) return [];
  const raw = match[2] ?? match[3] ?? match[4] ?? '';
  return decodeHtmlEntities(raw).split(/\s+/u).filter((token) => token.length > 0);
}

/**
 * Read one attribute value from a raw attribute string.
 *
 * @param {string} attributes - tag attributes.
 * @param {string} name - attribute name (case-insensitive).
 * @returns {string} decoded attribute value, or ''.
 */
function attributeValue(attributes, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`\\b${escaped}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'iu').exec(
    attributes,
  );
  if (match === null) return '';
  return decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '').trim();
}

/**
 * Find the first element whose class list contains `classToken` and return its
 * attributes plus inner markup.
 *
 * Scans opening tags instead of matching whole elements so a matching element
 * nested inside an earlier same-tag wrapper is still found (e.g.
 * `.result__snippet` inside `.result__body`). The inner markup ends at the next
 * matching closing tag, which is exact for the leaf elements the scrapers read
 * and sufficient for their container-div markup.
 *
 * @param {string} html - HTML fragment.
 * @param {string} classToken - exact class token.
 * @param {string[]} [tags] - optional tag-name filter (lowercase).
 * @returns {{tag: string, attributes: string, inner: string}|null} first match.
 */
function findElementByClass(html, classToken, tags = undefined) {
  const allowed = tags === undefined ? null : new Set(tags);
  const open = /<([a-z][a-z0-9:-]*)\b([^>]*)>/giu;
  let match;
  while ((match = open.exec(html)) !== null) {
    const tag = match[1].toLowerCase();
    if (allowed !== null && !allowed.has(tag)) continue;
    if (!classTokens(match[2]).includes(classToken)) continue;
    const contentStart = match.index + match[0].length;
    const close = new RegExp(`</${tag}\\s*>`, 'giu');
    close.lastIndex = contentStart;
    const closing = close.exec(html);
    if (closing === null) continue;
    return {
      tag,
      attributes: match[2],
      inner: html.slice(contentStart, closing.index),
    };
  }
  return null;
}

/**
 * Split an HTML document into the chunks belonging to the first `limit`
 * elements carrying `classToken` (token match, not substring).
 *
 * @param {string} html - full document.
 * @param {string[]} tags - tag names that may carry the class.
 * @param {string} classToken - exact class token.
 * @param {number} limit - maximum number of chunks.
 * @returns {string[]} chunks of markup.
 */
function classChunks(html, tags, classToken, limit = Number.POSITIVE_INFINITY) {
  const regex = new RegExp(`<(${tags.join('|')})\\b([^>]*)>`, 'giu');
  /** @type {number[]} */
  const starts = [];
  let match;
  while ((match = regex.exec(html)) !== null) {
    if (classTokens(match[2]).includes(classToken)) {
      starts.push(match.index + match[0].length);
    }
  }
  return starts.slice(0, limit).map((start, index) => {
    const next = starts[index + 1];
    return next === undefined ? html.slice(start) : html.slice(start, next);
  });
}

/**
 * Resolve the locale used for Bing's `setlang` / `cc` parameters.
 *
 * Kelivo derives these from the Flutter app locale (`getService(options,
 * locale)`); the DSH Host has no per-user app locale, so the process locale is
 * the closest equivalent. Kelivo's rules are preserved: `zh-HK` searches in
 * English, and `us`/`cn`/`ru` are never sent as `cc` because they skew results.
 *
 * @returns {{language: string, country: string, tag: string}} locale facts.
 */
function resolveBingLocale() {
  let tag = 'en-US';
  try {
    tag = Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
  } catch {
    tag = 'en-US';
  }
  const parts = tag.split(/[-_]/u).filter((part) => part.length > 0);
  const language = (parts[0] ?? 'en').toLowerCase();
  let country = '';
  if (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (/^[a-z]{2}$/iu.test(last)) country = last.toLowerCase();
  }
  if (country.length === 0 && language === 'zh' && parts.some((part) => /^hant$/iu.test(part))) {
    country = 'tw';
  }
  return { language, country, tag };
}

/**
 * Resolve a Bing result href, decoding `/ck/a?u=a1<base64url>` tracking links.
 *
 * @param {string} rawHref - href attribute text.
 * @returns {string|null} absolute http(s) URL, or null when unusable.
 */
function resolveBingUrl(rawHref) {
  const href = asText(rawHref).trim();
  if (href.length === 0) return null;
  let url;
  try {
    url = new URL(href, 'https://www.bing.com');
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (
    (host === 'bing.com' || host.endsWith('.bing.com')) &&
    (url.pathname === '/ck/a' || url.pathname === '/ck/a/')
  ) {
    const target = url.searchParams.get('u');
    if (target !== null && target.startsWith('a1')) {
      try {
        url = new URL(Buffer.from(target.slice(2), 'base64url').toString('utf8'));
      } catch {
        return null;
      }
    }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.hostname.length === 0) return null;
  return url.toString();
}

/**
 * Bing Local — ⚠️ fragile HTML scraper.
 *
 * Re-implements Kelivo's `BingSearchService`: `ol#b_results > li.b_algo`,
 * title from `h2 > a`, snippet from all `<p>` (minus `span.algoSlug_icon`)
 * falling back to `.b_algoSlug`, `/ck/a` redirect unwrapping, duplicate URL
 * suppression, and a hard error when Bing answers with an unrecognized page
 * instead of a result list.
 *
 * @param {any} context - adapter context.
 * @returns {Promise<{sources: object[]}>} sources.
 */
export async function bingLocal(context) {
  const { query, signal } = context;
  const maxResults = resultLimit(context);
  const locale = resolveBingLocale();

  const url = new URL('https://www.bing.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('adlt', 'moderate');
  url.searchParams.set(
    'setlang',
    locale.language === 'zh' && locale.country === 'hk' ? 'en' : locale.language,
  );
  if (
    locale.country.length === 2 &&
    !['us', 'cn', 'ru'].includes(locale.country)
  ) {
    url.searchParams.set('cc', locale.country);
  }

  const acceptLanguage = [
    locale.language,
    ...(locale.tag !== locale.language ? [`${locale.tag};q=0.7`] : []),
    ...(locale.language !== 'en' ? ['en;q=0.3'] : []),
  ].join(',');

  const html = await requestText(url.toString(), {
    method: 'GET',
    headers: {
      'User-Agent': BING_USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': acceptLanguage,
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
    },
    signal,
    timeoutMs: requestTimeout(context),
    provider: 'Bing',
  });

  const hasResultsList = /<ol\b[^>]*\bid\s*=\s*["']b_results["']/iu.test(html);
  /** @type {Array<{url: string, title?: string, snippet?: string, summary?: string}>} */
  const sources = [];
  const seen = new Set();

  const listStart = html.search(/<ol\b[^>]*\bid\s*=\s*["']b_results["'][^>]*>/iu);
  if (listStart >= 0) {
    const afterList = html.slice(listStart);
    const listEnd = afterList.search(/<\/ol\s*>/iu);
    const region = listEnd >= 0 ? afterList.slice(0, listEnd) : afterList;
    for (const block of classChunks(region, ['li'], 'b_algo')) {
      const withoutIcon = block.replace(
        /<span\b[^>]*class\s*=\s*["'][^"']*\balgoSlug_icon\b[^"']*["'][^>]*>[\s\S]*?<\/span\s*>/giu,
        ' ',
      );
      const heading = /<h2\b[^>]*>([\s\S]*?)<\/h2\s*>/iu.exec(withoutIcon);
      const anchor =
        heading === null
          ? null
          : /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/iu.exec(heading[1]);
      if (anchor === null) continue;
      const title = htmlToText(anchor[2]);
      const resolved = resolveBingUrl(attributeValue(anchor[1], 'href'));
      if (title.length === 0 || resolved === null || seen.has(resolved)) continue;
      seen.add(resolved);

      const paragraphs = [...withoutIcon.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/giu)];
      const snippet =
        paragraphs.length > 0
          ? collapseWhitespace(paragraphs.map((entry) => htmlToText(entry[1])).join(' '))
          : htmlToText(findElementByClass(withoutIcon, 'b_algoSlug')?.inner ?? '');

      sources.push({
        url: resolved,
        ...(title.length > 0 ? { title } : {}),
        ...excerptFields(snippet),
      });
      if (sources.length >= maxResults) break;
    }
  }

  if (sources.length === 0) {
    const hasNoResultsMarker = /class\s*=\s*["'][^"']*\bb_no\b[^"']*["']/iu.test(html);
    if (!hasResultsList || !hasNoResultsMarker) {
      throw new Error('Bing returned an unrecognized search page. Please retry later.');
    }
  }

  return { sources };
}

/**
 * Resolve a DuckDuckGo result URL: protocol-relative links get `https:` and
 * `/l/?uddg=` redirects are unwrapped.
 *
 * @param {string} raw - href or `.result__url` text.
 * @returns {string} resolved URL (unchanged when unparseable).
 */
function resolveDuckDuckGoUrl(raw) {
  const value = asText(raw).trim();
  if (value.length === 0) return '';
  const normalized = value.startsWith('//') ? `https:${value}` : value;
  try {
    return new URL(normalized).searchParams.get('uddg') ?? normalized;
  } catch {
    return normalized;
  }
}

/**
 * DuckDuckGo (HTML endpoint) — ⚠️ fragile HTML scraper.
 *
 * Re-implements Kelivo's `DuckDuckGoSearchService`: `.result` blocks (capped at
 * `resultSize`), title from `.result__a`, URL from its `href` or the
 * `.result__url` text, snippet from `.result__snippet`, all-empty rows skipped.
 *
 * @param {any} context - adapter context.
 * @returns {Promise<{sources: object[]}>} sources.
 */
export async function duckduckgo(context) {
  const { query, signal } = context;
  const maxResults = resultLimit(context);
  const region = asText(optionsOf(context.service).region).trim() || 'us-en';

  const url = new URL('https://duckduckgo.com/html/');
  url.searchParams.set('q', query);
  url.searchParams.set('kl', region);

  const html = await requestText(url.toString(), {
    method: 'GET',
    headers: { 'User-Agent': DUCKDUCKGO_USER_AGENT },
    signal,
    timeoutMs: requestTimeout(context),
    provider: 'DuckDuckGo',
  });

  /** @type {Array<{url: string, title?: string, snippet?: string, summary?: string}>} */
  const sources = [];
  for (const block of classChunks(html, ['div', 'article'], 'result', maxResults)) {
    const anchor = findElementByClass(block, 'result__a', ['a']);
    const urlElement = findElementByClass(block, 'result__url');
    const snippetElement = findElementByClass(block, 'result__snippet');
    const title = anchor === null ? '' : htmlToText(anchor.inner);
    const rawUrl =
      anchor === null
        ? (urlElement === null ? '' : htmlToText(urlElement.inner))
        : attributeValue(anchor.attributes, 'href');
    const resolved = resolveDuckDuckGoUrl(rawUrl);
    const snippet = snippetElement === null ? '' : htmlToText(snippetElement.inner);
    if (title.length === 0 && resolved.length === 0 && snippet.length === 0) continue;
    if (resolved.length === 0) continue;
    sources.push({
      url: resolved,
      ...(title.length > 0 ? { title } : {}),
      ...excerptFields(snippet),
    });
    if (sources.length >= maxResults) break;
  }
  return { sources };
}
