# dsh-better-search — technical notes

Everything the README leaves out. Read this before changing the store, the registry, the HTTP
surface or the client bundle. The frozen Host↔browser contract is
[docs/CONTRACT.md](CONTRACT.md); when this file and the contract disagree, the contract wins and
one of them is a bug.

- [Why a plugin and not a replacement](#why-a-plugin-and-not-a-replacement)
- [Shape of the bundle](#shape-of-the-bundle)
- [Two browser entries, one manager](#two-browser-entries-one-manager)
- [Selection is a pin, not a registry write](#selection-is-a-pin-not-a-registry-write)
- [Data model](#data-model)
- [Provider registry](#provider-registry)
- [Adapters](#adapters)
- [HTTP surface](#http-surface)
- [Browser half](#browser-half)
- [Failure modes](#failure-modes)
- [Testing](#testing)

## Why a plugin and not a replacement

`ctx.web` (`@deepseek-ai/dsh-web`) is a small seam with six public methods:
`registerSearchProvider`, `registerFetchProvider`, `search`, `fetch`, `searchReady`, `fetchReady`.
Registration returns a disposer bound to the calling fiber, so a plugin can add providers at runtime
and lose them on dispose. That is exactly the shape this feature needs: no fork of `dsh-web`, no
replacement of `dsh-tool-web`, no new tool for the model.

The one thing the seam cannot do is **enumerate** providers — there is no `listSearchProviders()`.
The plugin therefore keeps its own catalog (`lib/catalog.js`) and knows the two shipped DeepSeek
providers by id (`deepseek-official`, `deepseek-search-api`) to render them as built-in cards. A
duplicate provider id is impossible here because every dynamic id is namespaced
(`better-search/<serviceId>`).

Provider choice itself is resolved at call time by `ctx.web`:

```
pinned id registered and available  → that provider
pinned but not registered           → WEB_PROVIDER_CONFIGURED_MISSING
pinned but available() === false    → WEB_PROVIDER_CONFIGURED_UNAVAILABLE
no pin, exactly one usable          → that one
no pin, several usable              → WEB_PROVIDER_AMBIGUOUS
none                                → WEB_PROVIDER_UNAVAILABLE
```

So "selecting" a service really means writing the pin. Everything else follows.

## Shape of the bundle

```
package.json          dsh.bundle.patch → cordis.patch.yml; dsh.client → ./lib/client.js
cordis.patch.yml      one insert row, id = dsh-better-search
lib/index.js          Host entry (inject: ['webServer', 'web'])
lib/store.js          $DSH_HOME/better-search/store.json
lib/registry.js       ctx.web registrations + pin
lib/api.js            HTTP router under /better-search/api
lib/http.js           node:http helpers (same-origin fence, bounded JSON body)
lib/catalog.js        provider descriptor table (26 entries)
lib/search/*          adapters, one module per request-shape family
lib/client.js         browser module: Settings entry + optional sidebar module (no build step)
lib/client.css        mirror of the stylesheet inlined into client.js (kept in sync by a test)
assets/brands/*.svg   brand icons served by GET /brand/:file
```

The Host half is a normal Cordis plugin: `inject = ['webServer', 'web']`, `apply(ctx)` loads the
store, reconciles registrations, applies the pin, and registers one prefix route. The browser half
is declared through `dsh.client` and loaded by the Web shell like any other client plugin.

## Two browser entries, one manager

The plugin ships one management UI in two surfaces:

- **Settings (default).** `lib/client.js` registers a `settings.section` contribution
  (`id: "better-search"`, `order: 12`, between *Models* and *Built-in plugins*) plus the matching
  `settings.section.icon` row. The section renders the manager in its `settings` variant: a 760 px
  settings page with its own heading, no page-level scroll container and no page background, so it
  sits in the Settings shell like the Models/Plugins pages. The slot declarations belong to
  `@deepseek-ai/dsh-client-ui-settings-general`; `ctx.slots.inject` waits for them, so a composition
  without the Settings shell simply shows no section instead of failing.
- **Sidebar module (optional).** The historical `main` page (`key: "better-search"`) and
  `sidebar.panellist` row (`id: "better-search"`, `order: 5`) are mounted by one module in
  `apply()`. `apply` mounts it optimistically, then reads `GET /state` once and reconciles with the
  persisted `ui.sidebarPanel` preference (`false` unmounts it). The Settings section renders a
  **Sidebar entry** switch; flipping it issues `PUT /ui` and mounts/unmounts both slot
  contributions live through their `slots.inject` disposers — no reload, no restart. A Host half
  older than 0.4 has no `ui` block, so the module stays mounted and the switch reports the failed
  write in a localized banner.

Both surfaces share `SearchServicesManager`; only the frame (heading, background, scroll behaviour)
and the settings-only switch row differ.

## Selection is a pin, not a registry write

There are two selections — search and fetch — and each is pinned into its own field.

`lib/registry.js` writes the search selection with
`ctx.settings.update('web', { searchProvider })`, and the fetch selection the same way with
`fetchProvider`. The procedure below applies to both:

1. `settings.describe()` → find the `web` row and its revision.
2. If the value already matches, stop (idempotent; avoids rewriting the profile patch on every boot).
3. `settings.update('web', patch, revision)` → `configEditor` rewrites the profile's
   `cordis.patch.yml` atomically and applies a live volatile update, no remount.
4. On `SETTINGS_CONFLICT`, re-describe and retry once; otherwise record the error and surface it in
   the `state.pin` payload (the panel shows an inline warning instead of pretending it worked).

Why not environment variables: `$DSH_WEB_SEARCH_PROVIDER` / `$DSH_WEB_FETCH_PROVIDER` are read once
in the `WebRuntime` constructor, so they are restart-only and mutually exclusive with the YAML field.
The settings write is live and is the same field the official settings page uses.

Why not register a single "always selected" provider: `web.searchProvider` still has to point
somewhere. Registering one multiplexer provider would make provider *identity* invisible to
`ctx.web`, defeating per-provider semantics (`available()`, `WEB_PROVIDER_*`, test connections).

**Fetch selection:** `fetch.mode` is `official` (leave DSH's own `fetchProvider` alone — it is
captured at startup and restored verbatim), `follow` (pin the selected search service when it has a
fetch adapter; when the selection is a built-in search, follow means "leave DSH's own provider
alone") or `service` (pin that service explicitly). A non-fetch-capable service is rejected
with a 400, never silently ignored.

**Unload:** before the plugin stops owning either pin, `registry.restore()` puts
`web.searchProvider` back to `deepseek-search-api` (then `deepseek-official`) and
`web.fetchProvider` back to the value it had at load — but only if they currently point at a
`better-search/*` id. Without this, disabling the bundle would leave every search/fetch failing with
`WEB_PROVIDER_CONFIGURED_MISSING`.

**Unknown pin:** on boot, an empty `selectedId` is resolved from the current `web.searchProvider`
value, so the panel always highlights what is actually in effect even if the store was deleted.

## Data model

```jsonc
{
  "version": 3,
  "services": [{
    "id": "svc_1y1ga8t1",       // local, stable, never exposed as a provider id
    "type": "tavily",           // catalog type id
    "name": "Tavily",           // editable display name
    "enabled": true,
    "keys": [{ "id": "key_ab12cd", "value": "…" }],  // ordered pool, first = primary
    "baseURL": "",              // "" → catalog default endpoint
    "options": {},              // catalog extras (region, mode, engines, …)
    "createdAt": "2026-11-17T06:41:30.099Z"
  }],
  "selectedId": "svc_1y1ga8t1", // or "builtin:<providerId>"
  "common": { "maxResults": 8, "timeoutMs": 30000, "autoTestOnLaunch": true },
  "fetch": { "mode": "official", "serviceId": "" },  // official | follow | service
  "ui": { "sidebarPanel": true }                     // optional sidebar module, default on
}
```

v1 files (`apiKey` + `apiKeys[]`) are migrated on load: same order, generated `key_` ids,
`version` becomes 2. v2 files inherit `ui: { sidebarPanel: true }`; `version` becomes 3. The `ui`
block holds browser-surface preferences only — provider configuration stays in `services`, `common`
and `fetch`.

Invariants:

- `services[].id` is generated by the Host (`svc_` + 8 base36 chars) and validated on every write.
- One service → one provider id `better-search/<service.id>`, registered for search and/or fetch
  depending on adapter coverage; the id never changes, so renames do not invalidate either pin.
- `services[].options` is filtered against the catalog on write: only declared `extras[].key` values
  survive, so a stale editor cannot inject arbitrary fields.
- Writes are serialized through one promise queue and flushed atomically (`writeFile` to a temp file,
  then `rename`). Reads are served from memory.
- Credentials are never serialized to the browser. `GET /state` returns `keySet` / `keyCount` only;
  `GET /services/:id/keys` returns masked entries, and a plain value leaves the Host only through
  `POST /services/:id/keys/:keyId/reveal` (an explicit click). Updates either omit `keys` (keep),
  send `keys: []` (clear) or `appendKeys` (append + dedupe).
- Built-ins are synthesized from `BUILTIN_PROVIDERS` in `lib/registry.js`; they are not stored and
  cannot be edited or deleted through this API.

## Provider registry

`sync()` reconciles `ctx.web` with the store: dispose services that disappeared, then re-register
every remaining one. Re-registering on each sync is deliberate — a service's key set, base URL and
extras can all change, and provider objects capture them at registration time. The old provider is
disposed *before* the new one is registered so duplicate ids can never collide
(`WEB_DUPLICATE_PROVIDER`).

Each provider object is registered for search and/or fetch under the same id:

```js
{
  id: `better-search/${service.id}`,
  available: () => serviceReady(service, descriptor),   // cheap, no network, no I/O
  ready: async () => serviceReady(service, descriptor),
  search: async (request, signal) => { … adapter call … },   // when a search adapter exists
  fetch: async (request, signal) => { … fetch adapter call … } // when a fetch adapter exists
}
```

`available()` must never touch the network: `ctx.web` calls it on every search, and a slow check
would turn into a slow tool call. "Ready" here means *configured*: a required key is present, and a
SearXNG instance URL is filled in. Whether the key is *valid* is what the connection test answers.

The `search` wrapper:

- re-checks readiness and throws `WebError(…, 'WEB_PROVIDER_CREDENTIAL_MISSING')` with a zh message;
- rotates keys (`[apiKey, ...apiKeys]`, round-robin per service, cursor in memory);
- clamps `maxResults` to `common.maxResults`;
- slices the returned sources again (belt and braces: adapters slice too);
- returns the seam's shape `{ content?, sources, truncated: false }`.

An adapter failure propagates as a normal thrown error, which the tool surfaces to the model with the
provider's own message (e.g. `Tavily HTTP 401: {…}`).

The fetch wrapper normalizes the adapter outcome into the seam's `WebFetchResult`:
`{ url: finalUrl ?? request.url, statusCode, body: { kind: 'text', content }, truncated: false }`.

## Adapters

`lib/catalog.js` is the single descriptor table (26 types). An adapter receives

```js
{ query, maxResults, service, descriptor, signal, timeoutMs }
```

and returns `{ content?, sources: [{ url, title?, snippet?, summary?, publishedAt? }] }`.
`lib/search/index.js` is the only public registry (`ADAPTERS`, `hasAdapter`, `searchWith`).

Grouping follows request shape, not brand (`docs/reference/kelivo-providers.md` §5.1):

| Module | Family | Types |
|---|---|---|
| `json-api.js` | configurable JSON POST | tavily, exa, ollama, deepseek, jina, kimi, kagi, firecrawl, parallel, perplexity, anysearch |
| `envelopes.js` | nested CN envelopes / answer APIs | zhipu, metaso, bocha, doubao, querit, stepfun, linkup, grok |
| `flat.js` | custom auth header + flat results, and the two scrapers | serper, you, tinyfish, brave, bing_local, duckduckgo |
| `searxng.js` | self-hosted GET JSON | searxng |
| `fetch.js` | page extraction (markdown), one adapter per fetch-capable type | tavily, exa, linkup, metaso, ollama, deepseek, jina, querit, firecrawl, tinyfish, anysearch, parallel, you |
| `usage.js` | account quota / balance | tavily (`/usage`), linkup (`/credits/balance`) |
| `http.js` | shared transport | — |

Rules every adapter follows:

- endpoint = `service.baseURL` verbatim when set, else the provider's canonical URL; a bare origin
  gets the canonical path appended;
- auth header shape comes from `descriptor.auth`; the credential is `service.apiKey` (already rotated
  by the registry) — adapters never see the rest of the pool;
- request timeout = `min(common.timeoutMs, …)` via `AbortSignal.any` + `AbortSignal.timeout`;
- non-2xx throws `HttpFailure(status, "<provider> HTTP <status>: <truncated body>")`;
- server-side count clamps follow `docs/reference/kelivo-providers.md` §5.2, then sources are sliced;
- URL-less items are dropped (the seam's source schema requires a URL);
- `content` is only set when the provider returns an answer (`tavily`, `linkup`, `grok`,
  `perplexity`, …), so search turns can carry a synthesized answer the way DSH expects.

Two adapters are honestly fragile: `bing_local` and `duckduckgo` parse HTML with string/regex
extraction. They are keyless and useful, but a markup change breaks them; both carry a warning in
their module header.

## HTTP surface

One prefix route, `ctx.webServer.register({ kind: 'prefix', path: '/better-search/api', handler })`.
Reads are plain JSON; mutations are same-origin JSON (`assertSameOrigin`) with a 64 KiB body cap.
Every mutation answers with the same `state` payload the page already polls, so the UI needs no
follow-up request.

| Method + path | Purpose |
|---|---|
| `GET /catalog` | descriptors + `supportedTypes` + `common.limits` |
| `GET /state` | services, builtins, selection, common options, pin outcome, data dir |
| `POST /services` | create (auto-selects when nothing is selected) |
| `PUT /services/:id` | update; omitted key keeps, `""` clears, `appendApiKeys` merges |
| `DELETE /services/:id` | delete; re-pins if it was selected |
| `POST /select` | pin an entry (`builtin:<id>` or service id) |
| `POST /services/:id/test` | one real query with `maxResults: 1`, 15 s cap |
| `POST /services/:id/usage` | quota lookup through the usage adapter |
| `GET/POST /services/:id/keys` | masked key list / batch append (dedupe) |
| `DELETE /services/:id/keys/:keyId` | remove one key, promoting the next primary |
| `POST /services/:id/keys/:keyId/reveal` | return one plain credential (explicit click) |
| `PUT /fetch` | `{mode, serviceId?}` → pin `web.fetchProvider` |
| `POST /reorder` | reorder stored services |
| `PUT /common` | clamp and store general options |
| `PUT /ui` | store `{ sidebarPanel?: boolean }`; omitted fields keep their value, non-booleans are `invalid-field` |
| `GET /brand/:file` | brand SVG from `assets/brands/`, 1-day cache |

`pin` failures are reported, not thrown: a mutation that saves fine but cannot write
`web.searchProvider` still returns 200 with `pin.ok === false` and the error text, because the
service is stored and the next attempt may succeed (e.g. after the `web` row is un-disabled).

## Browser half

`lib/client.js` is a plain module-loader module (no build step): `window.__ModuleLoader__.load({ id,
factory })`, `require("react")` only, `h()` instead of JSX. It registers:

- `settings.section` + `settings.section.icon`, `id: "better-search"`, `order: 12` — the default
  management entry (always registered);
- `sidebar.panellist`, `id: "better-search"`, `order: 5` — between 插件 (`plugins`, 0) and
  自动化任务 (`schedules`, 10), plus `main`, `key: "better-search"` — the optional sidebar module.

State comes from `GET /state` (once in `apply` to decide the sidebar module, then polled every 4 s
while a surface is mounted), plus `GET /catalog` once (cached). All mutations are `fetch` calls to
the Host, then the returned state replaces local state. The page never learns a credential: password
inputs start empty and only send a value the user typed.

The page has three extra surfaces beyond v1: the **抓取方式** row (a `_WebFetchModeRow` port with a
168 px select), the **账户用量** card in the edit dialog (Wallet icon, refresh, Tavily progress bar,
LinkUp balance, `用量查询失败：{message}`), and the **multi-key dialog** (440×520 masked list with
reveal/delete plus a batch textarea). Cards of fetch-capable services carry a FileText glyph.

The stylesheet lives in `lib/client.css` and is inlined into `client.js` at build time by hand, i.e.
the two files are kept identical and a smoke test asserts it (`lib/client.css has drifted from the
inline stylesheet`). Colors, radii and fonts are DSH theme variables only
(`--dsw-alias-*`, `--dsw-radius-*`, `--dsw-font-family`) — the approved variant B of the design
round. `--dsw-alias-fill-l1/l2` do not exist in the theme; they are used with fallbacks on purpose.

Visual source of truth: the approved design mockup plus
`docs/reference/kelivo-ui-spec.md` (numeric extraction from Kelivo). Kelivo's fetch slice is omitted:
no fetch-mode row, no fetch badge on cards, no fetch-related copy.

## Failure modes

| Symptom | Cause | Where |
|---|---|---|
| Panel shows "无法写入 web.searchProvider" banner | profile patch unwritable / settings row missing | `state.pin.error` |
| Search fails `WEB_PROVIDER_CONFIGURED_MISSING` | pinned provider was not registered (adapter missing, or plugin disabled before restore) | `registry.sync()` |
| Search fails `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` | service lost its key or instance URL | `serviceReady()` |
| Test always "连接失败" with 401 | wrong key — the provider's message is shown as-is | adapter `HttpFailure` |
| Card status resets to 未测试 after a `dsh web` restart | connection status is in-memory by design (Kelivo parity) | `registry.connections` |
| Duplicate entry failure on boot | the bundle patch is applied twice (profile-layer insert + bundle) | keep only one source for row `dsh-better-search` |
| Sidebar-entry switch reports a failed write | the running Host half predates 0.4 (no `PUT /ui`); restart `dsh web` after updating the package | `lib/api.js` |
| Sidebar row missing after boot although `ui.sidebarPanel` is true | the initial `GET /state` failed; the module is kept mounted optimistically, any later poll/state answer reconciles it | `noteStatePayload()` |

## Testing

- `test/host.test.mjs` — store, registry and router against a fake `ctx.web` / `ctx.settings`:
  provider registration, pinning, delete fallback, clamping, cross-origin fence, brand serving,
  unload restore, reload from disk, the v3 `ui` preference (37 cases).
- `test/adapters.test.mjs` — per-family mapping with a fake `fetch`: happy path, count clamp,
  `maxResults` slice, non-2xx → `HttpFailure`, empty results (29 cases).
- `test/client-smoke.mjs` — module format, the Settings section + icon registrations, the live
  sidebar-module switch, the settings-variant switch row, zh/en dictionaries, CSS idempotence,
  `lib/client.css` ↔ inline stylesheet parity, helper behaviour, icon shape.

Tests are offline by construction: adapters receive their `fetch` through
`lib/search/http.js`'s `setFetchForTests`, and the Host tests never mount a real profile.

## Reconciling DSH's own web-search page

`web.searchProvider` and `web.fetchProvider` are shared with DSH's built-in
**网页搜索** settings page, whose switch writes both fields at once. The plugin
therefore treats the pinned field as an *observation*, not an assumption:

- On boot the order is `sync → reconcile → applyPin → applyFetchPin`, so a change
  made while the plugin was disabled is adopted instead of overwritten.
- `reconcile()` (also `POST /reconcile`) adopts external values into the store and
  only writes when healing (`better-search/*` pointing at a missing service, or a
  cleared field) or when re-asserting a preserved fetch mode. It never overwrites a
  provider owned by another plugin; it reports `foreign` and deselects instead.
- The fetch mode is a preference independent of the search selection. The official
  switch stages `searchProvider` and `fetchProvider` in **one** settings mutation,
  so when both fields drift together, `reconcile()` adopts only the search half and
  keeps `fetch.mode`; `applyFetchPin()` then re-asserts it when the new selection
  still maps to a fetch provider, and the notice carries `fetchKept`. A fetch-only
  external change is still adopted (service pin → `mode: service`, shipped provider
  → `mode: official`).
- `drift()` reports fetch only while the plugin owns the field and the value
  differs, or while a `better-search/*` id is pinned although nothing is owned.
  `expected: ""` means unowned, so `http` / `deepseek-fetch-api` are accepted while
  following a built-in search and can never cause a reconcile loop.
- `GET /state` exposes `drift` (read-only) and the panel calls `/reconcile` once per
  distinct drift value, then shows a localized notice. `POST /select` and
  `PUT /fetch` clear the notice.
- `ensureOriginalFetchProvider()` sanitizes the captured baseline, so an offline
  uninstall cannot make `restore()` write a provider id that no longer exists.

Residue: the plugin writes only `$DSH_HOME/better-search/` (plus the two provider
fields, restored on unload). `bin/better-search.mjs clean --yes` removes the store;
`status` reports counts without printing credentials.
