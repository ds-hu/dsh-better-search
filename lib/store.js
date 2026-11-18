/**
 * Durable service store for `@ds-hu/dsh-better-search`.
 *
 * Everything the panel owns lives in one file under `$DSH_HOME/better-search/`
 * so an uninstall leaves nothing behind. Reads are served from memory; every
 * mutation goes through one serialized queue and rewrites the file atomically
 * (temp file + rename), so a crash can never leave half a store on disk.
 *
 * v2 replaced the flat `apiKey`/`apiKeys` pair with an ordered `keys[]` pool
 * (stable ids, primary first) so the panel can list, reveal and delete single
 * keys, and added the `fetch` block that decides which provider serves
 * `web_fetch`. v1 files are migrated on read.
 *
 * v3 added the `ui` block: browser-surface preferences that are not provider
 * configuration. `ui.sidebarPanel` decides whether the optional sidebar module
 * (the panel row + main page) is mounted; the management UI itself always lives
 * in DSH's Settings panel. v2 files inherit the default.
 *
 * @module @ds-hu/dsh-better-search/lib/store
 */
import { mkdirSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Current on-disk schema version. */
export const STORE_VERSION = 3;

/** Defaults for the panel's general options. */
export const DEFAULT_COMMON = Object.freeze({ maxResults: 8, timeoutMs: 30000, autoTestOnLaunch: true });

/** Defaults for the fetch selection block. */
export const DEFAULT_FETCH = Object.freeze({ mode: 'official', serviceId: '' });

/**
 * Defaults for the browser-surface preferences block.
 *
 * The sidebar panel is an optional module: the management entry lives in DSH's
 * Settings panel, and the sidebar row + page stay on by default so existing
 * installs keep their one-click entry until the user turns it off.
 */
export const DEFAULT_UI = Object.freeze({ sidebarPanel: true });

/** Clamp bounds shared by the API and the panel. */
export const LIMITS = Object.freeze({
  maxResults: { min: 1, max: 50 },
  timeoutMs: { min: 1000, max: 300000 },
});

/** Allowed fetch modes. */
export const FETCH_MODES = Object.freeze(['official', 'follow', 'service']);

/**
 * Directory holding the store file.
 * @returns {string} absolute directory path.
 */
export function resolveDataDir() {
  const env = process.env.DSH_HOME;
  const home = typeof env === 'string' && env.length > 0 ? env : join(homedir(), '.dsh');
  return join(home, 'better-search');
}

/**
 * New opaque service id.
 * @returns {string} `svc_` plus 8 base-36 characters.
 */
function newServiceId() {
  return `svc_${Math.random().toString(36).slice(2, 6)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * New opaque key id.
 * @returns {string} `key_` plus 8 base-36 characters.
 */
export function newKeyId() {
  return `key_${Math.random().toString(36).slice(2, 6)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Clamp a number into a range, falling back when it is not finite.
 * @param {unknown} value - candidate.
 * @param {{min: number, max: number}} range - bounds.
 * @param {number} fallback - value used when `value` is not a finite number.
 * @returns {number} the clamped integer.
 */
export function clampInt(value, range, fallback) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(range.max, Math.max(range.min, Math.round(numeric)));
}

/**
 * Mask a credential for display: first 4 + `••••` + last 4, or eight dots when
 * the value is too short to reveal ends safely.
 * @param {string} value - credential.
 * @returns {string} masked form.
 */
export function maskKey(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length <= 8) return '••••••••';
  return `${text.slice(0, 4)}••••${text.slice(-4)}`;
}

/**
 * Normalize one key pool entry, legacy strings included.
 * @param {unknown} raw - entry.
 * @returns {{id: string, value: string}|undefined} normalized entry.
 */
function normalizeKey(raw) {
  const value = typeof raw === 'string'
    ? raw.trim()
    : typeof raw === 'object' && raw !== null && typeof (/** @type {any} */ (raw).value) === 'string'
      ? /** @type {any} */ (raw).value.trim()
      : '';
  if (value.length === 0) return undefined;
  const candidateId = typeof raw === 'object' && raw !== null ? /** @type {any} */ (raw).id : undefined;
  const id = typeof candidateId === 'string' && /^key_[A-Za-z0-9]{4,32}$/u.test(candidateId) ? candidateId : newKeyId();
  return { id, value };
}

/**
 * Coerce a stored/patched service into the canonical shape.
 * @param {Record<string, unknown>} raw - untrusted input.
 * @param {(type: string) => object|undefined} descriptorOf - catalog lookup.
 * @returns {Record<string, any>} normalized service.
 */
export function normalizeService(raw, descriptorOf) {
  const type = typeof raw.type === 'string' ? raw.type : '';
  const descriptor = descriptorOf(type);
  const options = {};
  if (descriptor !== undefined && typeof raw.options === 'object' && raw.options !== null) {
    for (const field of descriptor.extras ?? []) {
      const value = /** @type {Record<string, unknown>} */ (raw.options)[field.key];
      if (typeof value === 'string' && value.length > 0) options[field.key] = value;
    }
  }
  // v2 `keys[]` first; v1 `apiKey`/`apiKeys` are folded in for migration.
  const rawKeys = Array.isArray(raw.keys) ? raw.keys : [];
  const legacy = [
    typeof raw.apiKey === 'string' ? raw.apiKey : '',
    ...(Array.isArray(raw.apiKeys) ? raw.apiKeys : []),
  ].filter((value) => typeof value === 'string' && value.trim().length > 0);
  const seen = new Set();
  const keys = [];
  for (const entry of [...rawKeys, ...legacy]) {
    const key = normalizeKey(entry);
    if (key === undefined || seen.has(key.value)) continue;
    seen.add(key.value);
    keys.push(key);
  }
  const name = typeof raw.name === 'string' && raw.name.trim().length > 0
    ? raw.name.trim()
    : (descriptor?.zh ?? type);
  return {
    id: typeof raw.id === 'string' && /^[A-Za-z0-9_-]{4,64}$/u.test(raw.id) ? raw.id : newServiceId(),
    type,
    name: name.slice(0, 80),
    enabled: raw.enabled !== false,
    keys,
    baseURL: typeof raw.baseURL === 'string' ? raw.baseURL.trim() : '',
    options,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
  };
}

/**
 * Normalize the fetch selection block.
 * @param {unknown} raw - stored value.
 * @returns {{mode: string, serviceId: string}} normalized block.
 */
export function normalizeFetch(raw) {
  const source = typeof raw === 'object' && raw !== null ? /** @type {Record<string, unknown>} */ (raw) : {};
  const mode = typeof source.mode === 'string' && FETCH_MODES.includes(source.mode) ? source.mode : DEFAULT_FETCH.mode;
  const serviceId = typeof source.serviceId === 'string' ? source.serviceId : '';
  return { mode, serviceId: mode === 'service' ? serviceId : '' };
}

/**
 * Normalize the browser-surface preferences block.
 * @param {unknown} raw - stored value.
 * @returns {{sidebarPanel: boolean}} normalized block.
 */
export function normalizeUi(raw) {
  const source = typeof raw === 'object' && raw !== null ? /** @type {Record<string, unknown>} */ (raw) : {};
  return { sidebarPanel: source.sidebarPanel !== false };
}

/**
 * Create the store handle.
 * @param {object} options - store options.
 * @param {string} options.dir - data directory.
 * @param {(type: string) => object|undefined} options.descriptorOf - catalog lookup.
 * @param {(level: string, message: string) => void} [options.logger] - diagnostic sink.
 * @returns {object} the store handle.
 */
export function createStore({ dir, descriptorOf, logger = () => {} }) {
  /** @type {{version: number, services: any[], selectedId: string, common: object, fetch: object, ui: {sidebarPanel: boolean}}} */
  let state = {
    version: STORE_VERSION,
    services: [],
    selectedId: '',
    common: { ...DEFAULT_COMMON },
    fetch: { ...DEFAULT_FETCH },
    ui: { ...DEFAULT_UI },
  };
  const file = join(dir, 'store.json');
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();

  /**
   * Normalize a whole document, migrating v1.
   * @param {unknown} raw - parsed JSON.
   * @returns {void}
   */
  function adopt(raw) {
    const document = typeof raw === 'object' && raw !== null ? /** @type {Record<string, any>} */ (raw) : {};
    const services = Array.isArray(document.services)
      ? document.services.map((entry) => normalizeService(entry ?? {}, descriptorOf)).filter((entry) => entry.type.length > 0)
      : [];
    const seen = new Set();
    state.services = services.filter((service) => {
      if (seen.has(service.id)) return false;
      seen.add(service.id);
      return true;
    });
    const common = typeof document.common === 'object' && document.common !== null ? document.common : {};
    state.common = {
      maxResults: clampInt(common.maxResults, LIMITS.maxResults, DEFAULT_COMMON.maxResults),
      timeoutMs: clampInt(common.timeoutMs, LIMITS.timeoutMs, DEFAULT_COMMON.timeoutMs),
      autoTestOnLaunch: common.autoTestOnLaunch !== false,
    };
    state.selectedId = typeof document.selectedId === 'string' ? document.selectedId : '';
    state.fetch = normalizeFetch(document.fetch);
    state.ui = normalizeUi(document.ui);
    state.version = STORE_VERSION;
  }

  /**
   * Write the current state atomically.
   * @returns {Promise<void>} resolves when the rename completed.
   */
  async function flush() {
    mkdirSync(dir, { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temp, file);
  }

  /**
   * Load the store from disk, creating defaults when absent.
   * @returns {Promise<void>} resolves after the load.
   */
  async function load() {
    try {
      const text = await readFile(file, 'utf8');
      adopt(JSON.parse(text));
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== 'ENOENT') {
        logger('warn', `better-search:store: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
      adopt(undefined);
    }
  }

  return {
    /** Store file path, reported to the panel. */
    file,
    /** Data directory, reported to the panel. */
    dir,
    load,
    /**
     * Deep snapshot of the current state; callers may not mutate it in place.
     * @returns {{version: number, services: any[], selectedId: string, common: object, fetch: object, ui: {sidebarPanel: boolean}}} the state.
     */
    snapshot() {
      return JSON.parse(JSON.stringify(state));
    },
    /**
     * Run one read-modify-write under the queue.
     * @param {(current: {services: any[], selectedId: string, common: object, fetch: object, ui: {sidebarPanel: boolean}}) => any} change - mutator; return value is passed back.
     * @returns {Promise<any>} the mutator's return value.
     */
    mutate(change) {
      const run = queue.then(async () => {
        const result = change(state);
        await flush();
        return result;
      });
      queue = run.catch(() => {});
      return run;
    },
    /**
     * Resolve a service by id from the last snapshot.
     * @param {string} id - service id.
     * @returns {any|undefined} the service.
     */
    serviceOf(id) {
      return state.services.find((service) => service.id === id);
    },
    /** @returns {string} new service id. */
    nextId: newServiceId,
  };
}
