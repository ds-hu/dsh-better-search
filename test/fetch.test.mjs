/**
 * Unit tests for the v2 web-fetch and usage adapters.
 *
 * Offline like `adapters.test.mjs`: every request goes through a fake `fetch`
 * installed with `http.js`'s `setFetchForTests`. Coverage: one success mapping
 * per fetch family, Markdown-title extraction, sibling-URL rewriting
 * (`/search` → `/extract|/contents|/scrape` and the TinyFish host swap),
 * non-2xx → `HttpFailure`, the v2 "parsed content behind a 4xx is a result"
 * rule, and both usage mappings plus their missing-field failures.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { PROVIDERS, providerOf } from '../lib/catalog.js';
import { firstMarkdownHeading } from '../lib/search/fetch.js';
import {
  FETCH_ADAPTERS,
  hasFetch,
  hasUsage,
  USAGE_ADAPTERS,
} from '../lib/search/index.js';
import { HttpFailure, setFetchForTests } from '../lib/search/http.js';

/** Restore the real fetch between tests. */
afterEach(() => {
  setFetchForTests(null);
});

/**
 * Build a realistic fetch/usage context for one catalog type.
 *
 * @param {string} type - catalog type id.
 * @param {{service?: object} & Record<string, unknown>} [overrides] - service fields / context overrides.
 * @returns {any} adapter context.
 */
function context(type, { service = {}, ...overrides } = {}) {
  const descriptor = providerOf(type);
  return {
    url: 'https://example.com/article',
    service: {
      id: 'svc_test',
      type,
      name: 'Test service',
      enabled: true,
      apiKey: 'test-key',
      baseURL: '',
      options: {},
      createdAt: '2026-11-17T00:00:00.000Z',
      ...service,
    },
    descriptor,
    timeoutMs: 30_000,
    ...overrides,
  };
}

/**
 * Install a fake fetch implementation and record each call.
 *
 * @param {(call: {url: string, init: any}, calls: any[]) => Response|Promise<Response>} respond - responder.
 * @returns {Array<{url: string, init: any}>} recorded requests.
 */
function installFetch(respond) {
  /** @type {Array<{url: string, init: any}>} */
  const calls = [];
  setFetchForTests(async (url, init = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return respond(call, calls);
  });
  return calls;
}

/**
 * JSON response helper.
 *
 * @param {unknown} payload - JSON body.
 * @param {number} [status] - HTTP status.
 * @returns {Response} response.
 */
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Plain-text response helper.
 *
 * @param {string} body - body text.
 * @param {number} [status] - HTTP status.
 * @returns {Response} response.
 */
function textResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

/**
 * Parse a recorded JSON request body.
 *
 * @param {{init: any}} call - recorded request.
 * @returns {any} parsed body.
 */
function bodyOf(call) {
  return JSON.parse(call.init.body);
}

/**
 * Run one fetch adapter.
 *
 * @param {string} type - catalog type id.
 * @param {any} ctx - context.
 * @returns {Promise<any>} outcome.
 */
function fetchWith(type, ctx) {
  return FETCH_ADAPTERS[type](ctx);
}

/* ------------------------------------------------------------------ */
/* Registry coverage.                                                 */
/* ------------------------------------------------------------------ */

test('FETCH_ADAPTERS matches the 13 fetch-capable catalog types; usage covers tavily+linkup', () => {
  const catalogFetchTypes = PROVIDERS.filter((provider) => provider.fetch === true)
    .map((provider) => provider.type)
    .sort();
  const adapterTypes = Object.keys(FETCH_ADAPTERS).sort();
  assert.equal(catalogFetchTypes.length, 13);
  assert.deepEqual(adapterTypes, catalogFetchTypes);
  for (const type of catalogFetchTypes) {
    assert.equal(hasFetch(type), true, type);
    assert.equal(typeof FETCH_ADAPTERS[type], 'function', type);
  }
  assert.equal(hasFetch('serper'), false);
  assert.equal(hasFetch('exa_mcp'), false, 'MCP transport is intentionally absent');

  assert.deepEqual(Object.keys(USAGE_ADAPTERS).sort(), ['linkup', 'tavily']);
  assert.equal(hasUsage('tavily'), true);
  assert.equal(hasUsage('linkup'), true);
  assert.equal(hasUsage('exa'), false);
});

test('firstMarkdownHeading extracts the first H1 only', () => {
  assert.equal(firstMarkdownHeading('# Page title\n\nBody'), 'Page title');
  assert.equal(firstMarkdownHeading('intro\n\n## Second level\n\n# Later title'), 'Later title');
  assert.equal(firstMarkdownHeading('no heading here\n\nbody'), '');
  assert.equal(firstMarkdownHeading(''), '');
});

/* ------------------------------------------------------------------ */
/* Fetch success mappings, one per family/provider.                   */
/* ------------------------------------------------------------------ */

test('tavily extract: bare-string urls body, raw_content content, heading title', async () => {
  const calls = installFetch(() =>
    jsonResponse({
      results: [
        {
          url: 'https://final.example/tavily',
          title: 'Tavily API title',
          raw_content: '# Tavily Page\n\nExtracted body text.',
        },
      ],
    }),
  );
  const outcome = await fetchWith('tavily', context('tavily'));

  assert.equal(calls[0].url, 'https://api.tavily.com/extract');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(bodyOf(calls[0]), {
    urls: 'https://example.com/article',
    format: 'markdown',
  });
  assert.deepEqual(outcome, {
    statusCode: 200,
    content: '# Tavily Page\n\nExtracted body text.',
    title: 'Tavily API title',
    finalUrl: 'https://final.example/tavily',
  });
});

test('tavily reports failed_results errors as a provider failure', async () => {
  installFetch(() => jsonResponse({ results: [], failed_results: [{ error: 'blocked' }] }));
  await assert.rejects(fetchWith('tavily', context('tavily')), /Tavily fetch failed: blocked/);
});

test('exa contents: array body, maxCharacters, API title, page URL', async () => {
  const calls = installFetch(() =>
    jsonResponse({
      statuses: [{ status: 'ok' }],
      results: [
        {
          url: 'https://final.example/exa',
          title: 'Exa Title',
          text: 'Exa extracted text.',
        },
      ],
    }),
  );
  const outcome = await fetchWith('exa', context('exa'));

  assert.equal(calls[0].url, 'https://api.exa.ai/contents');
  assert.deepEqual(bodyOf(calls[0]), {
    urls: ['https://example.com/article'],
    text: { maxCharacters: 100_000 },
  });
  assert.deepEqual(outcome, {
    statusCode: 200,
    content: 'Exa extracted text.',
    title: 'Exa Title',
    finalUrl: 'https://final.example/exa',
  });
});

test('exa honours the statuses[] error envelope', async () => {
  installFetch(() =>
    jsonResponse({
      statuses: [{ status: 'error', error: { tag: 'CRAWL_NOT_FOUND' } }],
      results: [],
    }),
  );
  await assert.rejects(fetchWith('exa', context('exa')), /Exa fetch failed: CRAWL_NOT_FOUND/);
});

test('linkup fetch: fixed endpoint, {url} body, provider title', async () => {
  const calls = installFetch(() =>
    jsonResponse({ title: 'LinkUp Title', markdown: '# LinkUp page\n\nBody.' }),
  );
  const outcome = await fetchWith('linkup', context('linkup'));

  assert.equal(calls[0].url, 'https://api.linkup.so/v1/fetch');
  assert.deepEqual(bodyOf(calls[0]), { url: 'https://example.com/article' });
  assert.equal(outcome.title, 'LinkUp Title');
  assert.equal(outcome.finalUrl, 'https://example.com/article');
});

test('metaso reader: Accept text/plain and a raw Markdown response body', async () => {
  const calls = installFetch(() => textResponse('# Metaso document\n\nPlain text body.'));
  const outcome = await fetchWith('metaso', context('metaso'));

  assert.equal(calls[0].url, 'https://metaso.cn/api/v1/reader');
  assert.equal(calls[0].init.headers.Accept, 'text/plain');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key');
  assert.equal(outcome.statusCode, 200);
  assert.equal(outcome.content, '# Metaso document\n\nPlain text body.');
  assert.equal(outcome.title, 'Metaso document');
});

test('ollama web fetch maps top-level title/content', async () => {
  const calls = installFetch(() =>
    jsonResponse({ title: 'Ollama Title', content: 'Ollama content body.' }),
  );
  const outcome = await fetchWith('ollama', context('ollama'));

  assert.equal(calls[0].url, 'https://ollama.com/api/web_fetch');
  assert.deepEqual(bodyOf(calls[0]), { url: 'https://example.com/article' });
  assert.equal(outcome.title, 'Ollama Title');
  assert.equal(outcome.content, 'Ollama content body.');
});

test('deepseek tools fetch maps top-level title/content', async () => {
  const calls = installFetch(() =>
    jsonResponse({ title: 'DeepSeek Title', content: 'DeepSeek content body.' }),
  );
  const outcome = await fetchWith('deepseek', context('deepseek'));

  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/tools/fetch');
  assert.equal(outcome.title, 'DeepSeek Title');
  assert.equal(outcome.content, 'DeepSeek content body.');
});

test('jina reader: optional Bearer, X-Retain-Images, data.title/url/content', async () => {
  const calls = installFetch(() =>
    jsonResponse({
      data: {
        url: 'https://final.example/jina',
        title: 'Jina Title',
        content: 'Jina extracted markdown.',
      },
    }),
  );
  const outcome = await fetchWith(
    'jina',
    context('jina', { service: { apiKey: '' } }),
  );

  assert.equal(calls[0].url, 'https://r.jina.ai/');
  assert.equal(calls[0].init.headers['X-Retain-Images'], 'none');
  assert.equal('Authorization' in calls[0].init.headers, false, 'empty key sends no header');
  assert.deepEqual(bodyOf(calls[0]), { url: 'https://example.com/article' });
  assert.deepEqual(outcome, {
    statusCode: 200,
    content: 'Jina extracted markdown.',
    title: 'Jina Title',
    finalUrl: 'https://final.example/jina',
  });
});

test('querit contents maps extrasMeta.title and content', async () => {
  const calls = installFetch(() =>
    jsonResponse({
      error_code: 200,
      results: [
        {
          url: 'https://final.example/querit',
          extrasMeta: { title: 'Querit Title' },
          content: 'Querit markdown body.',
        },
      ],
    }),
  );
  const outcome = await fetchWith('querit', context('querit'));

  assert.equal(calls[0].url, 'https://api.querit.ai/v1/contents');
  assert.deepEqual(bodyOf(calls[0]), {
    urls: ['https://example.com/article'],
    format: 'markdown',
    extrasMeta: true,
  });
  assert.equal(outcome.title, 'Querit Title');
  assert.equal(outcome.finalUrl, 'https://final.example/querit');
});

test('firecrawl scrape: sibling /scrape, data.markdown, array metadata title', async () => {
  const calls = installFetch(() =>
    jsonResponse({
      success: true,
      data: {
        markdown: '# Firecrawl Page\n\nBody.',
        metadata: {
          title: ['Firecrawl Title'],
          url: 'https://final.example/firecrawl',
        },
      },
    }),
  );
  const outcome = await fetchWith('firecrawl', context('firecrawl'));

  assert.equal(calls[0].url, 'https://api.firecrawl.dev/v2/scrape');
  assert.deepEqual(bodyOf(calls[0]), {
    url: 'https://example.com/article',
    formats: ['markdown'],
    onlyMainContent: true,
  });
  assert.equal(outcome.title, 'Firecrawl Title');
  assert.equal(outcome.finalUrl, 'https://final.example/firecrawl');
});

test('tinyfish swaps the search host for the fetch host and JSON-encodes non-string text', async () => {
  const calls = installFetch(() =>
    jsonResponse({
      results: [
        {
          title: 'TinyFish Title',
          text: { markdown: '# nested' },
          final_url: 'https://final.example/tiny',
        },
      ],
    }),
  );
  const outcome = await fetchWith('tinyfish', context('tinyfish'));

  assert.equal(calls[0].url, 'https://api.fetch.tinyfish.ai/');
  assert.equal(calls[0].init.headers['X-API-Key'], 'test-key');
  assert.deepEqual(bodyOf(calls[0]), {
    urls: ['https://example.com/article'],
    format: 'markdown',
  });
  assert.equal(outcome.title, 'TinyFish Title');
  assert.equal(outcome.content, JSON.stringify({ markdown: '# nested' }));
  assert.equal(outcome.finalUrl, 'https://final.example/tiny');
});

test('anysearch extract: sibling /extract and {code,data} envelope', async () => {
  const calls = installFetch(() =>
    jsonResponse({
      code: 0,
      data: {
        url: 'https://final.example/any',
        title: 'AnySearch Title',
        content: 'AnySearch markdown.',
      },
    }),
  );
  const outcome = await fetchWith('anysearch', context('anysearch'));

  assert.equal(calls[0].url, 'https://api.anysearch.com/v1/extract');
  assert.deepEqual(bodyOf(calls[0]), { url: 'https://example.com/article' });
  assert.equal(outcome.title, 'AnySearch Title');
  assert.equal(outcome.content, 'AnySearch markdown.');
});

test('parallel extract: lowercase x-api-key, advanced_settings, full_content', async () => {
  const calls = installFetch(() =>
    jsonResponse({
      results: [
        {
          url: 'https://final.example/parallel',
          title: 'Parallel Title',
          full_content: 'Parallel full content.',
        },
      ],
    }),
  );
  const outcome = await fetchWith('parallel', context('parallel'));

  assert.equal(calls[0].url, 'https://api.parallel.ai/v1/extract');
  assert.equal(calls[0].init.headers['x-api-key'], 'test-key');
  assert.deepEqual(bodyOf(calls[0]), {
    urls: ['https://example.com/article'],
    advanced_settings: { full_content: true },
  });
  assert.equal(outcome.title, 'Parallel Title');
  assert.equal(outcome.content, 'Parallel full content.');
});

test('you.com contents: list response and [0].markdown', async () => {
  const calls = installFetch(() =>
    jsonResponse([
      {
        url: 'https://final.example/you',
        title: 'You Title',
        markdown: '# You Page\n\nBody.',
      },
    ]),
  );
  const outcome = await fetchWith('you', context('you'));

  assert.equal(calls[0].url, 'https://ydc-index.io/v1/contents');
  assert.equal(calls[0].init.headers['X-API-Key'], 'test-key');
  assert.deepEqual(bodyOf(calls[0]), {
    urls: ['https://example.com/article'],
    formats: ['markdown'],
  });
  assert.equal(outcome.title, 'You Title');
  assert.equal(outcome.content, '# You Page\n\nBody.');
});

/* ------------------------------------------------------------------ */
/* Sibling URL behaviour.                                             */
/* ------------------------------------------------------------------ */

test('custom search URL is sibling-rewritten (tavily /tavily/search → /tavily/extract)', async () => {
  const calls = installFetch(() => jsonResponse({ results: [{ raw_content: 'body' }] }));
  await fetchWith(
    'tavily',
    context('tavily', {
      service: { baseURL: 'https://gateway.example.com/tavily/search' },
    }),
  );
  assert.equal(calls[0].url, 'https://gateway.example.com/tavily/extract');
});

test('custom search URL without /search fails with an actionable error', async () => {
  installFetch(() => jsonResponse({ results: [] }));
  await assert.rejects(
    fetchWith(
      'firecrawl',
      context('firecrawl', {
        service: { baseURL: 'https://gateway.example.com/firecrawl' },
      }),
    ),
    /Firecrawl custom URL must end with \/search to read pages/,
  );
});

/* ------------------------------------------------------------------ */
/* Failure paths.                                                     */
/* ------------------------------------------------------------------ */

test('fetch content is capped at 100k characters without splitting a surrogate pair', async () => {
  const huge = `# Huge page\n\n${'x'.repeat(100_010)}`;
  installFetch(() => jsonResponse({ title: 'Huge page', content: huge }));
  const capped = await fetchWith('ollama', context('ollama'));
  assert.equal(capped.content.length, 100_000);
  assert.equal(capped.truncated, true);
  assert.equal(capped.title, 'Huge page');

  const emojiAtBoundary = `${'a'.repeat(99_999)}\u{1F600}${'b'.repeat(10)}`;
  installFetch(() => jsonResponse({ content: emojiAtBoundary }));
  const guarded = await fetchWith('ollama', context('ollama'));
  assert.equal(guarded.content.length, 99_999, 'high surrogate at the cut is dropped');
  assert.equal(guarded.truncated, true);
});

test('transport failures expose the low-level cause code in the message', async () => {
  installFetch(() => {
    const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    throw new TypeError('fetch failed', { cause });
  });
  await assert.rejects(
    fetchWith('tavily', context('tavily')),
    /Tavily request failed: fetch failed \(ECONNRESET\)/,
  );

  installFetch(() => {
    const inner = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const cause = new AggregateError([inner], 'fetch failed');
    throw new TypeError('fetch failed', { cause });
  });
  await assert.rejects(
    fetchWith('ollama', context('ollama')),
    /Ollama request failed: fetch failed \(ECONNREFUSED\)/,
  );
});

test('non-2xx fetch responses throw HttpFailure with status and body', async () => {
  installFetch(() => new Response('server exploded', { status: 500 }));
  await assert.rejects(fetchWith('ollama', context('ollama')), (error) => {
    assert.ok(error instanceof HttpFailure);
    assert.equal(error.status, 500);
    assert.equal(error.message, 'Ollama HTTP 500: server exploded');
    return true;
  });
});

test('a parsed page behind a 4xx is still a fetch result (v2 status-code rule)', async () => {
  installFetch(() =>
    jsonResponse(
      {
        data: {
          url: 'https://final.example/archived',
          title: 'Archived page',
          content: '# Archived page\n\nStill readable.',
        },
      },
      404,
    ),
  );
  const outcome = await fetchWith('jina', context('jina'));
  assert.equal(outcome.statusCode, 404);
  assert.equal(outcome.title, 'Archived page');
  assert.equal(outcome.content, '# Archived page\n\nStill readable.');
});

/* ------------------------------------------------------------------ */
/* Usage adapters.                                                    */
/* ------------------------------------------------------------------ */

test('tavily usage reads account.plan_usage/plan_limit from /usage', async () => {
  const calls = installFetch(() =>
    jsonResponse({ account: { plan_usage: 80, plan_limit: 1000 } }),
  );
  const usage = await USAGE_ADAPTERS.tavily(context('tavily'));

  assert.equal(calls[0].url, 'https://api.tavily.com/usage');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(usage, { remaining: 920, used: 80, limit: 1000 });
});

test('tavily usage falls back to key.*, clamps remaining, appends /usage to custom base', async () => {
  const calls = installFetch(() => jsonResponse({ key: { usage: 250, limit: 200 } }));
  const usage = await USAGE_ADAPTERS.tavily(
    context('tavily', { service: { baseURL: 'https://gateway.example.com/tavily' } }),
  );

  assert.equal(calls[0].url, 'https://gateway.example.com/tavily/usage');
  assert.deepEqual(usage, { remaining: 0, used: 250, limit: 200 });
});

test('linkup usage reads balance as remaining credits', async () => {
  const calls = installFetch(() => jsonResponse({ balance: 12.5 }));
  const usage = await USAGE_ADAPTERS.linkup(context('linkup'));

  assert.equal(calls[0].url, 'https://api.linkup.so/v1/credits/balance');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(usage, { remaining: 12.5 });
});

test('usage responses with missing or non-numeric fields fail explicitly', async () => {
  installFetch(() => jsonResponse({}));
  await assert.rejects(
    USAGE_ADAPTERS.tavily(context('tavily')),
    /Tavily usage response is missing usage totals/,
  );

  installFetch(() => jsonResponse({ balance: '12.5' }));
  await assert.rejects(
    USAGE_ADAPTERS.linkup(context('linkup')),
    /LinkUp usage response is missing credit balance/,
  );
});

test('usage non-2xx responses throw HttpFailure', async () => {
  installFetch(() => jsonResponse({ error: 'unauthorized' }, 401));
  await assert.rejects(USAGE_ADAPTERS.tavily(context('tavily')), (error) => {
    assert.ok(error instanceof HttpFailure);
    assert.equal(error.status, 401);
    assert.match(error.message, /^Tavily HTTP 401: /u);
    return true;
  });
});
