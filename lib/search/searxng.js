/**
 * SearXNG adapter — self-hosted `GET <base>/search?format=json`.
 *
 * SearXNG has no API key concept: it is keyless by default and some instances
 * sit behind HTTP Basic auth. Kelivo therefore reads the credential from the
 * `username` / `password` options (the second is the only obscured secret
 * field), not from `apiKey`. This adapter preserves that, and additionally
 * accepts the rotated `service.apiKey` as a Basic credential (`user:password`,
 * or `user` with an empty password) when the option pair is empty, so the
 * panel's key rotation and its optional "用户名 / 密码" key field both work.
 *
 * There is no count parameter in the SearXNG JSON API (§5.2): the client caps
 * the mapped `results[]` at `maxResults`.
 *
 * @module @ds-hu/dsh-better-search/lib/search/searxng
 */
import {
  asText,
  excerptFields,
  mapSources,
  requestJson,
  requestTimeout,
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
 * Build `<instance>/search` from the configured instance base URL.
 *
 * The catalog marks the URL as required. A trailing slash is stripped; an
 * instance URL that already ends in `/search` is accepted as-is instead of
 * becoming `/search/search`.
 *
 * @param {object} service - stored service (uses `baseURL`).
 * @returns {URL} endpoint URL.
 * @throws {Error} when the base URL is missing or not a valid URL.
 */
function searxngEndpoint(service) {
  const raw = asText(service?.baseURL).trim();
  if (raw.length === 0) throw new Error('SearXNG instance URL is required');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    // Do not echo the raw value: an instance URL may embed credentials.
    throw new Error('Invalid SearXNG instance URL');
  }
  parsed.search = '';
  parsed.hash = '';
  const path = parsed.pathname.replace(/\/+$/u, '');
  parsed.pathname = /\/search$/u.test(path) ? path : `${path}/search`;
  return parsed;
}

/**
 * Build the optional Basic auth header.
 *
 * The `username`/`password` option pair wins when both are present (Kelivo
 * behaviour); otherwise the rotated `service.apiKey` is interpreted as
 * `user:password` or `user`.
 *
 * @param {object} service - stored service.
 * @returns {Record<string, string>} auth header (empty when unauthenticated).
 */
function searxngAuthHeader(service) {
  const options = optionsOf(service);
  const optionUser = asText(options.username).trim();
  const optionPassword = asText(options.password);
  let user = optionUser;
  let password = optionPassword;

  if (user.length === 0 && password.length === 0) {
    const key = asText(service?.apiKey).trim();
    if (key.length === 0) return {};
    const separator = key.indexOf(':');
    if (separator > 0) {
      user = key.slice(0, separator);
      password = key.slice(separator + 1);
    } else {
      user = key;
      password = '';
    }
  } else if (user.length === 0 || password.length === 0) {
    // Kelivo only sends Basic when username AND password are both non-empty.
    return {};
  }

  const encoded = Buffer.from(`${user}:${password}`, 'utf8').toString('base64');
  return { Authorization: `Basic ${encoded}` };
}

/**
 * Run one SearXNG search.
 *
 * @param {any} context - adapter context.
 * @returns {Promise<{sources: object[]}>} sources.
 */
export async function searxng(context) {
  const { query, service, signal } = context;
  const maxResults = resultLimit(context);
  const url = searxngEndpoint(service);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');

  const options = optionsOf(service);
  const engines = asText(options.engines).trim();
  if (engines.length > 0) url.searchParams.set('engines', engines);
  const language = asText(options.language).trim();
  if (language.length > 0) url.searchParams.set('language', language);

  const data = await requestJson(url.toString(), {
    method: 'GET',
    headers: searxngAuthHeader(service),
    signal,
    timeoutMs: requestTimeout(context),
    provider: 'SearXNG',
  });

  const results = Array.isArray(data?.results) ? data.results : [];
  const sources = mapSources(results, (item) => ({
    title: item?.title,
    url: item?.url,
    ...excerptFields(item?.content),
  })).slice(0, maxResults);
  return { sources };
}
