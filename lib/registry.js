/**
 * Registrations and selection for `@ds-hu/dsh-better-search`.
 *
 * Three jobs:
 * 1. Keep `ctx.web` in sync with the store — every stored service becomes a
 *    dynamically registered **search** provider and, when it has a fetch
 *    adapter, a **fetch** provider too. The built-in `web_search` / `web_fetch`
 *    tools then run through whichever service the panel selected.
 * 2. Pin both selections into DSH's own `web` row through `ctx.settings`, because
 *    `ctx.web` chooses providers by configured id and offers no setter.
 * 3. Answer the panel's per-service questions: key pool management, a live
 *    connection test, and the provider-specific usage/quota query.
 *
 * A third-party provider is registered exactly like a shipped one; this module
 * adds no model-facing tool and touches no Loader row.
 *
 * @module @ds-hu/dsh-better-search/lib/registry
 */
import { providerOf } from './catalog.js';
import * as searchIndex from './search/index.js';
import { clampInt, LIMITS, maskKey, newKeyId } from './store.js';

// Adapter modules are optional at load time: a profile can run a build that ships
// only the Host half, and a missing registry must not stop the plugin from loading.
const FETCH_ADAPTERS = searchIndex.FETCH_ADAPTERS ?? {};
const USAGE_ADAPTERS = searchIndex.USAGE_ADAPTERS ?? {};

/** Provider ids of the shipped DeepSeek rows that always appear as built-ins. */
export const BUILTIN_PROVIDERS = Object.freeze([
  {
    id: 'builtin:deepseek-official',
    providerId: 'deepseek-official',
    type: 'deepseek',
    name: 'DeepSeek 官方',
    nameEn: 'DeepSeek (official)',
    brand: 'deepseek-color.svg',
  },
  {
    id: 'builtin:deepseek-search-api',
    providerId: 'deepseek-search-api',
    type: 'deepseek',
    name: 'DeepSeek Search API',
    nameEn: 'DeepSeek Search API',
    brand: 'deepseek-color.svg',
  },
]);

/**
 * Error carrying a stable code, shaped like the seam's own `WebError`.
 *
 * Kept local on purpose: a profile-installed bundle cannot rely on resolving
 * Harness internals from its own directory, and the seam only needs an `Error`
 * whose message reaches the tool result.
 */
class WebError extends Error {
  /**
   * @param {string} message - user-facing text.
   * @param {string} code - stable machine code.
   */
  constructor(message, code) {
    super(message);
    this.name = 'WebError';
    this.code = code;
  }
}

/**
 * The ordered credential pool of a service.
 * @param {any} service - stored service.
 * @returns {string[]} usable key values, primary first.
 */
function keyPool(service) {
  return (service.keys ?? [])
    .map((entry) => (typeof entry?.value === 'string' ? entry.value.trim() : ''))
    .filter((value) => value.length > 0);
}

/**
 * Whether a service has everything its descriptor requires to run.
 * Must stay cheap and network-free: `available()` is consulted on every call.
 * @param {any} service - stored service.
 * @param {any} descriptor - catalog entry.
 * @returns {boolean} usable now.
 */
function serviceReady(service, descriptor) {
  if (!service.enabled) return false;
  if (descriptor.key === 'required' && keyPool(service).length === 0) return false;
  if (descriptor.urlRequired === true && service.baseURL.length === 0) return false;
  return true;
}

/**
 * Whether a service type has a fetch adapter.
 * @param {string} type - catalog type id.
 * @returns {boolean} fetch capable.
 */
function fetchCapableType(fetchAdapters, type) {
  return typeof fetchAdapters[type] === 'function';
}

/**
 * Build the registry handle.
 * @param {object} options - registry options.
 * @param {any} options.ctx - Host plugin context.
 * @param {any} options.store - store handle.
 * @param {Record<string, Function>} options.adapters - catalog type → search adapter.
 * @param {(level: string, message: string) => void} [options.logger] - diagnostic sink.
 * @returns {object} registry API used by the HTTP layer.
 */
export function createRegistry({
  ctx,
  store,
  adapters,
  fetchAdapters = FETCH_ADAPTERS,
  usageAdapters = USAGE_ADAPTERS,
  logger = () => {},
}) {
  /** service id → { search?: disposer, fetch?: disposer }. */
  const disposers = new Map();
  /** entry id → last test result (`true` connected, `false` failed, absent untested). */
  const connections = new Map();
  /** service id → rotation cursor. */
  const cursors = new Map();
  /** Last search-pin outcome, surfaced to the panel. */
  let pin = { ok: true, providerId: '', error: null };
  /** Last fetch-pin outcome, surfaced to the panel. */
  let fetchPin = { ok: true, error: null };
  /** `web.fetchProvider` as it was before this plugin touched it. */
  let originalFetchProvider;
  /** Last external-change notice, surfaced once to the panel. */
  let lastNotice = null;
  let disposed = false;

  /** @returns {any} the web service when mounted. */
  const webOf = () => ctx.get('web');
  /** @returns {any} the settings service when mounted. */
  const settingsOf = () => ctx.get('settings');

  /**
   * Provider id the current search selection pins.
   * @param {string} selectedId - store selection.
   * @returns {string} provider id, or `''` when nothing maps.
   */
  function providerIdOf(selectedId) {
    if (selectedId.startsWith('builtin:')) {
      const entry = BUILTIN_PROVIDERS.find((candidate) => candidate.id === selectedId);
      return entry === undefined ? '' : entry.providerId;
    }
    return store.serviceOf(selectedId) === undefined ? '' : `better-search/${selectedId}`;
  }

  /**
   * Resolve the selection, defaulting to whatever DSH already has pinned.
   * @param {any} snapshot - store snapshot.
   * @returns {string} the effective selection id.
   */
  function effectiveSelection(snapshot) {
    if (snapshot.selectedId === 'builtin:' || providerIdOf(snapshot.selectedId) !== '') return snapshot.selectedId;
    const settings = settingsOf();
    if (settings === undefined || typeof settings.describe !== 'function') return '';
    try {
      const descriptor = settings.describe().find((row) => row.ns === 'web');
      const current = descriptor?.value?.searchProvider;
      const builtin = BUILTIN_PROVIDERS.find((entry) => entry.providerId === current);
      if (builtin !== undefined) return builtin.id;
      const match = typeof current === 'string' && current.startsWith('better-search/')
        ? current.slice('better-search/'.length)
        : '';
      return store.serviceOf(match) === undefined ? '' : match;
    } catch {
      return '';
    }
  }

  /**
   * Read `web.fetchProvider` once, replacing a stale `better-search/*` value
   * (left by an offline uninstall) with the shipped DeepSeek fetch provider so
   * `restore()` can never write a provider that no longer exists.
   * @returns {string} the baseline fetch provider id.
   */
  function ensureOriginalFetchProvider() {
    if (originalFetchProvider !== undefined) return originalFetchProvider;
    const captured = webField('fetchProvider') ?? '';
    originalFetchProvider = captured.startsWith('better-search/') ? 'deepseek-fetch-api' : captured;
    return originalFetchProvider;
  }

  /**
   * Provider id the current fetch selection should pin.
   * @param {any} snapshot - store snapshot.
   * @returns {string} `''` means "leave DSH's own fetch provider in charge".
   */
  function effectiveFetchProviderId(snapshot) {
    const selection = effectiveSelection(snapshot);
    if (snapshot.fetch.mode === 'service') {
      const service = store.serviceOf(snapshot.fetch.serviceId);
      return service !== undefined && fetchCapableType(fetchAdapters, service.type) ? `better-search/${service.id}` : '';
    }
    if (snapshot.fetch.mode === 'follow') {
      if (selection === '' || selection.startsWith('builtin:')) return '';
      const service = store.serviceOf(selection);
      return service !== undefined && fetchCapableType(fetchAdapters, service.type) ? `better-search/${service.id}` : '';
    }
    return '';
  }

  /**
   * Forget one provider registration of a service.
   * @param {string} serviceId - stored service id.
   * @returns {void}
   */
  function unregister(serviceId) {
    const entry = disposers.get(serviceId);
    if (entry === undefined) return;
    disposers.delete(serviceId);
    for (const dispose of [entry.search, entry.fetch]) {
      if (typeof dispose !== 'function') continue;
      try {
        dispose();
      } catch (error) {
        logger('warn', `better-search: unregister ${serviceId} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Register one stored service into `ctx.web` (search and/or fetch).
   * @param {any} service - stored service.
   * @returns {void}
   */
  function register(service) {
    const descriptor = providerOf(service.type);
    if (descriptor === undefined) {
      logger('warn', `better-search: unknown type "${service.type}" (service ${service.id})`);
      return;
    }
    const web = webOf();
    if (web === undefined) return;
    const providerId = `better-search/${service.id}`;
    const common = store.snapshot().common;
    const entry = {};

    /**
     * Next key in the rotation pool.
     * @returns {string} the key for this request.
     */
    const nextKey = () => {
      const pool = keyPool(service);
      if (pool.length === 0) return '';
      const cursor = cursors.get(service.id) ?? 0;
      cursors.set(service.id, (cursor + 1) % pool.length);
      return pool[cursor % pool.length];
    };

    const searchAdapter = adapters[service.type];
    if (typeof searchAdapter === 'function') {
      try {
        entry.search = web.registerSearchProvider({
          id: providerId,
          available: () => serviceReady(service, descriptor),
          ready: async () => serviceReady(service, descriptor),
          search: async (request, signal) => {
            if (!serviceReady(service, descriptor)) {
              throw new WebError(
                `${service.name} 尚未配置完整：请检查搜索服务面板中的 API Key 或实例地址`,
                'WEB_PROVIDER_CREDENTIAL_MISSING',
              );
            }
            const maxResults = clampInt(
              Math.min(request.maxResults ?? common.maxResults, common.maxResults),
              LIMITS.maxResults,
              common.maxResults,
            );
            const outcome = await searchAdapter({
              query: request.query,
              maxResults,
              service: { ...service, apiKey: nextKey() },
              descriptor,
              signal,
              timeoutMs: common.timeoutMs,
            });
            const sources = Array.isArray(outcome?.sources) ? outcome.sources.slice(0, maxResults) : [];
            return {
              ...(typeof outcome?.content === 'string' && outcome.content.length > 0 ? { content: outcome.content } : {}),
              sources,
              truncated: false,
            };
          },
        });
      } catch (error) {
        logger('error', `better-search: register search ${providerId} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const fetchAdapter = fetchAdapters[service.type];
    if (typeof fetchAdapter === 'function') {
      try {
        entry.fetch = web.registerFetchProvider({
          id: providerId,
          available: () => serviceReady(service, descriptor),
          ready: async () => serviceReady(service, descriptor),
          fetch: async (request, signal) => {
            if (!serviceReady(service, descriptor)) {
              throw new WebError(
                `${service.name} 尚未配置完整：请检查搜索服务面板中的 API Key 或实例地址`,
                'WEB_PROVIDER_CREDENTIAL_MISSING',
              );
            }
            const outcome = await fetchAdapter({
              url: request.url,
              service: { ...service, apiKey: nextKey() },
              descriptor,
              signal,
              timeoutMs: common.timeoutMs,
            });
            return {
              url: typeof outcome?.finalUrl === 'string' && outcome.finalUrl.length > 0 ? outcome.finalUrl : request.url,
              statusCode: Number.isInteger(outcome?.statusCode) ? outcome.statusCode : 200,
              body: { kind: 'text', content: typeof outcome?.content === 'string' ? outcome.content : '' },
              truncated: outcome?.truncated === true,
            };
          },
        });
      } catch (error) {
        logger('error', `better-search: register fetch ${providerId} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    disposers.set(service.id, entry);
  }

  /**
   * Reconcile registrations with the store: remove stale, add new, re-register changed.
   * @returns {void}
   */
  function sync() {
    if (disposed) return;
    const snapshot = store.snapshot();
    const wanted = new Map(snapshot.services.map((service) => [service.id, service]));
    for (const serviceId of [...disposers.keys()]) {
      if (!wanted.has(serviceId)) unregister(serviceId);
    }
    for (const service of wanted.values()) {
      // Re-registering is cheap and guarantees config fields are current; the old
      // providers are disposed first so duplicate ids never collide.
      unregister(service.id);
      register(service);
    }
    for (const builtin of BUILTIN_PROVIDERS) {
      if (!connections.has(builtin.id)) connections.set(builtin.id, null);
    }
  }

  /**
   * Read one string field of the `web` row.
   * @param {'searchProvider'|'fetchProvider'} field - field name.
   * @returns {string|undefined} the value.
   */
  function webField(field) {
    const settings = settingsOf();
    if (settings === undefined || typeof settings.describe !== 'function') return undefined;
    try {
      const descriptor = settings.describe().find((row) => row.ns === 'web');
      return typeof descriptor?.value?.[field] === 'string' ? descriptor.value[field] : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Write one string field of the `web` row, retrying once on a settings conflict.
   * @param {'searchProvider'|'fetchProvider'} field - field name.
   * @param {string} value - value to write.
   * @returns {Promise<{ok: boolean, error: string|null}>} outcome.
   */
  async function writeWebField(field, value) {
    const settings = settingsOf();
    if (settings === undefined || typeof settings.update !== 'function') {
      return { ok: false, error: '设置服务不可用，无法切换服务商' };
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const descriptor = settings.describe().find((row) => row.ns === 'web');
        if (descriptor === undefined) return { ok: false, error: '未能找到 web 行，无法切换服务商' };
        if (descriptor.value?.[field] === value) return { ok: true, error: null };
        await settings.update('web', { [field]: value }, descriptor.revision);
        return { ok: true, error: null };
      } catch (error) {
        const conflict = /** @type {any} */ (error)?.code === 'SETTINGS_CONFLICT';
        if (conflict && attempt === 0) continue;
        return { ok: false, error: `无法写入 web.${field}：${error instanceof Error ? error.message : String(error)}` };
      }
    }
    return { ok: false, error: `无法写入 web.${field}` };
  }

  /**
   * Classify a provider id read from the `web` row.
   * @param {string} providerId - pinned provider id.
   * @returns {object} classification used by drift/reconcile.
   */
  function classifyProvider(providerId) {
    if (providerId === '') return { kind: 'unset' };
    if (providerId.startsWith('better-search/')) {
      const id = providerId.slice('better-search/'.length);
      const service = store.serviceOf(id);
      return service === undefined
        ? { kind: 'stale-ours', serviceId: id }
        : { kind: 'service', serviceId: id, name: service.name, nameEn: service.name };
    }
    const builtin = BUILTIN_PROVIDERS.find((entry) => entry.providerId === providerId);
    return builtin === undefined
      ? { kind: 'foreign', providerId }
      : { kind: 'builtin', entryId: builtin.id, name: builtin.name, nameEn: builtin.nameEn };
  }

  /**
   * Compare the store's selection with what DSH actually has pinned, without
   * writing anything. The panel turns a non-null result into one reconcile call,
   * so an external change never silently fights the panel.
   *
   * `fetch` is only reported when the plugin owns the field (follow with a
   * fetch-capable selection, or an explicit service) and the value differs, or
   * when a `better-search/*` id is still pinned although the plugin does not own
   * the field. A shipped provider such as `http` or `deepseek-fetch-api` is a
   * valid value while the plugin owns nothing, not drift.
   *
   * @returns {{search: object|null, fetch: object|null}} drift description.
   */
  function drift() {
    const snapshot = store.snapshot();
    const expectedSearch = providerIdOf(effectiveSelection(snapshot));
    const actualSearch = webField('searchProvider') ?? '';
    // `''` means "this plugin does not own web.fetchProvider".
    const expectedFetch = effectiveFetchProviderId(snapshot);
    const actualFetch = webField('fetchProvider') ?? '';
    const fetchDrifted = expectedFetch === ''
      ? actualFetch.startsWith('better-search/')
      : actualFetch !== expectedFetch;
    return {
      search: actualSearch === expectedSearch
        ? null
        : { actual: actualSearch, expected: expectedSearch, ...classifyProvider(actualSearch) },
      fetch: fetchDrifted
        ? { actual: actualFetch, expected: expectedFetch, ...classifyProvider(actualFetch) }
        : null,
    };
  }

  /**
   * Adopt a change made through DSH's own web-search settings page, and heal pins
   * that point at services this install no longer has.
   *
   * Adopting writes the **store**; the external write already happened. The fetch
   * mode is a preference independent of the search selection, and DSH's switch
   * writes both fields in one settings revision, so a fetch change that arrives
   * together with a search change is not adopted as a fetch preference: the stored
   * mode is kept and `applyFetchPin()` re-asserts it when it still maps to a
   * provider.
   *
   * @returns {Promise<object|null>} the notice for the panel, if anything changed.
   */
  async function reconcile() {
    const before = store.snapshot();
    const actualSearch = webField('searchProvider') ?? '';
    const actualFetch = webField('fetchProvider') ?? '';
    const expectedSearch = providerIdOf(effectiveSelection(before));
    const searchChanged = actualSearch !== expectedSearch;
    const beforeFetchProvider = effectiveFetchProviderId(before);
    let selectedId = before.selectedId;
    let fetchChoice = { ...before.fetch };
    let changed = false;
    let notice = null;
    let fetchKept = null;

    if (searchChanged) {
      const info = classifyProvider(actualSearch);
      if (info.kind === 'service') {
        selectedId = info.serviceId;
        changed = selectedId !== before.selectedId;
        notice = { code: 'search-external', name: info.name, nameEn: info.nameEn };
      } else if (info.kind === 'builtin') {
        selectedId = info.entryId;
        changed = selectedId !== before.selectedId;
        notice = { code: 'search-external', name: info.name, nameEn: info.nameEn };
      } else if (info.kind === 'stale-ours') {
        await writeWebField('searchProvider', 'deepseek-search-api');
        selectedId = 'builtin:deepseek-search-api';
        changed = true;
        pin = { ok: true, providerId: 'deepseek-search-api', error: null };
        notice = { code: 'search-healed' };
      } else if (info.kind === 'unset') {
        // The field was cleared externally: treat the shipped API provider as the
        // effective default and make the store agree with it.
        await writeWebField('searchProvider', 'deepseek-search-api');
        selectedId = 'builtin:deepseek-search-api';
        changed = true;
        pin = { ok: true, providerId: 'deepseek-search-api', error: null };
        notice = { code: 'search-healed' };
      } else {
        // Another plugin owns the pin: report it, adopt nothing, never fight it.
        selectedId = '';
        changed = selectedId !== before.selectedId;
        notice = { code: 'search-foreign', providerId: info.providerId };
      }
    }

    // Evaluate fetch against the *adopted* selection: switching the search to a
    // shipped provider means "follow the official fetch", i.e. own nothing.
    const expectedFetch = effectiveFetchProviderId({ ...before, selectedId });
    const fetchDrifted = expectedFetch === ''
      ? actualFetch.startsWith('better-search/')
      : actualFetch !== expectedFetch;
    // A field that did not change is not an external fetch preference; it is a
    // leftover of our own pin whose expectation moved with the search selection.
    const fetchChanged = actualFetch !== beforeFetchProvider;

    if (fetchDrifted && fetchChanged) {
      const info = classifyProvider(actualFetch);
      const liveService = info.kind === 'service'
        && fetchCapableType(fetchAdapters, store.serviceOf(info.serviceId)?.type ?? '');
      if (liveService) {
        // An explicit pin of one of our fetch providers, either alone or together
        // with the search change: honour the choice.
        fetchChoice = { mode: 'service', serviceId: info.serviceId };
        changed = changed || before.fetch.mode !== 'service' || before.fetch.serviceId !== info.serviceId;
        notice = notice ?? { code: 'fetch-external' };
      } else if (!searchChanged && info.kind === 'stale-ours') {
        // Keep the stored mode; applyFetchPin() writes the shipped baseline.
        notice = notice ?? { code: 'fetch-healed' };
      } else if (!searchChanged) {
        fetchChoice = { mode: 'official', serviceId: '' };
        changed = changed || before.fetch.mode !== 'official';
        notice = notice ?? { code: 'fetch-external' };
      }
      // searchChanged and not ours: DSH's switch writes both fields together, so
      // keep the stored fetch mode and let applyFetchPin() re-assert it below.
    }

    if (changed) {
      await store.mutate((current) => {
        current.selectedId = selectedId;
        current.fetch = fetchChoice;
      });
    }
    // DSH's switch can overwrite a pin the plugin owned even when following the
    // *new* selection needs no pin at all (follow + a built-in search). Report
    // that the preference survived; the mode itself is already unchanged.
    if (searchChanged
      && before.fetch.mode !== 'official'
      && beforeFetchProvider !== ''
      && actualFetch !== beforeFetchProvider
      && fetchChoice.mode === before.fetch.mode
      && fetchChoice.serviceId === before.fetch.serviceId) {
      const keptService = before.fetch.mode === 'service' ? store.serviceOf(before.fetch.serviceId) : undefined;
      fetchKept = before.fetch.mode === 'service'
        ? { mode: 'service', name: keptService?.name ?? '', nameEn: keptService?.name ?? '' }
        : { mode: 'follow' };
    }

    // Re-assert a preserved follow/service mode, and heal a leftover
    // `better-search/*` value while nothing is owned. Unchanged and unowned
    // fields are left alone here.
    if (changed || fetchDrifted) await applyFetchPin();
    if (notice !== null && fetchKept !== null) notice = { ...notice, fetchKept };
    if (notice !== null) {
      lastNotice = notice;
      logger('info', `better-search: reconciled external setting (${notice.code})`);
    }
    return lastNotice;
  }

  /**
   * Current notice (cleared by the next explicit panel action).
   * @returns {object|null} notice or null.
   */
  function noticeState() {
    return lastNotice === null ? null : { ...lastNotice };
  }

  /**
   * Write the effective search selection into DSH's `web` row.
   * @returns {Promise<{ok: boolean, providerId: string, error: string|null}>} outcome.
   */
  async function applyPin() {
    const snapshot = store.snapshot();
    const selectedId = effectiveSelection(snapshot);
    const providerId = providerIdOf(selectedId);
    if (providerId === '') {
      // Nothing in the store maps to a provider. If a previous install left a
      // `better-search/*` pin behind (offline uninstall), replace it now instead of
      // leaving every search failing with WEB_PROVIDER_CONFIGURED_MISSING.
      const current = webField('searchProvider') ?? '';
      if (current.startsWith('better-search/')) {
        const outcome = await writeWebField('searchProvider', 'deepseek-search-api');
        pin = { ok: outcome.ok, providerId: 'deepseek-search-api', error: outcome.error };
        if (outcome.ok) logger('info', 'better-search: healed a stale searchProvider pin');
        return pin;
      }
      pin = { ok: true, providerId: '', error: null };
      return pin;
    }
    const outcome = await writeWebField('searchProvider', providerId);
    pin = { ok: outcome.ok, providerId, error: outcome.error };
    if (outcome.ok) logger('info', `better-search: pinned web.searchProvider=${providerId}`);
    else logger('error', `better-search: pin failed: ${outcome.error}`);
    return pin;
  }

  /**
   * Write the effective fetch selection into DSH's `web` row.
   *
   * When nothing should be pinned, this restores the value DSH had before the
   * plugin loaded — never an empty string, so an unconfigured fetch provider
   * keeps its native default.
   * @returns {Promise<{ok: boolean, error: string|null}>} outcome.
   */
  async function applyFetchPin() {
    const snapshot = store.snapshot();
    const providerId = effectiveFetchProviderId(snapshot);
    const baseline = ensureOriginalFetchProvider();
    const target = providerId === '' ? baseline : providerId;
    const current = webField('fetchProvider');
    if (providerId === '' && (current === undefined || !current.startsWith('better-search/'))) {
      fetchPin = { ok: true, error: null };
      return fetchPin;
    }
    const outcome = await writeWebField('fetchProvider', target);
    fetchPin = { ok: outcome.ok, error: outcome.error };
    if (outcome.ok) logger('info', `better-search: pinned web.fetchProvider=${target}`);
    else logger('error', `better-search: fetch pin failed: ${outcome.error}`);
    return fetchPin;
  }

  /**
   * Put both DSH fields back to shipped providers before this plugin stops
   * owning them.
   * @returns {Promise<void>} resolves after the best-effort restore.
   */
  async function restore() {
    try {
      const currentSearch = webField('searchProvider');
      if (typeof currentSearch === 'string' && currentSearch.startsWith('better-search/')) {
        const fallback = BUILTIN_PROVIDERS.find((entry) => entry.providerId === 'deepseek-search-api') ?? BUILTIN_PROVIDERS[0];
        await writeWebField('searchProvider', fallback.providerId);
        logger('info', `better-search: restored web.searchProvider=${fallback.providerId}`);
      }
    } catch (error) {
      logger('warn', `better-search: could not restore the search provider: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const currentFetch = webField('fetchProvider');
      if (typeof currentFetch === 'string' && currentFetch.startsWith('better-search/')) {
        const baseline = ensureOriginalFetchProvider();
        await writeWebField('fetchProvider', baseline);
        logger('info', `better-search: restored web.fetchProvider=${baseline}`);
      }
    } catch (error) {
      logger('warn', `better-search: could not restore the fetch provider: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Set the search selection and pin it.
   * @param {string} id - `builtin:<providerId>` or a stored service id.
   * @returns {Promise<object>} pin outcome.
   */
  async function select(id) {
    const known = id.startsWith('builtin:') || store.serviceOf(id) !== undefined;
    if (!known) throw new Error(`未知的搜索服务：${id}`);
    await store.mutate((current) => {
      current.selectedId = id;
    });
    lastNotice = null;
    const outcome = await applyPin();
    if (store.snapshot().fetch.mode === 'follow') await applyFetchPin();
    return outcome;
  }

  /**
   * Set the fetch selection and pin it.
   * @param {{mode: string, serviceId?: string}} choice - panel choice.
   * @returns {Promise<object>} fetch pin outcome.
   */
  async function selectFetch(choice) {
    const mode = choice.mode;
    if (mode !== 'official' && mode !== 'follow' && mode !== 'service') {
      throw new Error(`未知的抓取方式：${String(mode)}`);
    }
    if (mode === 'service') {
      const service = store.serviceOf(choice.serviceId ?? '');
      if (service === undefined) throw new Error('选择的服务不存在');
      if (!fetchCapableType(fetchAdapters, service.type)) throw new Error(`${service.name} 不支持网页抓取`);
    }
    await store.mutate((current) => {
      current.fetch = { mode, serviceId: mode === 'service' ? String(choice.serviceId) : '' };
    });
    lastNotice = null;
    return applyFetchPin();
  }

  /**
   * Run one tiny query against a stored service or a built-in.
   * @param {string} id - entry id.
   * @returns {Promise<{ok: boolean, ms: number, error?: string, sources?: number}>} outcome.
   */
  async function test(id) {
    const started = Date.now();
    if (id.startsWith('builtin:')) {
      const error = '内置服务由官方插件管理，切换到它之后即可直接使用，无需测试';
      connections.set(id, null);
      return { ok: false, ms: 0, error };
    }
    const service = store.serviceOf(id);
    if (service === undefined) throw new Error(`未知的搜索服务：${id}`);
    const descriptor = providerOf(service.type);
    const adapter = adapters[service.type];
    if (descriptor === undefined || typeof adapter !== 'function') {
      return { ok: false, ms: Date.now() - started, error: `该服务类型暂不支持搜索：${service.type}` };
    }
    if (!serviceReady(service, descriptor)) {
      connections.set(id, false);
      return { ok: false, ms: Date.now() - started, error: '配置不完整：请检查 API Key 或实例地址' };
    }
    const pool = keyPool(service);
    try {
      const outcome = await adapter({
        query: 'connectivity test',
        maxResults: 1,
        service: { ...service, apiKey: pool[0] ?? '' },
        descriptor,
        timeoutMs: Math.min(15000, store.snapshot().common.timeoutMs),
      });
      const ok = Array.isArray(outcome?.sources);
      connections.set(id, ok);
      return { ok, ms: Date.now() - started, sources: outcome?.sources?.length ?? 0 };
    } catch (error) {
      connections.set(id, false);
      return {
        ok: false,
        ms: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Query a provider's account quota. Only Tavily and LinkUp expose one.
   * @param {string} id - stored service id.
   * @returns {Promise<{ok: boolean, usage?: object, error?: string}>} outcome.
   */
  async function usage(id) {
    const service = store.serviceOf(id);
    if (service === undefined) throw new Error(`未知的搜索服务：${id}`);
    const descriptor = providerOf(service.type);
    const adapter = usageAdapters[service.type];
    if (descriptor === undefined || typeof adapter !== 'function') {
      return { ok: false, error: '该服务商不提供用量查询' };
    }
    const pool = keyPool(service);
    if (pool.length === 0) return { ok: false, error: '配置不完整：请先填写 API Key' };
    try {
      const result = await adapter({
        service: { ...service, apiKey: pool[0] },
        descriptor,
        timeoutMs: Math.min(10000, store.snapshot().common.timeoutMs),
      });
      return { ok: true, usage: result };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Masked view of a service's key pool.
   * @param {string} id - service id.
   * @returns {{keys: {id: string, masked: string, primary: boolean}[]}} masked pool.
   */
  function keysView(id) {
    const service = store.serviceOf(id);
    if (service === undefined) throw new Error(`未知的搜索服务：${id}`);
    return {
      keys: (service.keys ?? []).map((entry, index) => ({
        id: entry.id,
        masked: maskKey(entry.value),
        primary: index === 0,
      })),
    };
  }

  /**
   * Append keys to a service's pool, skipping duplicates.
   * @param {string} id - service id.
   * @param {string[]} values - candidate credentials.
   * @returns {Promise<{added: number, skipped: number}>} counts.
   */
  async function addKeys(id, values) {
    const service = store.serviceOf(id);
    if (service === undefined) throw new Error(`未知的搜索服务：${id}`);
    const candidates = values
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter((value) => value.length > 0);
    const existing = new Set(keyPool(service));
    const fresh = [];
    let skipped = 0;
    for (const value of candidates) {
      if (existing.has(value)) {
        skipped += 1;
        continue;
      }
      existing.add(value);
      fresh.push({ id: newKeyId(), value });
    }
    if (fresh.length > 0) {
      await store.mutate((current) => {
        const target = current.services.find((entry) => entry.id === id);
        if (target !== undefined) target.keys = [...(target.keys ?? []), ...fresh];
      });
      sync();
      if (keyPool(service).length === fresh.length) await applyPin();
    }
    return { added: fresh.length, skipped };
  }

  /**
   * Remove one key from a service's pool.
   * @param {string} id - service id.
   * @param {string} keyId - key entry id.
   * @returns {Promise<boolean>} whether a key was removed.
   */
  async function removeKey(id, keyId) {
    const service = store.serviceOf(id);
    if (service === undefined) throw new Error(`未知的搜索服务：${id}`);
    const before = (service.keys ?? []).length;
    await store.mutate((current) => {
      const target = current.services.find((entry) => entry.id === id);
      if (target !== undefined) target.keys = (target.keys ?? []).filter((entry) => entry.id !== keyId);
    });
    const removed = (store.serviceOf(id)?.keys ?? []).length < before;
    if (removed) sync();
    return removed;
  }

  /**
   * Reveal one stored credential. The panel only gets this on an explicit click.
   * @param {string} id - service id.
   * @param {string} keyId - key entry id.
   * @returns {string} the credential, or `''` when it is gone.
   */
  function revealKey(id, keyId) {
    const service = store.serviceOf(id);
    if (service === undefined) throw new Error(`未知的搜索服务：${id}`);
    return (service.keys ?? []).find((entry) => entry.id === keyId)?.value ?? '';
  }

  /**
   * Panel view of one stored service — never includes credentials.
   * @param {any} service - stored service.
   * @returns {object} view.
   */
  function serviceView(service) {
    const descriptor = providerOf(service.type);
    const pool = keyPool(service);
    return {
      id: service.id,
      type: service.type,
      name: service.name,
      enabled: service.enabled,
      baseURL: service.baseURL,
      options: service.options,
      keySet: pool.length > 0,
      keyCount: pool.length,
      brand: descriptor?.brand ?? null,
      providerId: `better-search/${service.id}`,
      connected: connections.get(service.id) ?? null,
      supported: descriptor !== undefined && typeof adapters[service.type] === 'function',
      fetchCapable: descriptor !== undefined && fetchCapableType(fetchAdapters, service.type),
      usageSupported: descriptor !== undefined && typeof usageAdapters[service.type] === 'function',
    };
  }

  return {
    sync,
    restore,
    select,
    selectFetch,
    test,
    usage,
    keysView,
    addKeys,
    removeKey,
    revealKey,
    applyPin,
    applyFetchPin,
    drift,
    reconcile,
    /**
     * Current search-pin outcome (last write attempt).
     * @returns {{ok: boolean, providerId: string, error: string|null}} the outcome.
     */
    pinState: () => ({ ...pin }),
    /**
     * Current fetch-pin outcome.
     * @returns {{ok: boolean, error: string|null}} the outcome.
     */
    fetchPinState: () => ({ ...fetchPin }),
    /**
     * Full panel state as described in `docs/CONTRACT.md`.
     * @returns {object} state.
     */
    state() {
      const snapshot = store.snapshot();
      const builtins = BUILTIN_PROVIDERS.map((entry) => ({
        id: entry.id,
        providerId: entry.providerId,
        type: entry.type,
        name: entry.name,
        nameEn: entry.nameEn,
        brand: entry.brand,
        builtin: true,
        removable: false,
        fetchCapable: true,
        connected: connections.get(entry.id) ?? null,
      }));
      return {
        services: snapshot.services.map(serviceView),
        builtins,
        selectedId: effectiveSelection(snapshot),
        common: snapshot.common,
        ui: snapshot.ui,
        fetch: {
          mode: snapshot.fetch.mode,
          serviceId: snapshot.fetch.serviceId,
          providerId: effectiveFetchProviderId(snapshot),
          pin: { ...fetchPin },
        },
        pin: { ...pin },
        drift: drift(),
        notice: noticeState(),
        dataDir: store.dir,
      };
    },
    /**
     * Whether an entry id names something this plugin can serve.
     * @param {string} id - entry id.
     * @returns {boolean} known.
     */
    has: (id) => id.startsWith('builtin:') ? BUILTIN_PROVIDERS.some((entry) => entry.id === id) : store.serviceOf(id) !== undefined,
    /**
     * Fetch capability of an entry.
     * @param {string} id - entry id.
     * @returns {boolean} fetch capable.
     */
    fetchCapable: (id) => {
      if (id.startsWith('builtin:')) return true;
      const service = store.serviceOf(id);
      return service !== undefined && fetchCapableType(fetchAdapters, service.type);
    },
    /**
     * Runtime adapter coverage, reported by the panel when a type cannot run.
     * @returns {string[]} supported search type ids.
     */
    supportedTypes: () => Object.keys(adapters),
    dispose() {
      disposed = true;
      for (const serviceId of [...disposers.keys()]) unregister(serviceId);
      connections.clear();
      cursors.clear();
    },
  };
}
