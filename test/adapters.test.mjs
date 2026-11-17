/**
 * Unit tests for the search-provider adapters.
 *
 * Every test injects a fake `fetch` through `http.js`'s `setFetchForTests`
 * seam, so the suite is offline and deterministic. For each adapter family the
 * tests cover one success mapping, the per-provider count clamp + `maxResults`
 * slice, a non-2xx response surfacing as `HttpFailure`, and empty results.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { PROVIDERS, providerOf } from '../lib/catalog.js';
import { ADAPTERS, hasAdapter, searchWith } from '../lib/search/index.js';
import { HttpFailure, requestJson, setFetchForTests } from '../lib/search/http.js';

/** Restore the real fetch between tests. */
afterEach(() => {
  setFetchForTests(null);
});

/**
 * Build a realistic `SearchContext` for one catalog type.
 *
 * @param {string} type - catalog type id.
 * @param {{service?: object} & Record<string, unknown>} [overrides] - service fields / context overrides.
 * @returns {any} adapter context.
 */
function context(type, { service = {}, ...overrides } = {}) {
  const descriptor = providerOf(type);
  return {
    query: 'dsh plugin',
    maxResults: 8,
    service: {
      id: 'svc_test',
      type,
      name: 'Test service',
      enabled: true,
      apiKey: 'test-key',
      apiKeys: ['rotated-extra-key'],
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
 * @param {Record<string, string>} [headers] - extra headers.
 * @returns {Response} response.
 */
function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * HTML response helper.
 *
 * @param {string} body - HTML body.
 * @param {number} [status] - HTTP status.
 * @returns {Response} response.
 */
function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
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

/* ------------------------------------------------------------------ */
/* Registry / shared HTTP behaviour.                                  */
/* ------------------------------------------------------------------ */

test('ADAPTERS covers exactly the 26 catalog types and excludes the special transports', () => {
  const catalogTypes = PROVIDERS.map((provider) => provider.type).sort();
  const adapterTypes = Object.keys(ADAPTERS).sort();
  assert.equal(catalogTypes.length, 26);
  assert.deepEqual(adapterTypes, catalogTypes);
  for (const descriptor of PROVIDERS) {
    assert.equal(hasAdapter(descriptor.type), true, descriptor.type);
    assert.equal(typeof ADAPTERS[descriptor.type], 'function', descriptor.type);
  }
  assert.equal(hasAdapter('exa_mcp'), false, 'MCP transport is intentionally absent');
  assert.equal(hasAdapter('kelivo'), false, 'built-in embedded credential is intentionally absent');
  assert.equal(hasAdapter('not-a-provider'), false);
});

test('searchWith rejects an unknown type and trims content', async () => {
  await assert.rejects(searchWith('not-a-provider', context('tavily')), /Unsupported search provider type/);

  installFetch(() =>
    jsonResponse({
      results: [
        { title: 'Alpha', url: 'https://alpha.example', content: 'Alpha excerpt' },
        { title: 'Beta', url: 'https://beta.example', content: 'Beta excerpt' },
      ],
      answer: '  Answer from the provider.  ',
    }),
  );
  const outcome = await searchWith('tavily', context('tavily', { maxResults: 1 }));
  assert.equal(outcome.sources.length, 1, 'searchWith slices sources to maxResults');
  assert.equal(outcome.sources[0].url, 'https://alpha.example');
  assert.equal(outcome.content, 'Answer from the provider.');
});

test('non-2xx responses throw HttpFailure with status and a truncated body', async () => {
  installFetch(() => new Response('x'.repeat(800), { status: 503 }));
  await assert.rejects(
    requestJson('https://example.invalid/search', { provider: 'TestBad', timeoutMs: 1000 }),
    (error) => {
      assert.ok(error instanceof HttpFailure);
      assert.equal(error.name, 'HttpFailure');
      assert.equal(error.status, 503);
      assert.match(error.message, /^TestBad HTTP 503: /u);
      assert.match(error.message, /…$/u, 'long bodies are truncated');
      assert.ok(error.message.length < 320);
      return true;
    },
  );
});

/* ------------------------------------------------------------------ */
/* json-api family.                                                   */
/* ------------------------------------------------------------------ */

test('tavily maps results + answer, sends name/body/auth and ignores apiKeys rotation pool', async () => {
  const calls = installFetch(() =>
    jsonResponse({
      results: [{ title: 'Tavily hit', url: 'https://tavily.example/1', content: 'Tavily content' }],
      answer: 'Tavily answer',
    }),
  );
  const outcome = await searchWith('tavily', context('tavily', { maxResults: 8 }));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.tavily.com/search');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key', 'uses service.apiKey only');
  assert.deepEqual(bodyOf(calls[0]), { query: 'dsh plugin', max_results: 8 });

  assert.equal(outcome.content, 'Tavily answer');
  assert.deepEqual(outcome.sources, [
    {
      url: 'https://tavily.example/1',
      title: 'Tavily hit',
      snippet: 'Tavily content',
      summary: 'Tavily content',
    },
  ]);
});

test('exa sends numResults/contents and honours the searchType catalog extra', async () => {
  const calls = installFetch(() =>
    jsonResponse({
      results: [{ title: 'Exa hit', url: 'https://exa.example/1', text: 'Exa page text' }],
    }),
  );
  const outcome = await searchWith(
    'exa',
    context('exa', { maxResults: 3, service: { options: { searchType: 'neural' } } }),
  );

  assert.deepEqual(bodyOf(calls[0]), {
    query: 'dsh plugin',
    numResults: 3,
    contents: { text: true },
    type: 'neural',
  });
  assert.equal(outcome.sources[0].url, 'https://exa.example/1');
  assert.equal(outcome.sources[0].snippet, 'Exa page text');
});

test('ollama clamps the server count to 1-10 and surfaces non-2xx as HttpFailure', async () => {
  const calls = installFetch(() => jsonResponse({ error: 'rate limited' }, 429));
  await assert.rejects(
    searchWith('ollama', context('ollama', { maxResults: 50 })),
    (error) => {
      assert.ok(error instanceof HttpFailure);
      assert.equal(error.status, 429);
      assert.equal(error.message, 'Ollama HTTP 429: {"error":"rate limited"}');
      return true;
    },
  );
  assert.equal(bodyOf(calls[0]).max_results, 10);
});

test('deepseek clamps count to 1-50 and maps summary + UTC publishedAt', async () => {
  const calls = installFetch(() =>
    jsonResponse({
      results: [
        {
          title: 'Deep hit',
          url: 'https://deep.example/1',
          summary: 'Deep summary',
          snippet: 'ignored snippet',
          date: '2026-01-02T03:04:05Z',
        },
        {
          title: 'Local date hit',
          url: 'https://deep.example/2',
          snippet: 'local date',
          date: '2026-01-02',
        },
      ],
    }),
  );
  const outcome = await searchWith('deepseek', context('deepseek', { maxResults: 99 }));

  assert.deepEqual(bodyOf(calls[0]), { query: 'dsh plugin', count: 50, need_content: false });
  assert.equal(outcome.sources.length, 2);
  assert.equal(outcome.sources[0].snippet, 'Deep summary');
  assert.equal(outcome.sources[0].summary, 'Deep summary');
  assert.equal(outcome.sources[0].publishedAt, '2026-01-02T03:04:05Z');
  assert.equal(outcome.sources[1].snippet, 'local date');
  assert.equal(outcome.sources[1].publishedAt, undefined, 'zone-less date is not a UTC timestamp');
});

test('jina returns empty sources for an empty payload without inventing content', async () => {
  installFetch(() => jsonResponse({ data: [] }));
  const outcome = await searchWith('jina', context('jina'));
  assert.deepEqual(outcome.sources, []);
  assert.equal('content' in outcome, false);
});

test('kimi joins chunks, falls back to snippet and uses search_pro by default', async () => {
  const calls = installFetch(() =>
    jsonResponse({
      search_results: [
        {
          title: 'Kimi hit',
          url: 'https://kimi.example/1',
          chunks: [{ text: 'chunk one' }, { text: '  ' }, { text: 'chunk two' }],
          snippet: 'fallback snippet',
        },
        { title: 'Kimi basic hit', url: 'https://kimi.example/2', snippet: 'snippet only' },
      ],
    }),
  );
  const outcome = await searchWith('kimi', context('kimi', { maxResults: 5 }));

  assert.match(calls[0].url, /api\.moonshot\.cn\/v1\/tools\/search_pro$/u);
  const body = bodyOf(calls[0]);
  assert.equal(body.text_query, 'dsh plugin');
  assert.equal(body.limit, 5);
  assert.equal(body.timeout_seconds, 30);
  assert.equal(outcome.sources[0].snippet, 'chunk one\n\nchunk two');
  assert.equal(outcome.sources[1].snippet, 'snippet only');
});

test('kagi requires 200 status + empty error[] and decodes HTML entities', async () => {
  installFetch(() =>
    jsonResponse({
      data: {
        search: [
          { title: 'Tom &amp; Jerry', url: 'https://kagi.example/1', snippet: 'A &lt;b&gt; tag' },
          { title: '', url: 'https://kagi.example/skipped', snippet: 'no title' },
        ],
      },
    }),
  );
  const okOutcome = await searchWith('kagi', context('kagi'));
  assert.deepEqual(okOutcome.sources, [
    {
      url: 'https://kagi.example/1',
      title: 'Tom & Jerry',
      snippet: 'A <b> tag',
      summary: 'A <b> tag',
    },
  ]);

  installFetch(() => jsonResponse({ error: [{ message: 'Unauthorized API key' }] }));
  await assert.rejects(searchWith('kagi', context('kagi')), /Kagi API error: Unauthorized API key/);
});

test('firecrawl merges data.web then data.news under the same limit', async () => {
  installFetch(() =>
    jsonResponse({
      data: {
        web: [
          { title: 'Web 1', url: 'https://web.example/1', description: 'desc 1' },
          { title: 'Web 2', url: 'https://web.example/2', snippet: 'desc 2' },
        ],
        news: [
          { title: 'News 1', url: 'https://news.example/1', markdown: 'news 1' },
          { title: 'News 2', url: 'https://news.example/2', description: 'news 2' },
        ],
      },
    }),
  );
  const outcome = await searchWith('firecrawl', context('firecrawl', { maxResults: 3 }));
  assert.deepEqual(
    outcome.sources.map((source) => source.url),
    ['https://web.example/1', 'https://web.example/2', 'https://news.example/1'],
  );
});

test('perplexity clamps max_results to 1-20 and flattens nested result lists', async () => {
  const calls = installFetch(() =>
    jsonResponse({
      results: [
        [{ title: 'P1', url: 'https://p.example/1', snippet: 's1' }],
        [
          { title: 'P2', url: 'https://p.example/2', snippet: 's2' },
          { title: 'P3', url: 'https://p.example/3', snippet: 's3' },
        ],
      ],
    }),
  );
  const outcome = await searchWith('perplexity', context('perplexity', { maxResults: 50 }));

  assert.equal(bodyOf(calls[0]).max_results, 20);
  assert.deepEqual(
    outcome.sources.map((source) => source.url),
    ['https://p.example/1', 'https://p.example/2', 'https://p.example/3'],
  );
});

test('querit builds filters from options and maps joined snippets', async () => {
  const calls = installFetch(() =>
    jsonResponse({
      results: {
        result: [
          {
            title: '',
            url: 'https://q.example/1',
            snippet: 'first',
            snippets: ['second', 'first'],
          },
        ],
      },
    }),
  );
  const outcome = await searchWith(
    'querit',
    context('querit', {
      maxResults: 4,
      service: {
        options: {
          sitesInclude: 'a.com\nb.com',
          sitesExclude: 'c.com',
          timeRange: 'd7',
          countries: 'united states, japan',
          languages: 'english',
        },
      },
    }),
  );

  assert.deepEqual(bodyOf(calls[0]), {
    query: 'dsh plugin',
    count: 4,
    filters: {
      sites: { include: ['a.com', 'b.com'], exclude: ['c.com'] },
      timeRange: { date: 'd7' },
      geo: { countries: { include: ['united states', 'japan'] } },
      languages: { include: ['english'] },
    },
  });
  assert.equal(outcome.sources[0].title, 'https://q.example/1');
  assert.equal(outcome.sources[0].snippet, 'first\n\nsecond');
});

test('anysearch maps data.results and surfaces the {code,message} envelope', async () => {
  const calls = installFetch(() =>
    jsonResponse({
      code: 0,
      data: {
        results: [{ title: 'Any hit', url: 'https://any.example/1', snippet: '  ', content: 'content fallback' }],
      },
    }),
  );
  const outcome = await searchWith('anysearch', context('anysearch'));
  assert.deepEqual(bodyOf(calls[0]), {
    query: 'dsh plugin',
    max_results: 8,
    format: 'json',
  });
  assert.equal(outcome.sources[0].snippet, 'content fallback');

  installFetch(() => jsonResponse({ code: 1001, message: 'quota exceeded', request_id: 'req_1' }));
  await assert.rejects(
    searchWith('anysearch', context('anysearch')),
    /AnySearch API error: quota exceeded \(request_id: req_1\)/,
  );
});

/* ------------------------------------------------------------------ */
/* envelopes family.                                                  */
/* ------------------------------------------------------------------ */

test('zhipu maps search_result[] with link/content and count only', async () => {
  const calls = installFetch(() =>
    jsonResponse({
      search_result: [{ title: 'Zhipu hit', link: 'https://zhipu.example/1', content: 'Zhipu content' }],
    }),
  );
  const outcome = await searchWith('zhipu', context('zhipu', { maxResults: 6 }));

  assert.deepEqual(bodyOf(calls[0]), {
    search_query: 'dsh plugin',
    search_engine: 'search_std',
    count: 6,
  });
  assert.equal(outcome.sources[0].url, 'https://zhipu.example/1');
  assert.equal(outcome.sources[0].snippet, 'Zhipu content');
});

test('linkup returns answer content plus capped sources', async () => {
  const calls = installFetch(() =>
    jsonResponse({
      answer: 'LinkUp sourced answer',
      sources: [
        { name: 'Link 1', url: 'https://linkup.example/1', snippet: 'snippet 1' },
        { name: 'Link 2', url: 'https://linkup.example/2', snippet: 'snippet 2' },
      ],
    }),
  );
  const outcome = await searchWith('linkup', context('linkup', { maxResults: 1 }));

  assert.deepEqual(bodyOf(calls[0]), {
    q: 'dsh plugin',
    depth: 'standard',
    outputType: 'sourcedAnswer',
    includeImages: 'false',
  });
  assert.equal(outcome.content, 'LinkUp sourced answer');
  assert.equal(outcome.sources.length, 1);
  assert.equal(outcome.sources[0].title, 'Link 1');
});

test('grok maps Responses output_text to content and citations/annotations to sources', async () => {
  const calls = installFetch(() =>
    jsonResponse({
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'Grok answer',
              annotations: [
                { type: 'url_citation', url: 'https://cit1.example', title: 'Duplicate annotation' },
                { type: 'url_citation', url: 'https://ann2.example', title: 'Annotation two' },
              ],
            },
          ],
        },
      ],
      citations: [
        { type: 'url_citation', url: 'https://cit1.example', title: 'Citation one' },
        'https://cit2.example',
      ],
    }),
  );
  const outcome = await searchWith('grok', context('grok'));

  const body = bodyOf(calls[0]);
  assert.equal(body.model, 'grok-4.5');
  assert.deepEqual(body.reasoning, { effort: 'low' });
  assert.deepEqual(body.store, false);
  assert.deepEqual(body.stream, false);
  assert.equal(body.input.length, 2);
  assert.equal(body.input[1].content, 'dsh plugin');

  assert.equal(outcome.content, 'Grok answer');
  assert.deepEqual(outcome.sources, [
    { url: 'https://cit1.example', title: 'Citation one' },
    { url: 'https://cit2.example', title: 'https://cit2.example' },
    { url: 'https://ann2.example', title: 'Annotation two' },
  ]);
});

test('bocha non-2xx becomes HttpFailure and metaso empty results stay empty', async () => {
  installFetch(() => new Response('boom', { status: 500 }));
  await assert.rejects(searchWith('bocha', context('bocha')), (error) => {
    assert.ok(error instanceof HttpFailure);
    assert.equal(error.status, 500);
    assert.equal(error.message, 'Bocha HTTP 500: boom');
    return true;
  });

  installFetch(() => jsonResponse({ webpages: [] }));
  const outcome = await searchWith('metaso', context('metaso'));
  assert.deepEqual(outcome.sources, []);
});

test('doubao clamps Count to 1-50 and requires a non-empty key', async () => {
  const calls = installFetch(() =>
    jsonResponse({
      Result: {
        WebResults: [
          { Title: 'Doubao 1', Url: 'https://doubao.example/1', Summary: 'summary 1' },
          { Title: 'Doubao skipped', Url: '', Content: 'no url' },
          { Title: 'Doubao 2', Url: 'https://doubao.example/2', Snippet: 'snippet 2' },
        ],
      },
    }),
  );
  const outcome = await searchWith('doubao', context('doubao', { maxResults: 99 }));
  assert.equal(bodyOf(calls[0]).Count, 50);
  assert.deepEqual(outcome.sources.map((source) => source.url), [
    'https://doubao.example/1',
    'https://doubao.example/2',
  ]);
  assert.equal(outcome.sources[0].snippet, 'summary 1');

  await assert.rejects(
    searchWith('doubao', context('doubao', { service: { apiKey: '' } })),
    /Doubao API key is required/,
  );
});

/* ------------------------------------------------------------------ */
/* flat family.                                                       */
/* ------------------------------------------------------------------ */

test('serper sends X-API-Key, gl/hl and maps organic[]', async () => {
  const calls = installFetch(() =>
    jsonResponse({
      organic: [
        { title: 'Serper hit', link: 'https://serper.example/1', snippet: 'serper snippet' },
      ],
    }),
  );
  const outcome = await searchWith(
    'serper',
    context('serper', { service: { options: { gl: 'cn', hl: 'zh-cn', tbs: '', page: '1' } } }),
  );

  assert.equal(calls[0].url, 'https://google.serper.dev/search');
  assert.equal(calls[0].init.headers['X-API-Key'], 'test-key');
  assert.deepEqual(bodyOf(calls[0]), { q: 'dsh plugin', gl: 'cn', hl: 'zh-cn' });
  assert.equal(outcome.sources[0].url, 'https://serper.example/1');
  assert.equal(outcome.sources[0].snippet, 'serper snippet');
});

test('you merges web+news, joins highlights and slices to maxResults', async () => {
  const calls = installFetch(() =>
    jsonResponse({
      results: {
        web: [
          { title: 'You web', url: 'https://you.example/web', contents: { highlights: ['h1', 'h2'] } },
          { title: 'You web 2', url: 'https://you.example/web2', snippets: ['s1'], description: 'd1' },
        ],
        news: [{ title: 'You news', url: 'https://you.example/news', description: 'news desc' }],
      },
    }),
  );
  const outcome = await searchWith('you', context('you', { maxResults: 2 }));

  assert.equal(calls[0].init.headers['X-API-Key'], 'test-key');
  assert.deepEqual(bodyOf(calls[0]), {
    query: 'dsh plugin',
    count: 2,
    extraction: { extraction_mode: 'highlights' },
  });
  assert.deepEqual(
    outcome.sources.map((source) => source.url),
    ['https://you.example/web', 'https://you.example/web2'],
  );
  assert.equal(outcome.sources[0].snippet, 'h1\n\nh2');
  assert.equal(outcome.sources[1].snippet, 's1');
});

test('tinyfish uses GET query params and X-API-Key', async () => {
  const calls = installFetch(() =>
    jsonResponse({
      results: [{ title: 'Fish hit', url: 'https://fish.example/1', snippet: 'fish snippet' }],
    }),
  );
  const outcome = await searchWith(
    'tinyfish',
    context('tinyfish', {
      service: { options: { location: 'US', language: 'en', includeDomains: 'a.com' } },
    }),
  );

  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].init.headers['X-API-Key'], 'test-key');
  const url = new URL(calls[0].url);
  assert.equal(url.origin, 'https://api.search.tinyfish.ai');
  assert.equal(url.searchParams.get('query'), 'dsh plugin');
  assert.equal(url.searchParams.get('location'), 'US');
  assert.equal(url.searchParams.get('language'), 'en');
  assert.equal(url.searchParams.get('include_domains'), 'a.com');
  assert.equal(outcome.sources[0].url, 'https://fish.example/1');
});

test('brave web mode sends count/country and maps web.results[]', async () => {
  const calls = installFetch(() =>
    jsonResponse({
      web: {
        results: [{ title: 'Brave hit', url: 'https://brave.example/1', description: 'brave desc' }],
      },
    }),
  );
  const outcome = await searchWith(
    'brave',
    context('brave', { maxResults: 4, service: { options: { mode: 'web', country: 'US' } } }),
  );

  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers['X-Subscription-Token'], 'test-key');
  const url = new URL(calls[0].url);
  assert.equal(`${url.origin}${url.pathname}`, 'https://api.search.brave.com/res/v1/web/search');
  assert.equal(url.searchParams.get('q'), 'dsh plugin');
  assert.equal(url.searchParams.get('count'), '4');
  assert.equal(url.searchParams.get('country'), 'US');
  assert.equal(outcome.sources[0].snippet, 'brave desc');
});

test('brave llm_context mode posts grounding.generic snippets', async () => {
  const calls = installFetch(() =>
    jsonResponse({
      grounding: {
        generic: [
          { title: 'Brave llm', url: 'https://brave.example/llm', snippets: ['first', 'second'] },
        ],
      },
    }),
  );
  const outcome = await searchWith(
    'brave',
    context('brave', {
      maxResults: 3,
      service: { options: { mode: 'llm_context', maximumNumberOfTokens: '4096' } },
    }),
  );

  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].url, 'https://api.search.brave.com/res/v1/llm/context');
  assert.deepEqual(bodyOf(calls[0]), {
    q: 'dsh plugin',
    count: 3,
    maximum_number_of_urls: 3,
    maximum_number_of_tokens: 4096,
  });
  assert.equal(outcome.sources[0].snippet, 'first\n\nsecond');
});

test('bing_local scrapes b_algo results, decodes /ck/a redirects and dedupes URLs', async () => {
  const redirected = Buffer.from('https://example.org/b', 'utf8').toString('base64url');
  const html = `<!doctype html><html><body><ol id="b_results">
    <li class="b_algo">
      <h2><a href="https://example.com/a">Example &amp; One</a></h2>
      <div class="b_caption"><p>First <strong>snippet</strong> text. <span class="algoSlug_icon">Web</span></p></div>
    </li>
    <li class="b_algo">
      <h2><a href="https://example.com/a">Duplicate URL</a></h2>
      <p>duplicate</p>
    </li>
    <li class="b_algo">
      <h2><a href="/ck/a?u=a1${redirected}&amp;ntb=1">Example Two</a></h2>
      <div class="b_caption"><p>Second snippet.</p></div>
    </li>
  </ol></body></html>`;
  const calls = installFetch(() => htmlResponse(html));
  const outcome = await searchWith('bing_local', context('bing_local', { maxResults: 2 }));

  const url = new URL(calls[0].url);
  assert.equal(`${url.origin}${url.pathname}`, 'https://www.bing.com/search');
  assert.equal(url.searchParams.get('q'), 'dsh plugin');
  assert.equal(url.searchParams.get('adlt'), 'moderate');
  assert.match(calls[0].init.headers['User-Agent'], /Chrome\/133/u);

  assert.deepEqual(outcome.sources, [
    {
      url: 'https://example.com/a',
      title: 'Example & One',
      snippet: 'First snippet text.',
      summary: 'First snippet text.',
    },
    {
      url: 'https://example.org/b',
      title: 'Example Two',
      snippet: 'Second snippet.',
      summary: 'Second snippet.',
    },
  ]);
});

test('bing_local throws when Bing returns an unrecognized page', async () => {
  installFetch(() => htmlResponse('<html><body>no results here</body></html>'));
  await assert.rejects(
    searchWith('bing_local', context('bing_local')),
    /unrecognized search page/u,
  );
});

test('duckduckgo scrapes .result blocks, unwraps uddg redirects and skips empty rows', async () => {
  const html = `<html><body>
    <div class="result results_links results_links_deep web-result">
      <div class="links_main links_deep result__body">
        <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone&amp;rut=abc">First <b>Result</b></a></h2>
        <a class="result__snippet" href="#">Snippet one &amp; more</a>
      </div>
    </div>
    <div class="result"></div>
    <div class="result results_links">
      <a class="result__a" href="https://example.net/three">Third Result</a>
      <div class="result__snippet">Snippet three</div>
    </div>
  </body></html>`;
  const calls = installFetch(() => htmlResponse(html));
  const outcome = await searchWith('duckduckgo', context('duckduckgo', { maxResults: 3 }));

  const url = new URL(calls[0].url);
  assert.equal(`${url.origin}${url.pathname}`, 'https://duckduckgo.com/html/');
  assert.equal(url.searchParams.get('q'), 'dsh plugin');
  assert.equal(url.searchParams.get('kl'), 'us-en');
  assert.match(calls[0].init.headers['User-Agent'], /Chrome\/124/u);

  assert.deepEqual(
    outcome.sources.map((source) => source.url),
    ['https://example.com/one', 'https://example.net/three'],
  );
  assert.equal(outcome.sources[0].title, 'First Result');
  assert.equal(outcome.sources[0].snippet, 'Snippet one & more');
});

/* ------------------------------------------------------------------ */
/* searxng family.                                                    */
/* ------------------------------------------------------------------ */

test('searxng builds /search, sends engines/language and Basic auth from options', async () => {
  const calls = installFetch(() =>
    jsonResponse({
      results: [
        { title: 'Searx 1', url: 'https://searx.example/1', content: 'searx content 1' },
        { title: 'Searx 2', url: 'https://searx.example/2', content: 'searx content 2' },
        { title: 'Searx 3', url: 'https://searx.example/3', content: 'searx content 3' },
      ],
    }),
  );
  const outcome = await searchWith(
    'searxng',
    context('searxng', {
      maxResults: 2,
      service: {
        apiKey: '',
        baseURL: 'https://searx.example.com/',
        options: {
          engines: 'google,bing',
          language: 'zh-CN',
          username: 'alice',
          password: 's3cret',
        },
      },
    }),
  );

  const url = new URL(calls[0].url);
  assert.equal(`${url.origin}${url.pathname}`, 'https://searx.example.com/search');
  assert.equal(url.searchParams.get('q'), 'dsh plugin');
  assert.equal(url.searchParams.get('format'), 'json');
  assert.equal(url.searchParams.get('engines'), 'google,bing');
  assert.equal(url.searchParams.get('language'), 'zh-CN');
  assert.equal(
    calls[0].init.headers.Authorization,
    `Basic ${Buffer.from('alice:s3cret', 'utf8').toString('base64')}`,
  );
  assert.deepEqual(outcome.sources.map((source) => source.url), [
    'https://searx.example/1',
    'https://searx.example/2',
  ]);
});

test('searxng requires an instance URL', async () => {
  installFetch(() => jsonResponse({ results: [] }));
  await assert.rejects(searchWith('searxng', context('searxng')), /SearXNG instance URL is required/);
});
