/**
 * The panel's HTTP surface.
 *
 * One prefix route on the Host web server serves every read and mutation the
 * page needs; the page polls `GET /state` and never opens a second channel.
 * Mutations are same-origin JSON and answer with the full state so the page needs
 * no follow-up round trip.
 *
 * Credentials never leave the Host except through `POST …/keys/:keyId/reveal`,
 * which the panel calls only when the user clicks the eye button.
 *
 * @module @ds-hu/dsh-better-search/lib/api
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS, providerOf } from './catalog.js';
import {
  asHttpError,
  assertSameOrigin,
  HttpError,
  readJson,
  sendError,
  sendJson,
} from './http.js';
import { clampInt, DEFAULT_COMMON, LIMITS, normalizeService } from './store.js';

/** Prefix every panel route lives under. */
export const API_PREFIX = '/better-search/api';

/** Package root, used to resolve `assets/brands`. */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Directory holding the brand SVGs. */
const BRAND_DIR = join(PACKAGE_ROOT, 'assets', 'brands');
/** Only files matching this may be served. */
const BRAND_ROUTE = /^\/brand\/([a-z0-9][a-z0-9-]*\.svg)$/u;
/** One stored service. */
const SERVICE_ROUTE = /^\/services\/([A-Za-z0-9_-]{4,64})$/u;
/** One stored service action. */
const SERVICE_ACTION_ROUTE = /^\/services\/([A-Za-z0-9_-]{4,64})\/(test|usage|keys)$/u;
/** One key of a stored service. */
const SERVICE_KEY_ROUTE = /^\/services\/([A-Za-z0-9_-]{4,64})\/keys\/(key_[A-Za-z0-9]{4,32})$/u;
/** Reveal action for one key. */
const SERVICE_KEY_REVEAL_ROUTE = /^\/services\/([A-Za-z0-9_-]{4,64})\/keys\/(key_[A-Za-z0-9]{4,32})\/reveal$/u;

/**
 * Coerce a string field, rejecting non-strings.
 * @param {unknown} value - candidate.
 * @param {string} field - field name for the error message.
 * @returns {string|undefined} the string, or undefined when absent.
 */
function optionalString(value, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, 'invalid-field', `${field} 必须是字符串`);
  return value;
}

/**
 * Read a list of credentials from a request body.
 * @param {unknown} value - candidate array.
 * @param {string} field - field name for the error message.
 * @returns {string[]|undefined} the values, or undefined when absent.
 */
function optionalKeyList(value, field) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new HttpError(400, 'invalid-field', `${field} 必须是字符串数组`);
  return value.map((entry) => {
    if (typeof entry !== 'string') throw new HttpError(400, 'invalid-field', `${field} 必须是字符串数组`);
    return entry;
  });
}

/**
 * Build the HTTP router.
 * @param {object} options - router options.
 * @param {any} options.store - store handle.
 * @param {any} options.registry - registry handle.
 * @param {any} options.ctx - Host plugin context.
 * @param {(level: string, message: string) => void} [options.logger] - diagnostic sink.
 * @returns {{handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}} router.
 */
export function createApi({ store, registry, ctx, logger = () => {} }) {
  /** @returns {object} the full panel state. */
  const state = () => ({ ok: true, ...registry.state() });

  /**
   * Validate and normalize a create/patch body.
   * @param {Record<string, unknown>} body - request body.
   * @param {any} [existing] - stored service for updates.
   * @returns {Record<string, any>} normalized service.
   */
  function readService(body, existing) {
    const type = optionalString(body.type, 'type') ?? existing?.type;
    const descriptor = providerOf(type);
    if (type === undefined || descriptor === undefined) {
      throw new HttpError(400, 'unknown-type', `未知的搜索服务类型：${String(body.type)}`);
    }
    const base = existing ?? {
      id: store.nextId(),
      type,
      name: descriptor.zh,
      enabled: true,
      keys: [],
      baseURL: '',
      options: {},
      createdAt: new Date().toISOString(),
    };
    const baseURL = optionalString(body.baseURL, 'baseURL');
    // `keys` replaces the pool; `appendKeys` merges into it without ever dropping a
    // key the panel cannot read back (the API never reveals values unprompted).
    const replaceKeys = optionalKeyList(body.keys, 'keys');
    const appendKeys = optionalKeyList(body.appendKeys, 'appendKeys');
    const legacyKey = optionalString(body.apiKey, 'apiKey');
    let keys = replaceKeys ?? base.keys ?? [];
    if (replaceKeys === undefined) {
      const extra = appendKeys ?? (legacyKey !== undefined && legacyKey.length > 0 ? [legacyKey] : []);
      if (legacyKey === '' && appendKeys === undefined) {
        keys = [];
      } else if (extra.length > 0) {
        keys = [...keys, ...extra];
      }
    }
    return normalizeService(
      {
        ...base,
        type,
        name: optionalString(body.name, 'name') ?? base.name,
        enabled: body.enabled === undefined ? base.enabled : body.enabled !== false,
        keys,
        baseURL: baseURL ?? base.baseURL,
        options: typeof body.options === 'object' && body.options !== null ? body.options : base.options,
      },
      providerOf,
    );
  }

  /**
   * Answer one request.
   * @param {import('node:http').IncomingMessage} req - request.
   * @param {import('node:http').ServerResponse} res - response.
   * @returns {Promise<void>} resolves when answered.
   */
  async function route(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) || '/' : url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();

    if (method === 'GET' && path === '/catalog') {
      sendJson(res, 200, {
        ok: true,
        providers: PROVIDERS,
        supportedTypes: registry.supportedTypes(),
        common: { ...DEFAULT_COMMON, limits: LIMITS },
      });
      return;
    }

    if (method === 'GET' && path === '/state') {
      sendJson(res, 200, state());
      return;
    }

    const brand = BRAND_ROUTE.exec(path);
    if (method === 'GET' && brand !== null) {
      try {
        const svg = await readFile(join(BRAND_DIR, brand[1]));
        res.writeHead(200, {
          'content-type': 'image/svg+xml; charset=utf-8',
          'content-length': svg.length,
          'cache-control': 'public, max-age=86400',
          'x-content-type-options': 'nosniff',
        });
        res.end(svg);
      } catch {
        throw new HttpError(404, 'no-brand', `没有该品牌图标：${brand[1]}`);
      }
      return;
    }

    if (method !== 'GET') assertSameOrigin(req);

    if (method === 'POST' && path === '/services') {
      const body = await readJson(req);
      const service = readService(body, undefined);
      if (service.type === undefined) throw new HttpError(400, 'unknown-type', '缺少 type');
      if (store.snapshot().services.some((entry) => entry.id === service.id)) {
        throw new HttpError(409, 'duplicate-id', '服务 id 冲突，请重试');
      }
      await store.mutate((current) => {
        current.services.push(service);
        if (current.selectedId === '') current.selectedId = service.id;
      });
      registry.sync();
      await registry.applyPin();
      if (store.snapshot().fetch.mode === 'follow') await registry.applyFetchPin();
      sendJson(res, 200, state());
      return;
    }

    if (method === 'PUT' && path === '/fetch') {
      const body = await readJson(req);
      const outcome = await registry.selectFetch({
        mode: optionalString(body.mode, 'mode') ?? '',
        serviceId: optionalString(body.serviceId, 'serviceId') ?? '',
      });
      sendJson(res, 200, { ...state(), fetch: { ...state().fetch, pin: outcome } });
      return;
    }

    if (method === 'POST' && path === '/reconcile') {
      await registry.reconcile();
      sendJson(res, 200, state());
      return;
    }

    const serviceMatch = SERVICE_ROUTE.exec(path);
    if (serviceMatch !== null) {
      const id = serviceMatch[1];
      const existing = store.serviceOf(id);
      if (existing === undefined) throw new HttpError(404, 'not-found', `没有该搜索服务：${id}`);

      if (method === 'PUT') {
        const body = await readJson(req);
        const next = readService(body, existing);
        await store.mutate((current) => {
          const index = current.services.findIndex((entry) => entry.id === id);
          if (index >= 0) current.services[index] = next;
        });
        registry.sync();
        await registry.applyPin();
        if (store.snapshot().fetch.mode === 'follow' || store.snapshot().fetch.serviceId === id) {
          await registry.applyFetchPin();
        }
        sendJson(res, 200, state());
        return;
      }

      if (method === 'DELETE') {
        const snapshot = store.snapshot();
        const isSelected = snapshot.selectedId === id;
        await store.mutate((current) => {
          current.services = current.services.filter((entry) => entry.id !== id);
          if (current.selectedId === id) {
            current.selectedId =
              current.services.length > 0 ? current.services[0].id : 'builtin:deepseek-search-api';
          }
          if (current.fetch.serviceId === id) current.fetch = { mode: 'official', serviceId: '' };
        });
        registry.sync();
        if (isSelected) await registry.applyPin();
        await registry.applyFetchPin();
        sendJson(res, 200, state());
        return;
      }
    }

    const actionMatch = SERVICE_ACTION_ROUTE.exec(path);
    if (actionMatch !== null) {
      const id = actionMatch[1];
      const action = actionMatch[2];
      if (!registry.has(id)) throw new HttpError(404, 'not-found', `没有该搜索服务：${id}`);

      if (action === 'test' && method === 'POST') {
        const result = await registry.test(id);
        sendJson(res, 200, { ok: true, result, state: state() });
        return;
      }

      if (action === 'usage' && method === 'POST') {
        if (id.startsWith('builtin:')) throw new HttpError(400, 'builtin-unsupported', '内置服务不提供用量查询');
        const result = await registry.usage(id);
        sendJson(res, 200, { ...result, state: state() });
        return;
      }

      if (action === 'keys' && method === 'GET') {
        if (id.startsWith('builtin:')) throw new HttpError(400, 'builtin-unsupported', '内置服务的 Key 由官方插件管理');
        sendJson(res, 200, { ok: true, ...registry.keysView(id), state: state() });
        return;
      }

      if (action === 'keys' && method === 'POST') {
        if (id.startsWith('builtin:')) throw new HttpError(400, 'builtin-unsupported', '内置服务的 Key 由官方插件管理');
        const body = await readJson(req);
        const values = optionalKeyList(body.values, 'values') ?? [];
        const result = await registry.addKeys(id, values);
        sendJson(res, 200, { ok: true, ...result, state: state() });
        return;
      }
    }

    const revealMatch = SERVICE_KEY_REVEAL_ROUTE.exec(path);
    if (method === 'POST' && revealMatch !== null) {
      const value = registry.revealKey(revealMatch[1], revealMatch[2]);
      sendJson(res, 200, { ok: true, value });
      return;
    }

    const keyMatch = SERVICE_KEY_ROUTE.exec(path);
    if (method === 'DELETE' && keyMatch !== null) {
      await registry.removeKey(keyMatch[1], keyMatch[2]);
      sendJson(res, 200, state());
      return;
    }

    if (method === 'POST' && path === '/select') {
      const body = await readJson(req);
      const id = optionalString(body.id, 'id');
      if (id === undefined || !registry.has(id)) throw new HttpError(400, 'unknown-selection', '选择的服务不存在');
      const outcome = await registry.select(id);
      sendJson(res, 200, { ...state(), pin: outcome });
      return;
    }

    if (method === 'POST' && path === '/reorder') {
      const body = await readJson(req);
      if (!Array.isArray(body.ids)) throw new HttpError(400, 'invalid-field', 'ids 必须是数组');
      const order = new Map(body.ids.map((id, index) => [String(id), index]));
      await store.mutate((current) => {
        current.services.sort(
          (a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER),
        );
      });
      sendJson(res, 200, state());
      return;
    }

    if (method === 'PUT' && path === '/common') {
      const body = await readJson(req);
      await store.mutate((current) => {
        current.common = {
          maxResults: clampInt(body.maxResults ?? current.common.maxResults, LIMITS.maxResults, DEFAULT_COMMON.maxResults),
          timeoutMs: clampInt(body.timeoutMs ?? current.common.timeoutMs, LIMITS.timeoutMs, DEFAULT_COMMON.timeoutMs),
          autoTestOnLaunch:
            body.autoTestOnLaunch === undefined ? current.common.autoTestOnLaunch : body.autoTestOnLaunch !== false,
        };
      });
      registry.sync();
      sendJson(res, 200, state());
      return;
    }

    throw new HttpError(404, 'no-route', `未知接口：${method} ${path}`);
  }

  return {
    /**
     * Route handler passed to `ctx.webServer.register`.
     * @param {import('node:http').IncomingMessage} req - request.
     * @param {import('node:http').ServerResponse} res - response.
     * @returns {Promise<void>} resolves when answered.
     */
    async handler(req, res) {
      try {
        await route(req, res);
      } catch (error) {
        const failure = asHttpError(error);
        if (failure.status >= 500) {
          logger('error', `better-search:api ${req.method} ${req.url}: ${failure.message}`);
        }
        if (!res.headersSent) sendError(res, failure);
        else res.end();
      }
    },
  };
}
