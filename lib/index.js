/**
 * dsh-better-search — Host half.
 *
 * Owns the service store, the dynamic `ctx.web` provider registrations and the
 * panel HTTP API. The browser half in `lib/client.js` is served by the Web shell
 * and only talks to this Host over same-origin HTTP.
 *
 * The plugin deliberately adds **no model-facing tool**: the built-in
 * `web_search`/`web_fetch` tools keep working unchanged, and this plugin only
 * changes which search provider `ctx.web` selects by pinning
 * `web.searchProvider` to the service chosen in the panel.
 *
 * Everything it writes lives under `$DSH_HOME/better-search/`. The only state it
 * touches outside that directory is the single `searchProvider` field of the
 * profile's `web` row, and it restores that field on unload.
 *
 * @module @ds-hu/dsh-better-search
 */
import { API_PREFIX, createApi } from './api.js';
import { providerOf } from './catalog.js';
import { createRegistry } from './registry.js';
import { ADAPTERS } from './search/index.js';
import { createStore, resolveDataDir } from './store.js';

/** Plugin name registered with the Loader; must equal the row `id` in the bundle patch. */
export const name = 'dsh-better-search';

/** Host services this plugin cannot work without. `web` is the seam it registers into. */
export const inject = ['webServer', 'web'];

/**
 * Mount the plugin.
 * @param {any} ctx - Host plugin context (Cordis).
 * @returns {Promise<() => Promise<void>>} disposer removing the route and the pin.
 */
export async function apply(ctx) {
  /**
   * Route diagnostics through the Host logger when present.
   * @param {string} level - `debug` | `info` | `warn` | `error`.
   * @param {string} message - text to record.
   * @returns {void}
   */
  const logger = (level, message) => {
    try {
      const sink = ctx.logger;
      if (sink !== undefined && typeof sink[level] === 'function') {
        sink[level](message);
        return;
      }
      if (typeof sink === 'function') {
        sink(level, message);
        return;
      }
      if (level === 'warn' || level === 'error') console.warn(message);
    } catch {
      /* diagnostics must never break the plugin */
    }
  };

  const dir = resolveDataDir();
  const store = createStore({ dir, descriptorOf: providerOf, logger });
  const registry = createRegistry({ ctx, store, adapters: ADAPTERS, logger });
  const api = createApi({ store, registry, ctx, logger });

  await store.load();
  registry.sync();
  await registry.applyPin();
  await registry.applyFetchPin();
  logger('info', `better-search: ${store.snapshot().services.length} service(s), data in ${dir}`);

  const unregister = ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: api.handler,
  });

  return async () => {
    try {
      unregister();
    } catch (error) {
      logger('warn', `better-search: route removal failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await registry.restore();
    registry.dispose();
  };
}
