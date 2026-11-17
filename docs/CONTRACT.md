# Build contract — dsh-better-search

Two halves, one bundle. The Host owns data, providers and the HTTP API; the
browser half owns the panel. They never share module code; they share only the
JSON contract below.

## File ownership

| Path | Owner | Purpose |
|---|---|---|
| `lib/index.js` | Host entry: store, registry, HTTP API wiring |
| `lib/store.js` | `$DSH_HOME/better-search/store.json` read/write |
| `lib/api.js` | HTTP router under `/better-search/api` |
| `lib/registry.js` | registers providers into `ctx.web`, pins both provider ids |
| `lib/catalog.js` | provider descriptor table — do not change field names |
| `lib/search/*.js` | provider adapters | one module per provider family + `index.js` registry |
| `lib/client.js` | browser half | panel module (module-loader format) |
| `lib/client.css` | browser half | panel stylesheet (injected at runtime) |
| `assets/brands/*.svg` | brand icons served over HTTP |
| `locale/*.json` | plugin display metadata |

Do not edit files outside your scope. If a contract field is missing, extend this document rather than guessing.

## Store shape (`$DSH_HOME/better-search/store.json`)

```jsonc
{
  "version": 1,
  "services": [
    {
      "id": "svc_lx3k9",            // "svc_" + random, assigned by Host
      "type": "tavily",             // catalog type id
      "name": "Tavily",             // display name, editable
      "enabled": true,
      "apiKey": "tvly-...",         // primary credential ("" when keyless)
      "apiKeys": ["..."],           // extra keys for rotation
      "baseURL": "",                // "" = catalog default
      "options": {},                // catalog extras, keyed by extra.key
      "createdAt": "2026-11-17T06:00:00.000Z"
    }
  ],
  "selectedId": "builtin:deepseek-search-api", // "svc_xxx" | "builtin:<providerId>"
  "common": { "maxResults": 8, "timeoutMs": 30000, "autoTestOnLaunch": true }
}
```

Built-in entries are **not** stored. The Host synthesizes them from the mounted
`ctx.web` providers it knows about:

```jsonc
{ "id": "builtin:deepseek-official", "builtin": true, "removable": false,
  "providerId": "deepseek-official", "type": "deepseek", "name": "DeepSeek 官方",
  "enabled": true, "keySet": true }
```

A service is registered into `ctx.web` as provider id `better-search/<service.id>`.

## HTTP API (Host, same-origin, prefix `/better-search/api`)

All mutations answer `{ ok: true, state }` with the same `state` payload as
`GET /state`. Errors answer `{ ok: false, code, error, field? }` with a 4xx/5xx
status. Body cap 64 KiB. Same-origin check like the mcp-manager.

`state` shape (never contains credentials):

```jsonc
{
  "ok": true,
  "services": [
    { "id": "svc_lx3k9", "type": "tavily", "name": "Tavily", "enabled": true,
      "baseURL": "", "options": {}, "keySet": true, "keyCount": 2,
      "brand": "tavily-color.svg", "providerId": "better-search/svc_lx3k9",
      "connected": true }                 // null = untested, false = failed
  ],
  "builtins": [ { "id": "builtin:deepseek-official", "providerId": "deepseek-official",
                  "type": "deepseek", "name": "DeepSeek 官方", "brand": "deepseek-color.svg",
                  "keySet": true, "connected": null } ],
  "selectedId": "svc_lx3k9",
  "common": { "maxResults": 8, "timeoutMs": 30000, "autoTestOnLaunch": true },
  "pin": { "ok": true, "providerId": "better-search/svc_lx3k9", "error": null },
  "dataDir": "…/better-search"
}
```

| Method + path | Body | Notes |
|---|---|---|
| `GET /catalog` | — | `{ ok, providers: [...], commonFields }` — catalog as-is |
| `GET /state` | — | state |
| `POST /services` | `{ type, name?, apiKey?, apiKeys?, baseURL?, options? }` | create; `name` defaults to the catalog label |
| `PUT /services/:id` | same as create (all optional) | update; omitted credential keeps the stored one; `apiKey: ""` clears it |
| `DELETE /services/:id` | — | 400 `LAST_SERVICE` when it is the only non-builtin service and no builtin is selected… (see rule below) |
| `POST /select` | `{ id }` | pin that entry; Host writes `web.searchProvider` |
| `POST /services/:id/test` | — | performs a real query `connectivity test` with `maxResults: 1`; `{ ok, result, ms }` or `{ ok:false, error }`; updates `connected` |
| `POST /reorder` | `{ ids: ["svc_a", "svc_b"] }` | reorder `services` |
| `PUT /common` | `{ maxResults?, timeoutMs?, autoTestOnLaunch? }` | clamped: maxResults 1–50, timeout 1000–300000 |
| `GET /brand/:file` | — | serves `assets/brands/<file>` with a long cache; `content-type: image/svg+xml` |

Delete rule: the Host refuses to delete the last service **only** when the
current selection points at it; otherwise it re-pins the search provider to
`builtin:deepseek-search-api` if available, else to the first remaining entry.

## Adapter contract (`lib/search/`)

`lib/search/index.js`:

```js
/** @type {Record<string, (ctx: SearchContext) => Promise<SearchOutcome>>} */
export const ADAPTERS = { tavily, exa, /* … */ };

/**
 * @typedef {object} SearchContext
 * @property {string} query
 * @property {number} maxResults
 * @property {object} service        // stored service record (apiKey, apiKeys, baseURL, options)
 * @property {object} descriptor     // catalog entry for service.type
 * @property {AbortSignal} [signal]
 * @property {number} timeoutMs
 *
 * @typedef {object} SearchOutcome
 * @property {string} [content]      // provider answer text, when the API returns one
 * @property {{url: string, title?: string, snippet?: string, summary?: string, publishedAt?: string}[]} sources
 */
```

Rules:

- Throw `Error` with a short, user-visible message on failure. Include the HTTP
  status and a truncated body when a request fails.
- Never log or return credentials.
- Respect `maxResults` server-side where the API supports a count field, and
  always slice `sources` to `maxResults` before returning.
- Request timeout = `timeoutMs` (abort with `AbortSignal.any`).
- Multi-key rotation is handled by the registry: it passes the **already
  selected** key as `service.apiKey`; adapters ignore `service.apiKeys`.
- Use `lib/search/http.js` helpers (`postJson`, `getJson`, `getText`) so headers,
  timeouts and error shaping stay consistent.
- A provider may emit fewer sources than requested; that is not an error.
- Empty result set returns `{ sources: [] }`; the panel shows "没有结果".

`lib/search/http.js` must export at least:

```js
export async function requestJson(url, { method, headers, body, signal, timeoutMs })
export async function requestText(url, { method, headers, body, signal, timeoutMs })
export function HttpFailure(status, message)   // Error subclass with .status
```

## Browser half (`lib/client.js`)

Format (copy `dsh-better-mcp-manager/lib/client.js` head/tail):

```js
window.__ModuleLoader__.load({
  id: "@ds-hu/dsh-better-search",
  factory: (require) => {
    const react = require("react");
    const h = react.createElement;
    /* … components … */
    exports.name = "better-search-client";
    exports.inject = ["slots", "locale"];
    exports.apply = apply;
    return module.exports;
  },
});
```

`apply(ctx)` must:

1. `ctx.effect(() => ctx.locale.register(NS, { zh, en }), "…")` with `NS = "betterSearch"`.
2. `ctx.effect(() => mountCss(), "…")` — inject `CSS` once via a `<style data-plugin>` tag.
3. `ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: PANEL_ID, locale: NS }, PanelPage))`
   with `PANEL_ID = "better-search"`.
4. `ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 5, locale: NS, label: () => t("panel") }, PanelIcon))`.
   `PanelIcon` receives `{ size, active }` and returns an `<svg>`.
5. Fetch state from `API_BASE = "/better-search/api"`; poll `GET /state` every 4 s
   while the panel is the active one (cheap; the Host does no network on it).

Visual source of truth: the approved design mockup plus
`docs/reference/kelivo-ui-spec.md`. Use DSH theme variables — never hard-code colors:

```
--dsw-alias-bg-base, --dsw-alias-bg-layer-1/2/3, --dsw-alias-label-primary/secondary/tertiary,
--dsw-alias-border-l2/l3/l4, --dsw-alias-interactive-bg-hover, --dsw-alias-fill-l1/l2,
--dsw-alias-settings-card-fill, --dsw-alias-settings-card-stroke, --dsw-alias-state-success-primary,
--dsw-alias-state-warn-primary, --dsw-alias-state-error-primary, --dsw-alias-button-primary-fill,
--dsw-alias-button-primary-hover, --dsw-font-family, --dsw-radius-sm/md/lg/xl
```

Card radius 14, section-card radius 12, icon buttons 28×28/radius 8, status pill
11px/600, panel title 14px/400 at 90 % opacity, footer hint 12px/1.4 at 55 %.

Behaviour to implement (Kelivo parity, minus fetch):

- service cards: brand badge 24 px, name 16/700, four-state pill
  (已连接 / 未测试 / 连接失败 / 测试中), actions 编辑 / 测试连接 / 删除
  (built-ins: no delete, plus a subdued「内置」tag), click selects, drag reorders.
- header: title + 28 px「+」.
- add/edit dialog: 420 px wide, radius 16, type dropdown + key + optional URL +
  catalog `extras`; multi-key management (extra keys list) in edit mode only.
- common section: auto-test switch, max-results stepper, timeout stepper.
- footer hint text under the section card.
- all copy from `docs/reference/kelivo-ui-spec.md` §6 (zh + en).

## Testing

- `node --test test/*.test.mjs` (Lead owns the harness).
- `test/adapters.test.mjs` uses a fake `fetch`
  injected through `http.js`'s `setFetchForTests(fn)`.
- `node test/client-smoke.mjs` loads `lib/client.js`
  in a stub `window.__ModuleLoader__` and asserts `apply` registers both slots
  with a fake context.

---

# v2 — multi-key, usage, fetch

This section supersedes the matching parts above. Everything not restated here keeps
its v1 shape.

## Store v2 (`$DSH_HOME/better-search/store.json`)

```jsonc
{
  "version": 2,
  "services": [{
    "id": "svc_x",
    "type": "tavily",
    "name": "Tavily",
    "enabled": true,
    "keys": [{ "id": "key_ab12cd", "value": "tvly-…" }],   // ordered pool, first = primary
    "baseURL": "",
    "options": {},
    "createdAt": "…"
  }],
  "selectedId": "svc_x",
  "common": { "maxResults": 8, "timeoutMs": 30000, "autoTestOnLaunch": true },
  "fetch": { "mode": "official", "serviceId": "" }
}
```

`fetch.mode`: `official` (leave DSH's own fetch provider alone) · `follow` (use the
selected search service when it is fetch-capable) · `service` (`serviceId` names the
fetch provider explicitly).

Migration from v1 (`apiKey` + `apiKeys[]`): build `keys[]` in that order, generate a
`key_` id per entry, bump `version` to 2, drop the old fields.

## State additions (everything else from v1 is unchanged)

```jsonc
{
  "services": [{ "…": "…", "fetchCapable": true }],   // keyCount stays
  "fetch": {
    "mode": "follow",
    "serviceId": "",
    "providerId": "better-search/svc_x",               // effective; "" when official / none
    "pin": { "ok": true, "error": null }
  }
}
```

`keySet`/`keyCount` stay (computed from `keys`). Built-ins gain `fetchCapable` too
(both shipped DeepSeek providers are fetch-capable).

## New / changed endpoints

| Method + path | Body | Response |
|---|---|---|
| `GET /services/:id/keys` | — | `{ ok, keys: [{ id, masked, primary }], state }` |
| `POST /services/:id/keys` | `{ values: string[] }` | `{ ok, added, skipped, state }` — trims, splits nothing (already an array), dedupes against the pool, appends; first key of an empty pool becomes primary |
| `DELETE /services/:id/keys/:keyId` | — | `{ ok, state }`; deleting the primary promotes the next key |
| `POST /services/:id/keys/:keyId/reveal` | — | `{ ok, value }` — same-origin POST only, never cached |
| `POST /services/:id/usage` | — | `{ ok, usage, state }` or `{ ok: false, error, state }`; `usage = { remaining, used?, limit? }` |
| `PUT /fetch` | `{ mode, serviceId? }` | `{ ok, state }` — pins `web.fetchProvider` |

`POST /services` and `PUT /services/:id` now accept `keys` (array of strings) and
`appendKeys` (array of strings) instead of `apiKey`/`apiKeys`/`appendApiKeys`.
`PUT` without either keeps the stored pool; `keys: []` clears it.

Mask rule (Host): key ≤ 8 chars → `••••••••`; else first 4 + `••••` + last 4.
The plain value is only ever returned by the `reveal` endpoint.

Pin rules for fetch:

- `official` → write `fetchProvider` back to the value DSH had when the plugin loaded
  (captured at startup, `""` when unset).
- `follow` → the selected search entry's provider id when that service has a fetch
  adapter, otherwise no write (official).
- `service` → `better-search/<serviceId>` when it has a fetch adapter, else 400
  `FETCH_UNSUPPORTED`.
- `registry.restore()` restores **both** `searchProvider` and `fetchProvider`.

## Fetch adapters — `lib/search/fetch.js`

```js
/** @type {Record<string, (ctx: FetchContext) => Promise<FetchOutcome>>} */
export const FETCH_ADAPTERS = { tavily, exa, … };

/**
 * @typedef {object} FetchContext
 * @property {string} url
 * @property {object} service        // stored service; `service.apiKey` is the rotated key
 * @property {object} descriptor
 * @property {AbortSignal} [signal]
 * @property {number} timeoutMs
 *
 * @typedef {object} FetchOutcome
 * @property {number} statusCode
 * @property {string} content        // markdown / plain text of the page
 * @property {string} [title]
 * @property {string} [finalUrl]
 */
```

Port exactly the 13 fetch-capable types documented in
`docs/reference/kelivo-providers.md` (the `Fetch:` line of each §2.x section):
`tavily`, `exa`, `linkup`, `metaso`, `ollama`, `deepseek`, `jina`, `querit`,
`firecrawl`, `tinyfish`, `anysearch`, `parallel`, `you`. (`exa_mcp` needs MCP transport
and stays out.)

- Reuse `lib/search/http.js`; same timeout/error rules as search adapters.
- Extract a title from the content where the provider does not return one (first
  markdown `#` heading), and return `statusCode` from the HTTP response.
- Throw on transport/auth failure; a readable page with a 4xx is a result only if the
  provider returned parsed content.

## Usage adapters — `lib/search/usage.js`

```js
export const USAGE_ADAPTERS = { tavily, linkup };
// async usage(ctx: { service, descriptor, signal, timeoutMs }) → { remaining, used?, limit? }
```

- Tavily: `GET <search endpoint with /search → /usage>` + `Authorization: Bearer`,
  read `account.plan_usage/plan_limit`, else `key.usage/key.limit`; `remaining = max(0, limit - used)`.
- LinkUp: `GET https://api.linkup.so/v1/credits/balance` + Bearer, read `balance` →
  `{ remaining: balance }`.
- 10 s timeout, throw a short message on failure.

## Panel additions

1. **抓取方式 row** — its own SectionCard above the general options card, exactly like
   Kelivo's `_WebFetchModeRow` (`docs/reference/kelivo-ui-spec.md` §3.1): FileText 18 icon in
   the 36 px column, label 15 px, trailing select min-width 168 with the same menu
   treatment as the provider picker. Options:
   `跟随搜索服务` (follow) · `仅官方服务` (official) · each fetch-capable service
   (label = service name, subtitle = `使用该服务商的 API Key 和额度`). Show the effective
   target under the row when follow resolves to nothing fetch-capable
   (`当前搜索服务不支持网页抓取`), and `fetch.pin.error` inline when pinning failed.
2. **账户用量 section** in the edit dialog, for Tavily/LinkUp only, ported from
   `search_service_editor_page.dart` `_SearchServiceUsageCard`: Wallet icon in a 24 px
   circle, `账户用量` 15/600, refresh button (RefreshCw 18), states
   `尚未查询用量。` · `查询中…` · `剩余 {remaining} 额度` 17/600 + `已使用 {used} / {limit} 额度`
   12.5 + 7 px progress bar (Tavily), `余额 {balance}` for LinkUp,
   `用量查询失败：{message}`. Auto-query once when the dialog opens with a saved key.
3. **Multi-key dialog** — Kelivo's 440×520 `_MultiKeyManageDialog`
   (`docs/reference/kelivo-ui-spec.md` §4.3): masked list (KeyRound 15, primary badge `主`,
   Eye/EyeOff 28 px reveal via `POST …/keys/:keyId/reveal`, Trash2 28 px delete),
   batch textarea + `添加` + `已添加 {added} 个，跳过 {skipped} 个重复`, X closes and the
   list is already committed. Replaces the current inline multi-key panel.
4. **Fetch badge on cards**: fetch-capable services show a FileText 14 px glyph at 45 %
   opacity next to the name, like Kelivo.
5. All new copy bilingual (zh + en), zh from `docs/reference/kelivo-ui-spec.md` §6 and the
   Kelivo arb file where it exists.

## Tests

- `test/fetch.test.mjs` + `test/adapters.test.mjs` — fake fetch, mapping and error paths.
- `test/client-smoke.mjs` — fetch row, usage strings, endpoint references, CSS parity.
- `test/host.test.mjs` — keys CRUD/reveal/mask, usage route, fetch mode pinning, migration
  from a v1 store, and unload restore of both pins.

---

# v3 — reconciling DSH's own settings page

DSH's built-in **网页搜索** settings page edits the same `web` row this plugin pins:
its switch stages `searchProvider` + `fetchProvider` together (`deepseek-search-api` /
`deepseek-fetch-api` when on, `deepseek-official` / `http` when off). v3 makes the two
UIs cooperate instead of fighting.

## State additions

```jsonc
{
  "drift": {
    "search": null | { "actual": "…", "expected": "…", "kind": "builtin|service|stale-ours|foreign|unset", "…": "…" },
    "fetch":  null | { "actual": "…", "expected": "…", "kind": "…" }
  },
  "notice": null | { "code": "search-external|search-healed|fetch-external|fetch-healed|search-foreign", "name"?: "…", "nameEn"?: "…", "providerId"?: "…" }
}
```

`drift` is computed on read and never writes. `notice` is the outcome of the last
`POST /reconcile`, and is cleared by the next `POST /select` or `PUT /fetch`.

## `POST /reconcile`

Adopts external changes, then returns the full state:

| Actual pinned value | Action |
|---|---|
| a service of this plugin | store `selectedId` ← that service; no write |
| a shipped DeepSeek provider | store `selectedId` ← `builtin:<id>`; no write; notice `search-external` |
| `better-search/<missing>` | write `deepseek-search-api`; `selectedId` ← builtin; notice `search-healed` |
| unset | write `deepseek-search-api`; notice `search-healed` |
| another plugin's provider | store `selectedId` ← `""`; never write; notice `search-foreign` |

Fetch follows the same idea: adopt a service pin as `mode: "service"`, adopt the
baseline provider as `mode: "official"`, heal a missing one back to the baseline.

Boot order is now `sync → reconcile → applyPin → applyFetchPin`, so a change made while
the plugin was disabled survives a restart. `applyPin`/`applyFetchPin` also heal a
stale `better-search/*` value when nothing maps, and the pre-plugin fetch provider is
captured sanitized (a stale `better-search/*` baseline becomes `deepseek-fetch-api`).

The panel detects `drift` on its poll and calls `/reconcile` once per distinct value,
then shows a localized notice.

## Cleanup CLI

`bin/better-search.mjs` (`dsh-better-search status|path|clean --yes`) removes the
store directory; `status` never prints credentials.
