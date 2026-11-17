/**
 * Host-side tests: store (v1→v2 migration included), registry and HTTP router
 * together, with fake `ctx.web`/`ctx.settings` and injected adapters.
 * No network, no real Harness.
 *
 * Run: node --test test/host.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import { API_PREFIX, createApi } from '../lib/api.js';
import { PROVIDERS, providerOf } from '../lib/catalog.js';
import { createRegistry } from '../lib/registry.js';
import { createStore, DEFAULT_COMMON, maskKey } from '../lib/store.js';

/** One fake Harness context with the two services the plugin talks to. */
function fakeHarness() {
  const search = new Map();
  const fetch = new Map();
  const updates = [];
  const settingsState = {
    value: { searchProvider: 'deepseek-search-api', fetchProvider: 'deepseek-fetch-api' },
    revision: 1,
  };
  const settings = {
    describe: () => [{ ns: 'web', value: { ...settingsState.value }, revision: settingsState.revision }],
    update: async (ns, patch, revision) => {
      updates.push({ ns, patch, revision });
      Object.assign(settingsState.value, patch);
      settingsState.revision += 1;
    },
  };
  const web = {
    registerSearchProvider(provider) {
      assert.equal(search.has(provider.id), false, `duplicate search provider ${provider.id}`);
      search.set(provider.id, provider);
      return () => search.delete(provider.id);
    },
    registerFetchProvider(provider) {
      assert.equal(fetch.has(provider.id), false, `duplicate fetch provider ${provider.id}`);
      fetch.set(provider.id, provider);
      return () => fetch.delete(provider.id);
    },
  };
  const ctx = {
    get: (name) => (name === 'web' ? web : name === 'settings' ? settings : undefined),
    logger: { info() {}, warn() {}, error() {} },
  };
  return { ctx, search, fetch, updates, settingsState };
}

/** Minimal request object matching what `readBody` consumes. */
function makeReq({ method = 'GET', url = '/', body, headers = {} }) {
  const listeners = new Map();
  const req = {
    method,
    url,
    headers: { ...headers },
    on(event, callback) {
      const list = listeners.get(event) ?? [];
      list.push(callback);
      listeners.set(event, list);
      return req;
    },
    destroy() {},
  };
  queueMicrotask(() => {
    if (body !== undefined) {
      const buffer = Buffer.from(JSON.stringify(body));
      for (const callback of listeners.get('data') ?? []) callback(buffer);
    }
    for (const callback of listeners.get('end') ?? []) callback();
  });
  return req;
}

/** Minimal response object capturing status, headers and body. */
function makeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? {};
      this.headersSent = true;
    },
    end(body) {
      this.body = body ?? '';
    },
  };
}

describe('dsh-better-search host', () => {
  let dir;
  let store;
  let registry;
  let api;
  let harness;

  const adapters = {
    tavily: async (context) => ({
      sources: [{ url: 'https://tavily.test/1', title: context.query }],
      content: 'answer text',
    }),
    brave: async () => ({ sources: [{ url: 'https://brave.test/1' }] }),
  };
  const fetchAdapters = {
    tavily: async (context) => ({ statusCode: 200, content: `# Fetched\n\n${context.url}`, title: 'Fetched' }),
  };
  const usageAdapters = {
    tavily: async () => ({ remaining: 900, used: 100, limit: 1000 }),
  };

  /**
   * Call one API route.
   * @param {object} request - request spec.
   * @returns {Promise<{status: number, json: any, raw: any}>} response.
   */
  async function call(request) {
    const res = makeRes();
    const req = makeReq({
      method: request.method ?? 'GET',
      url: `${API_PREFIX}${request.path ?? '/'}`,
      body: request.body,
      headers: {
        host: '127.0.0.1:3080',
        ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(request.headers ?? {}),
      },
    });
    await api.handler(req, res);
    let json;
    if (res.body.length > 0) {
      try {
        json = JSON.parse(res.body);
      } catch {
        json = undefined; // non-JSON routes (brand SVGs) keep only `raw`
      }
    }
    return { status: res.status, json, raw: res.body };
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'better-search-test-'));
    store = createStore({ dir, descriptorOf: providerOf });
    await store.load();
    harness = fakeHarness();
    registry = createRegistry({
      ctx: harness.ctx,
      store,
      adapters,
      fetchAdapters,
      usageAdapters,
    });
    registry.sync();
    api = createApi({ store, registry, ctx: harness.ctx });
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves the catalog', async () => {
    const { status, json } = await call({ path: '/catalog' });
    assert.equal(status, 200);
    assert.equal(json.providers.length, PROVIDERS.length);
    assert.deepEqual(json.supportedTypes.sort(), ['brave', 'tavily']);
  });

  it('reports the shipped provider as the initial selection', async () => {
    const { json } = await call({ path: '/state' });
    assert.deepEqual(json.services, []);
    assert.equal(json.builtins.length, 2);
    assert.equal(json.selectedId, 'builtin:deepseek-search-api');
    assert.equal(json.common.maxResults, DEFAULT_COMMON.maxResults);
    assert.deepEqual(json.fetch, { mode: 'official', serviceId: '', providerId: '', pin: { ok: true, error: null } });
  });

  it('creates a service with a key pool, registering search and fetch', async () => {
    const created = await call({
      method: 'POST',
      path: '/services',
      body: { type: 'tavily', keys: ['tvly-1', 'tvly-2', 'tvly-1'] },
    });
    assert.equal(created.status, 200);
    const service = created.json.services[0];
    assert.equal(service.type, 'tavily');
    assert.equal(service.keySet, true);
    assert.equal(service.keyCount, 2);
    assert.equal(service.fetchCapable, true);
    assert.equal(service.usageSupported, true);
    assert.equal(harness.search.has(`better-search/${service.id}`), true);
    assert.equal(harness.fetch.has(`better-search/${service.id}`), true);
    assert.equal(created.json.selectedId, service.id);
    assert.equal(harness.settingsState.value.searchProvider, `better-search/${service.id}`);
  });

  it('runs a pinned search provider through ctx.web', async () => {
    const created = await call({ method: 'POST', path: '/services', body: { type: 'tavily', keys: ['tvly-1'] } });
    const provider = harness.search.get(`better-search/${created.json.services[0].id}`);
    const result = await provider.search({ query: 'hello', maxResults: 3 });
    assert.equal(result.content, 'answer text');
    assert.equal(result.sources.length, 1);
    assert.equal(provider.available(), true);
  });

  it('runs a pinned fetch provider through ctx.web', async () => {
    const created = await call({ method: 'POST', path: '/services', body: { type: 'tavily', keys: ['tvly-1'] } });
    const provider = harness.fetch.get(`better-search/${created.json.services[0].id}`);
    const result = await provider.fetch({ url: 'https://example.com/a' });
    assert.equal(result.url, 'https://example.com/a');
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body, { kind: 'text', content: '# Fetched\n\nhttps://example.com/a' });
    assert.equal(result.truncated, false);
  });

  it('lists masked keys and never returns values', async () => {
    const created = await call({ method: 'POST', path: '/services', body: { type: 'tavily', keys: ['tvly-test-key'] } });
    const id = created.json.services[0].id;
    const listed = await call({ path: `/services/${id}/keys` });
    assert.equal(listed.status, 200);
    assert.equal(listed.json.keys.length, 1);
    assert.equal(listed.json.keys[0].primary, true);
    assert.equal(listed.json.keys[0].masked, 'tvly••••-key');
    assert.equal(listed.raw.includes('tvly-test-key'), false);
  });

  it('appends keys without duplicates and reveals on demand', async () => {
    const created = await call({ method: 'POST', path: '/services', body: { type: 'tavily', keys: ['tvly-1'] } });
    const id = created.json.services[0].id;
    const added = await call({ method: 'POST', path: `/services/${id}/keys`, body: { values: ['tvly-2', 'tvly-1'] } });
    assert.equal(added.json.added, 1);
    assert.equal(added.json.skipped, 1);
    assert.equal(added.json.state.services[0].keyCount, 2);
    const keyId = added.json.state.services[0].id;
    assert.ok(keyId.length > 0);
    const listed = await call({ path: `/services/${id}/keys` });
    const second = listed.json.keys[1].id;
    const revealed = await call({ method: 'POST', path: `/services/${id}/keys/${second}/reveal` });
    assert.equal(revealed.json.value, 'tvly-2');
  });

  it('deletes a key and promotes the next primary', async () => {
    const created = await call({ method: 'POST', path: '/services', body: { type: 'tavily', keys: ['tvly-1', 'tvly-2'] } });
    const id = created.json.services[0].id;
    const listed = await call({ path: `/services/${id}/keys` });
    const primaryId = listed.json.keys[0].id;
    const removed = await call({ method: 'DELETE', path: `/services/${id}/keys/${primaryId}` });
    assert.equal(removed.status, 200);
    assert.equal(removed.json.services[0].keyCount, 1);
    const after = await call({ path: `/services/${id}/keys` });
    assert.equal(after.json.keys[0].primary, true);
    assert.equal(after.json.keys[0].masked, maskKey('tvly-2'));
  });

  it('keeps the stored pool when an update omits keys, and clears it on []', async () => {
    const created = await call({ method: 'POST', path: '/services', body: { type: 'tavily', keys: ['tvly-1'] } });
    const id = created.json.services[0].id;
    const renamed = await call({ method: 'PUT', path: `/services/${id}`, body: { name: '我的 Tavily' } });
    assert.equal(renamed.json.services[0].name, '我的 Tavily');
    assert.equal(renamed.json.services[0].keyCount, 1);
    const cleared = await call({ method: 'PUT', path: `/services/${id}`, body: { keys: [] } });
    assert.equal(cleared.json.services[0].keySet, false);
  });

  it('rejects an unknown provider type', async () => {
    const { status, json } = await call({ method: 'POST', path: '/services', body: { type: 'nope' } });
    assert.equal(status, 400);
    assert.equal(json.code, 'unknown-type');
  });

  it('selects a built-in and repins it', async () => {
    await call({ method: 'POST', path: '/services', body: { type: 'tavily', keys: ['tvly-1'] } });
    const selected = await call({ method: 'POST', path: '/select', body: { id: 'builtin:deepseek-official' } });
    assert.equal(selected.json.selectedId, 'builtin:deepseek-official');
    assert.equal(harness.settingsState.value.searchProvider, 'deepseek-official');
  });

  it('deletes a service and falls back to a shipped provider', async () => {
    const created = await call({ method: 'POST', path: '/services', body: { type: 'tavily', keys: ['tvly-1'] } });
    const id = created.json.services[0].id;
    await call({ method: 'PUT', path: '/fetch', body: { mode: 'service', serviceId: id } });
    assert.equal(harness.settingsState.value.fetchProvider, `better-search/${id}`);
    const deleted = await call({ method: 'DELETE', path: `/services/${id}` });
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.json.services, []);
    assert.equal(deleted.json.selectedId, 'builtin:deepseek-search-api');
    assert.equal(deleted.json.fetch.mode, 'official');
    assert.equal(harness.search.size, 0);
    assert.equal(harness.fetch.size, 0);
    assert.equal(harness.settingsState.value.searchProvider, 'deepseek-search-api');
    assert.equal(harness.settingsState.value.fetchProvider, 'deepseek-fetch-api');
  });

  it('pins fetch in follow mode and restores the original provider', async () => {
    const created = await call({ method: 'POST', path: '/services', body: { type: 'tavily', keys: ['tvly-1'] } });
    const id = created.json.services[0].id;
    const followed = await call({ method: 'PUT', path: '/fetch', body: { mode: 'follow' } });
    assert.equal(followed.json.fetch.mode, 'follow');
    assert.equal(followed.json.fetch.providerId, `better-search/${id}`);
    assert.equal(harness.settingsState.value.fetchProvider, `better-search/${id}`);
    const official = await call({ method: 'PUT', path: '/fetch', body: { mode: 'official' } });
    assert.equal(harness.settingsState.value.fetchProvider, 'deepseek-fetch-api');
    assert.equal(official.json.fetch.providerId, '');
  });

  it('rejects a fetch selection for a non-fetch provider', async () => {
    const created = await call({ method: 'POST', path: '/services', body: { type: 'brave', keys: ['b-1'] } });
    const id = created.json.services[0].id;
    const { status, json } = await call({ method: 'PUT', path: '/fetch', body: { mode: 'service', serviceId: id } });
    assert.equal(status, 500);
    assert.match(json.error, /不支持网页抓取/u);
  });

  it('queries usage through the usage adapter', async () => {
    const created = await call({ method: 'POST', path: '/services', body: { type: 'tavily', keys: ['tvly-1'] } });
    const id = created.json.services[0].id;
    const usage = await call({ method: 'POST', path: `/services/${id}/usage` });
    assert.equal(usage.status, 200);
    assert.equal(usage.json.ok, true);
    assert.deepEqual(usage.json.usage, { remaining: 900, used: 100, limit: 1000 });
  });

  it('reports usage as unsupported for providers without a usage endpoint', async () => {
    const created = await call({ method: 'POST', path: '/services', body: { type: 'brave', keys: ['b-1'] } });
    const id = created.json.services[0].id;
    const usage = await call({ method: 'POST', path: `/services/${id}/usage` });
    assert.equal(usage.json.ok, false);
    assert.match(usage.json.error, /不提供用量查询/u);
  });

  it('clamps general options', async () => {
    const { json } = await call({
      method: 'PUT',
      path: '/common',
      body: { maxResults: 999, timeoutMs: 1, autoTestOnLaunch: false },
    });
    assert.equal(json.common.maxResults, 50);
    assert.equal(json.common.timeoutMs, 1000);
    assert.equal(json.common.autoTestOnLaunch, false);
  });

  it('reorders services', async () => {
    const first = await call({ method: 'POST', path: '/services', body: { type: 'tavily', keys: ['a'] } });
    const a = first.json.services[0].id;
    const second = await call({ method: 'POST', path: '/services', body: { type: 'brave', keys: ['b'] } });
    const b = second.json.services[1].id;
    const reordered = await call({ method: 'POST', path: '/reorder', body: { ids: [b, a] } });
    assert.deepEqual(reordered.json.services.map((entry) => entry.id), [b, a]);
  });

  it('tests a service through its adapter', async () => {
    const created = await call({ method: 'POST', path: '/services', body: { type: 'tavily', keys: ['tvly-1'] } });
    const id = created.json.services[0].id;
    const tested = await call({ method: 'POST', path: `/services/${id}/test` });
    assert.equal(tested.json.result.ok, true);
    assert.equal(tested.json.state.services[0].connected, true);
  });

  it('rejects cross-origin mutations', async () => {
    const { status, json } = await call({
      method: 'POST',
      path: '/services',
      body: { type: 'tavily', keys: ['x'] },
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(status, 403);
    assert.equal(json.code, 'cross-origin');
  });

  it('serves brand icons and hides unknown files', async () => {
    const brand = await call({ path: '/brand/tavily-color.svg' });
    assert.equal(brand.status, 200);
    assert.match(Buffer.isBuffer(brand.raw) ? brand.raw.toString('utf8') : brand.raw, /<svg/u);
    const missing = await call({ path: '/brand/nope.svg' });
    assert.equal(missing.status, 404);
  });

  it('restores both shipped providers on unload', async () => {
    await call({ method: 'POST', path: '/services', body: { type: 'tavily', keys: ['tvly-1'] } });
    await call({ method: 'PUT', path: '/fetch', body: { mode: 'follow' } });
    assert.ok(harness.settingsState.value.searchProvider.startsWith('better-search/'));
    assert.ok(harness.settingsState.value.fetchProvider.startsWith('better-search/'));
    await registry.restore();
    assert.equal(harness.settingsState.value.searchProvider, 'deepseek-search-api');
    assert.equal(harness.settingsState.value.fetchProvider, 'deepseek-fetch-api');
  });

  it('rebuilds registrations from disk', async () => {
    const created = await call({ method: 'POST', path: '/services', body: { type: 'tavily', keys: ['tvly-1'] } });
    const reloaded = createStore({ dir, descriptorOf: providerOf });
    await reloaded.load();
    assert.equal(reloaded.snapshot().services[0].id, created.json.services[0].id);
    assert.equal(reloaded.snapshot().services[0].keys.length, 1);
    const secondHarness = fakeHarness();
    const secondRegistry = createRegistry({
      ctx: secondHarness.ctx,
      store: reloaded,
      adapters,
      fetchAdapters,
      usageAdapters,
    });
    secondRegistry.sync();
    assert.equal(secondHarness.search.size, 1);
    assert.equal(secondHarness.fetch.size, 1);
    secondRegistry.dispose();
  });

  it('detects an external switch and adopts it without writing', async () => {
    await call({ method: 'POST', path: '/services', body: { type: 'tavily', keys: ['tvly-1'] } });
    assert.ok(harness.settingsState.value.searchProvider.startsWith('better-search/'));
    // DSH's own web-search settings page writes the same fields.
    harness.settingsState.value.searchProvider = 'deepseek-search-api';
    harness.settingsState.value.fetchProvider = 'deepseek-fetch-api';
    const drifted = await call({ path: '/state' });
    assert.equal(drifted.json.drift.search.kind, 'builtin');
    assert.equal(drifted.json.drift.search.actual, 'deepseek-search-api');
    const reconciled = await call({ method: 'POST', path: '/reconcile' });
    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.json.selectedId, 'builtin:deepseek-search-api');
    assert.equal(reconciled.json.notice.code, 'search-external');
    assert.equal(reconciled.json.drift.search, null);
    assert.equal(harness.settingsState.value.searchProvider, 'deepseek-search-api');
  });

  it('heals a pin that points at a service this install no longer has', async () => {
    harness.settingsState.value.searchProvider = 'better-search/svc_missing';
    const drifted = await call({ path: '/state' });
    assert.equal(drifted.json.drift.search.kind, 'stale-ours');
    const reconciled = await call({ method: 'POST', path: '/reconcile' });
    assert.equal(reconciled.json.notice.code, 'search-healed');
    assert.equal(reconciled.json.selectedId, 'builtin:deepseek-search-api');
    assert.equal(harness.settingsState.value.searchProvider, 'deepseek-search-api');
    assert.equal(reconciled.json.pin.ok, true);
  });

  it('heals a stale pin at boot through applyPin', async () => {
    harness.settingsState.value.searchProvider = 'better-search/svc_missing';
    const emptyStore = createStore({ dir: mkdtempSync(join(tmpdir(), 'better-search-boot-')), descriptorOf: providerOf });
    await emptyStore.load();
    const bootHarness = fakeHarness();
    bootHarness.settingsState.value.searchProvider = 'better-search/svc_missing';
    const bootRegistry = createRegistry({ ctx: bootHarness.ctx, store: emptyStore, adapters, fetchAdapters, usageAdapters });
    bootRegistry.sync();
    await bootRegistry.reconcile();
    await bootRegistry.applyPin();
    assert.equal(bootHarness.settingsState.value.searchProvider, 'deepseek-search-api');
    assert.equal(bootRegistry.state().selectedId, 'builtin:deepseek-search-api');
    bootRegistry.dispose();
  });

  it('adopts an external fetch provider change', async () => {
    await call({ method: 'POST', path: '/services', body: { type: 'tavily', keys: ['tvly-1'] } });
    await call({ method: 'PUT', path: '/fetch', body: { mode: 'follow' } });
    assert.ok(harness.settingsState.value.fetchProvider.startsWith('better-search/'));
    harness.settingsState.value.fetchProvider = 'deepseek-fetch-api';
    const drifted = await call({ path: '/state' });
    assert.ok(drifted.json.drift.fetch !== null);
    const reconciled = await call({ method: 'POST', path: '/reconcile' });
    assert.equal(reconciled.json.fetch.mode, 'official');
    assert.equal(reconciled.json.notice.code, 'fetch-external');
    assert.equal(harness.settingsState.value.fetchProvider, 'deepseek-fetch-api');
  });

  it('reports a provider owned by another plugin without adopting it', async () => {
    harness.settingsState.value.searchProvider = 'other-plugin/provider';
    const drifted = await call({ path: '/state' });
    assert.equal(drifted.json.drift.search.kind, 'foreign');
    const reconciled = await call({ method: 'POST', path: '/reconcile' });
    assert.equal(reconciled.json.notice.code, 'search-foreign');
    assert.equal(reconciled.json.notice.providerId, 'other-plugin/provider');
    assert.equal(harness.settingsState.value.searchProvider, 'other-plugin/provider');
    assert.equal(reconciled.json.selectedId, '');
  });

  it('migrates a v1 store to the key pool', async () => {
    writeFileSync(
      join(dir, 'store.json'),
      JSON.stringify({
        version: 1,
        services: [{ id: 'svc_legacy01', type: 'tavily', name: 'Tavily', apiKey: 'tvly-old', apiKeys: ['tvly-extra'] }],
        selectedId: 'svc_legacy01',
        common: { maxResults: 5 },
      }),
    );
    const migrated = createStore({ dir, descriptorOf: providerOf });
    await migrated.load();
    const snapshot = migrated.snapshot();
    assert.equal(snapshot.version, 2);
    assert.equal(snapshot.services.length, 1);
    assert.equal(snapshot.services[0].keys.length, 2);
    assert.equal(snapshot.services[0].keys[0].value, 'tvly-old');
    assert.equal(snapshot.services[0].apiKey, undefined);
    assert.equal(snapshot.common.maxResults, 5);
    assert.deepEqual(snapshot.fetch, { mode: 'official', serviceId: '' });
  });
});
