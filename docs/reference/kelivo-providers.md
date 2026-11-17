# Kelivo web-search providers — complete matrix for a Go/JS port

Source of truth (read-only, snapshot 2026-11-17):
`/workspace/projects/github/ref/kelivo/`

Primary files inspected:

- `lib/core/services/search/search_service.dart` (base classes, all `*Options`, factory `SearchService.getService()`)
- `lib/core/services/search/providers/*.dart` (28 provider implementations)
- `lib/core/services/search/search_api_key_rotator.dart`
- `lib/core/services/search/web_fetch.dart`, `web_fetch_service.dart` (fetch capability)
- `lib/desktop/setting/search_services_pane.dart` (desktop add/edit dialogs = which fields are actually rendered)
- `lib/utils/brand_assets.dart`, `lib/utils/model_brand.dart` (icon asset resolution)
- `lib/l10n/app_en.arb`, `lib/l10n/app_zh_Hans.arb` (labels)
- `lib/core/database/business_settings_router.dart` (per-type persisted-field schema)
- `lib/core/providers/settings_provider.dart` (defaults, storage key, built-in Kelivo unlock)

There is **no `SearchServiceType` enum** in this revision. Persistence uses a `type` string and `SearchServiceOptions.fromJson()` / `SearchService.getService()` switch on the options class. **28 types** are supported (plus one legacy alias `step` → `stepfun`).

---

## 1. Shared contracts

### 1.1 Common settings (`SearchCommonOptions`)

| field | type | default | UI label (zh / en) | notes |
|---|---|---|---|---|
| `resultSize` | int | `10` | 最大结果数 / Max Results | Universal result count; each provider either sends it, clamps it, or caps client-side. |
| `timeout` | int (ms) | `30000` | 超时时间（秒） / Timeout (seconds) | Stored in ms; UI shows seconds. Passed to every `.timeout(...)`. |

Defaults live in `SettingsProvider`; storage key `search_services_v1` (JSON array of `Options.toJson()` maps). First-run default list is `[BingLocalOptions(id: 'default')]`; search is disabled by default (`searchEnabled = false`). `SearchServiceOptions.defaultOption = BingLocalOptions(id: 'default')`.

### 1.2 Result model

```text
SearchResult { String? answer; List<SearchResultItem> items }
SearchResultItem { String title; String url; String text; String? id; int? index }
```

Only `title`, `url`, `text` come from providers. `id` (6-char uuid) and `index` (1-based) are added later by `SearchToolService` (the LLM tool wrapper), not by the search adapters. The tool JSON is `{answer?, items:[{title,url,text,id,index}]}`; if `answer` is null it is omitted.

### 1.3 Options base (`SearchServiceOptions`)

| field | type | default | secret | notes |
|---|---|---|---|---|
| `id` | String | required | no | New services: `Uuid().v4().substring(0, 8)`. Built-in Kelivo: `'kelivo'`. Legacy default: `'default'`. |
| `apiKey` | String | per provider | **yes** | Only providers with key auth have it. |
| `extraApiKeys` | List<String> | `[]` | **yes** | JSON key `apiKeys` (only emitted when non-empty). Round-robin pool with the primary key. |
| `url` / `customUrl` / instance URL | String | per provider | no | Custom/base URL for self-hosted or gateway use. |

Persistence details:

- `toJson()['type']` is the persisted type id (see table).
- `apiKeys` is only written when `extraApiKeys.isNotEmpty`.
- `fromJson` re-applies defaults and normalizes enum-like fields (`BraveOptions.normalizeMode`, `ParallelOptions.normalizeMode`, `KimiOptions.normalizeMode`, `YouSearchOptions.normalizeContentMode`).
- Unknown `type` falls back to `BingLocalOptions(id: json['id'])`; `getService()` unknown options fall back to `BingSearchService`.
- `business_settings_router.dart` validates allowed JSON keys per type (useful as a schema for a port): all types allow `type`+`id`; key types allow `apiKey`+`apiKeys`; per-type extra keys listed in each section below.

### 1.4 Multi-key rotation

`SearchApiKeyRotator` (in memory, per `serviceId`):

- Pool = trimmed, de-duplicated `[primary, ...extraApiKeys]`.
- Empty pool → returns raw primary; single key → returns it without advancing; ≥2 keys → round-robin, cursor per service id.
- Batch paste parser splits on whitespace, `,`, `;`; trims and dedupes preserving order.
- Display mask: first 4 + `••••` + last 4 (or `••••••••` if ≤8 chars).
- Applies to every key-based provider (all use `effectiveApiKey(primary)` exactly once per request). Not applicable to `bing_local`, `duckduckgo`, `searxng`, `kelivo`.

### 1.5 How options are rendered in the UI (desktop)

The desktop pane has two different forms:

- **Add dialog** (`_AddServiceDialog`): type dropdown + a *subset* of fields (mainly apiKey/url/engines/language/username/password/region + mode dropdowns). Multi-key tile is not shown.
- **Edit dialog** (`_EditServiceDialog`): renders all *editable* fields plus a "多 Key 轮询 / Multi-key rotation" tile for every key-based provider.
- The add dialog's type list has **27 entries and does NOT include `kelivo`** (both desktop and mobile). Bing Local is offered but has no fields.
- Some `Options` fields are **never rendered anywhere** and can only enter via imported/persisted JSON; they are preserved on edit. They are explicitly marked *preset-only* below.
- `id` is never user-editable.
- Secret fields are plain text inputs (`apiKey`, `password`); only SearXNG password uses `obscureText`.

### 1.6 Brand icons

The pane maps options class → brand key (`_BrandBadge._nameForService`), then `BrandAssets.assetForName(brandKey)` resolves (first `ModelBrand`, then the regex table) to `assets/icons/<file>`:

| brand key | asset |
|---|---|
| bing | `assets/icons/bing-color.svg` |
| duckduckgo | `assets/icons/duckduckgo-color.svg` |
| tavily | `assets/icons/tavily-color.svg` |
| exa (used by Exa **and** Exa MCP) | `assets/icons/exa-color.svg` |
| zhipu | `assets/icons/zhipu-color.svg` |
| searxng | `assets/icons/searxng-color.svg` |
| linkup | `assets/icons/linkup.svg` |
| brave | `assets/icons/brave-color.svg` |
| metaso | `assets/icons/metaso-color.svg` |
| ollama | `assets/icons/ollama.svg` |
| deepseek | `assets/icons/deepseek-color.svg` |
| jina | `assets/icons/jina-color.svg` |
| perplexity | `assets/icons/perplexity-color.svg` |
| bocha | `assets/icons/bocha-color.svg` |
| doubao | `assets/icons/doubao-color.svg` |
| kagi | `assets/icons/kagi-color.svg` |
| serper | `assets/icons/serper.svg` |
| querit | `assets/icons/querit-color.svg` |
| grok | `assets/icons/grok.svg` |
| stepfun | `assets/icons/stepfun.svg` |
| firecrawl | `assets/icons/firecrawl-color.svg` |
| tinyfish | `assets/icons/tinyfish-color.svg` |
| anysearch | `assets/icons/anysearch.svg` |
| parallel | `assets/icons/parallel.svg` |
| kimi | `assets/icons/kimi-color.svg` |
| you | `assets/icons/you.svg` |
| kelivo | `assets/icons/kelivo.png` |
| fallback | first letter in a circle |

### 1.7 Web-fetch capability (for the UI row to exclude)

`WebFetchService.supports(options)` returns true iff the service class `implements WebFetchCapable`. These **14** are fetch-capable:

`tavily`, `exa`, `exa_mcp`, `linkup`, `metaso`, `ollama`, `deepseek`, `jina`, `querit`, `firecrawl`, `tinyfish`, `anysearch`, `parallel`, `you`.

Not fetch-capable (14): `bing_local`, `duckduckgo`, `zhipu`, `searxng`, `brave`, `bocha`, `perplexity`, `serper`, `grok`, `stepfun`, `kagi`, `doubao`, `kelivo`, `kimi`.

The desktop list shows a "支持网页抓取 / Can read web pages" icon for the capable ones; the port does not implement fetch, so this row/picker should be omitted or filtered.

---

## 2. Provider-by-provider matrix

Legend: **zh label** = Simplified-Chinese label in the desktop add/edit dialog; “—” = no config form. “(hint only: …)” = the field has no label in the UI, only a hard-coded English placeholder (the desktop pane does not localize those hints). `API Key` itself is not translated in the Chinese UI either. “count” = how the common `resultSize` is used. “fetch” = `WebFetchCapable` implementation exists.

---

### 2.1 `bing_local` — `BingLocalOptions` → `BingSearchService`

- l10n name: `searchServiceNameBingLocal` → **Bing (Local)** / **Bing（Local）**; service `name` getter `Bing (Local)`; brand `bing`.
- Config fields: **none** (only base `id`). Add dialog shows no fields; edit dialog says "Bing 本地搜索不需要配置。" / "No configuration required for Bing Local search."
- No API key, no multi-key; status capsule hidden for Bing Local in the list UI.

Wire:

- `GET https://www.bing.com/search?q=<query>&adlt=moderate&setlang=<lang>[&cc=<country>]`
- Locale comes from factory parameter (`getService(options, locale: settings.effectiveLocale)`), defaulting to `PlatformDispatcher.instance.locale`:
  - `setlang = languageCode`; **zh-HK is forced to `en`**.
  - `cc = countryCode.toLowerCase()` only if it is exactly 2 letters and **not** `us`, `cn`, `ru`; otherwise omitted.
- Headers: desktop Chrome 133 UA, `Accept: text/html…`, `Accept-Language: <lang>[,<langTag>;q=0.7][,en;q=0.3]`, `Upgrade-Insecure-Requests: 1`, `Sec-Fetch-Dest/Mode/Site/User`.
- Scrape: `ol#b_results > li.b_algo`; title from `h2 > a` (whitespace collapsed); URL from that `href` resolved against `https://www.bing.com`; Bing redirect links `/ck/a?u=a1<base64url>` are decoded; non-http(s)/empty URLs rejected; duplicate URLs skipped; snippet = all `<p>` texts joined by space (decorative `span.algoSlug_icon` removed) or `.b_algoSlug` text; stop at `resultSize`.
- Errors: non-200 throws; empty result set with no `.b_no` marker throws `FormatException('Bing returned an unrecognized search page. Please retry later.')`.
- Answer: no. Pagination: no. Fetch: **no**.

---

### 2.2 `duckduckgo` — `DuckDuckGoOptions` → `DuckDuckGoSearchService`

- l10n: **DuckDuckGo** / **DuckDuckGo**; service name `DuckDuckGo`; brand `duckduckgo`.

| field | type | default | secret | zh UI label | notes |
|---|---|---|---|---|---|
| `region` | String | `'us-en'` | no | 地区（可选，默认 us-en） | DDG `kl` region, e.g. `us-en`, `cn-zh`, `wt-wt`. Empty falls back to `us-en`. Persisted key `region`. |

Wire:

- `GET https://duckduckgo.com/html/?q=<query>&kl=<region>`; UA Chrome 124 (Windows).
- Scrape: `.result` (cap at `resultSize`); title `.result__a`; URL from `.result__a[href]` else `.result__url` text; protocol-relative → `https:`; DuckDuckGo redirect `uddg` query param is unwrapped; snippet `.result__snippet`; all-empty rows skipped.
- Answer: no. Pagination: no. Fetch: **no**. No key, no rotation, no multi-key tile.

---

### 2.3 `tavily` — `TavilyOptions` → `TavilySearchService`

- l10n: **Tavily** / **Tavily**; service name `Tavily`; brand `tavily`. **Fetch-capable.**
- Default endpoint: `https://api.tavily.com/search`; custom `url` overrides it.

| field | type | default | secret | zh UI label | notes |
|---|---|---|---|---|---|
| `apiKey` | String | required | **yes** | API Key | Bearer token (Tavily API key). |
| `url` | String | `''` (→ default) | no | 自定义 URL（可选） | Must end with `/search` when fetch is used (sibling endpoint replacement). |
| `extraApiKeys` | List | `[]` | yes | 多 Key 轮询 (edit dialog tile) | Rotation supported. |

Wire:

- `POST <resolvedUrl>`; `Authorization: Bearer <key>`, `Content-Type: application/json`.
- Body: `{ "query": <q>, "max_results": resultSize }` (no `search_depth`, no `include_answer`, no topic/date filters).
- Parse: `results[]` → item `{title, url, text: content}`. Optional `answer` is read if the gateway returns it (client never requests `include_answer`, so normally absent).
- Count: server-side via `max_results`; no client cap. Answer: **yes** (`data.answer`). Pagination: no.
- Fetch: `POST <resolvedUrl with /search→/extract>`; body `{urls: url, format: "markdown"}` — `urls` is sent as a **bare string**, not an array; reads `results[0].raw_content`, title = first Markdown `#` heading; on empty, surfaces `failed_results[0].error`.
- Usage endpoint (outside port scope): `…/usage`, `GET` with Bearer; reads `account.plan_usage/plan_limit` or `key.usage/key.limit`.

---

### 2.4 `exa` — `ExaOptions` → `ExaSearchService`

- l10n: **Exa** / **Exa**; service name `Exa`; brand `exa`. **Fetch-capable.**
- Default endpoint: `https://api.exa.ai/search`; custom `url` overrides.

| field | type | default | secret | zh UI label | notes |
|---|---|---|---|---|---|
| `apiKey` | String | required | **yes** | API Key | `Authorization: Bearer`. |
| `url` | String | `''` (→ default) | no | 自定义 URL（可选） | Must end `/search` for fetch sibling. |
| `extraApiKeys` | List | `[]` | yes | 多 Key 轮询 | Rotation supported. |

Wire:

- `POST <resolvedUrl>`; `Authorization: Bearer`, `Content-Type: application/json`.
- Body: `{ "query": <q>, "numResults": resultSize, "contents": { "text": true } }`.
- Parse: `results[]` → `{title, url, text: item.text}`. No answer. Count: server `numResults`, no client cap.
- Fetch: `POST /contents` (sibling `search`→`contents`); body `{urls:[url], text:{maxCharacters:100000}}`; reads `results[0].text`; checks `statuses[0].status == 'error'`.
- No multi-key? Yes, supported via base `extraApiKeys`.

---

### 2.5 `exa_mcp` — `ExaMcpOptions` → `ExaMcpSearchService`

- l10n: **Exa MCP** / **Exa MCP**; service name `Exa MCP`; brand `exa`. **Fetch-capable.**
- Default endpoint: `https://mcp.exa.ai/mcp`; custom `url` overrides.

| field | type | default | secret | zh UI label | notes |
|---|---|---|---|---|---|
| `apiKey` | String | `''` (optional) | **yes** | API Key（可选） | Sent as `x-api-key`; empty ⇒ hosted free tier. |
| `url` | String | `''` (→ default) | no | 自定义 URL（可选） | MCP Streamable HTTP base URL. |
| `extraApiKeys` | List | `[]` | yes | 多 Key 轮询 | Rotation supported (each MCP call picks next key). |

Wire — **not plain REST**, it is MCP over Streamable HTTP (JSON-RPC):

- Creates `mcp.StreamableHttpClientTransport` with base URL, optional header `x-api-key: <key>`, timeout = common timeout; connects an MCP client (`Kelivo`, 1.0.0) and calls a hosted Exa tool.
- Search tool: `web_search_exa`, args `{ "query": <q>, "numResults": max(1,resultSize) }`.
- Response is MCP text content blocks joined with `\n\n---\n\n`; parse text, not JSON:
  - Requires header blocks matching `Title: …\nURL: …\nPublished: …\nAuthor: …`, separated by `\n---\n`; body marker `Highlights:` or `Text:`.
  - Empty text or `No search results found.` ⇒ empty list; no header blocks ⇒ `StateError` carrying the raw text (quota errors often arrive as plain text).
  - URL must be http(s) with host; title empty/`N/A` → URL; take `limit` (max(1,resultSize)).
- Fetch: tool `web_fetch_exa`, args `{urls:[url], maxCharacters:100000}`; parses text shape `# Title\nURL: <url>\n<content>`.
- Answer: no. Pagination: no.
- Special: free quota without key; MCP transport ownership details matter only for the Flutter client.

---

### 2.6 `zhipu` — `ZhipuOptions` → `ZhipuSearchService`

- l10n: **Zhipu AI** / **智谱**; service name `Zhipu (智谱)`; brand `zhipu`. No fetch.

| field | type | default | secret | zh UI label | notes |
|---|---|---|---|---|---|
| `apiKey` | String | required | **yes** | API Key | Bearer. |
| `extraApiKeys` | List | `[]` | yes | 多 Key 轮询 | Rotation supported. |

Wire:

- `POST https://open.bigmodel.cn/api/paas/v4/web_search` (fixed host).
- Body: `{ "search_query": <q>, "search_engine": "search_std", "count": resultSize }`; engine is hard-coded, no search-engine choice exposed.
- Parse: top-level `search_result[]` → `{title, url: link, text: content}`. No answer. Server count, no client cap. Pagination: no.

---

### 2.7 `searxng` — `SearXNGOptions` → `SearXNGSearchService`

- l10n: **SearXNG** / **SearXNG**; service name `SearXNG`; brand `searxng`. No fetch (even though it is self-hosted and keyless).

| field | type | default | secret | zh UI label | notes |
|---|---|---|---|---|---|
| `url` | String | required | no | 实例 URL / 实例 URL | Must be a reachable instance base URL; trailing `/` stripped. Persisted `url`. |
| `engines` | String | `''` | no | 搜索引擎（可选） | Comma-separated SearXNG engine names; URL-encoded into `engines=`. |
| `language` | String | `''` | no | (hint only: `en-US`) | URL-encoded into `language=`. |
| `username` | String | `''` | no | 用户名（可选） | Basic auth only when password is also non-empty. |
| `password` | String | `''` | **yes** | 密码（可选，obscured） | Basic auth only with username. |

Wire:

- `GET <base>/search?q=<enc>&format=json[&engines=<enc>][&language=<enc>]`.
- Optional `Authorization: Basic base64(user:pass)`.
- Parse: `results[]` → `{title, url, text: content}`, client-capped to `resultSize`. No answer. No count param.
- No API key, no rotation/multi-key. Validation: empty URL is an error.
- Fetch: **no** in Kelivo (SearXNG has no read-page API).

---

### 2.8 `linkup` — `LinkUpOptions` → `LinkUpSearchService`

- l10n: **LinkUp** / **LinkUp**; service name `LinkUp`; brand `linkup`. **Fetch-capable.**

| field | type | default | secret | zh UI label | notes |
|---|---|---|---|---|---|
| `apiKey` | String | required | **yes** | API Key | Bearer. |
| `extraApiKeys` | List | `[]` | yes | 多 Key 轮询 | Rotation supported. |

Wire:

- `POST https://api.linkup.so/v1/search` (fixed host).
- Body: `{ "q": <q>, "depth": "standard", "outputType": "sourcedAnswer", "includeImages": "false" }` — `includeImages` is sent as the **string** `"false"`.
- Parse: `sources[]` (cap `resultSize`) → `{title: name, url, text: snippet}`; `answer` read from `data.answer`. Answer: **yes**.
- Fetch: `POST https://api.linkup.so/v1/fetch`, body `{url}`; content `markdown`, title from first Markdown heading.
- No count parameter; client cap. Pagination: no.
- Usage endpoint (outside port): `GET https://api.linkup.so/v1/credits/balance`, Bearer, `balance`.

---

### 2.9 `brave` — `BraveOptions` → `BraveSearchService`

- l10n: **Brave Search** / **Brave**; service name `Brave Search`; brand `brave`. No fetch.

| field | type | default | secret | zh UI label | notes |
|---|---|---|---|---|---|
| `apiKey` | String | required | **yes** | API Key | Sent as `X-Subscription-Token` (not Bearer). |
| `mode` | String enum | `'web'` | no | 搜索模式 / Search mode | `web` (Web Search) or `llmContext` (LLM Context). Normalized on read. |
| `maximumNumberOfTokens` | int | `8192` | no | 最大 token 数 (only when `llmContext`) | Clamp 1024–32768; empty input defaults; invalid UI text shows 最大 token 数必须介于 1024 和 32768 之间。 |
| `extraApiKeys` | List | `[]` | yes | 多 Key 轮询 | Rotation supported. |

Wire — two modes:

- **web**: `GET https://api.search.brave.com/res/v1/web/search?q=<enc>&count=<resultSize>`; headers `Accept: application/json`, `X-Subscription-Token: <key>`; parse `web.results[]` → `{title, url, text: description}`.
- **llmContext**: `POST https://api.search.brave.com/res/v1/llm/context`; same auth; body `{ "q": <q>, "count": resultSize, "maximum_number_of_urls": resultSize, "maximum_number_of_tokens": option }`; parse `grounding.generic[]` (cap resultSize) → `{title, url, text: snippets[] joined with "\n\n"}`.
- No answer field set in either mode. Fetch: **no**.

---

### 2.10 `metaso` — `MetasoOptions` → `MetasoSearchService`

- l10n: **Metaso** / **秘塔**; service name `Metaso (秘塔)`; brand `metaso`. **Fetch-capable.**

| field | type | default | secret | zh UI label | notes |
|---|---|---|---|---|---|
| `apiKey` | String | required | **yes** | API Key | Bearer. |
| `extraApiKeys` | List | `[]` | yes | 多 Key 轮询 | Rotation supported. |

Wire:

- `POST https://metaso.cn/api/v1/search` (fixed host).
- Body: `{ "q": <q>, "scope": "webpage", "size": resultSize, "includeSummary": false }`; no answer/summary requested.
- Parse: `webpages[]` → `{title, url: link, text: snippet}`; no client cap beyond what API returns. No answer.
- Fetch: `POST https://metaso.cn/api/v1/reader`, Bearer + `Accept: text/plain`; body `{url}`; response body is Markdown text; title from first `#` heading.
- No pagination.

---

### 2.11 `ollama` — `OllamaOptions` → `OllamaSearchService`

- l10n: **Ollama** / **Ollama**; service name `Ollama`; brand `ollama`. **Fetch-capable.**
- This is Ollama's **hosted** `ollama.com` web search/fetch API, not a local Ollama server.

| field | type | default | secret | zh UI label | notes |
|---|---|---|---|---|---|
| `apiKey` | String | required | **yes** | API Key | Bearer. |
| `extraApiKeys` | List | `[]` | yes | 多 Key 轮询 | Rotation supported. |

Wire:

- `POST https://ollama.com/api/web_search` (fixed host).
- Body: `{ "query": <q>, "max_results": clamp(resultSize, 1, 10) }`.
- Parse: `results[]` → `{title, url, text: content}`. No answer. No pagination.
- Fetch: `POST https://ollama.com/api/web_fetch`, body `{url}`; reads `title` + `content`.

---

### 2.12 `deepseek` — `DeepSeekOptions` → `DeepSeekSearchService`

- l10n: **DeepSeek** / **DeepSeek**; service name `DeepSeek`; brand `deepseek`. **Fetch-capable.**

| field | type | default | secret | zh UI label | notes |
|---|---|---|---|---|---|
| `apiKey` | String | required | **yes** | API Key | Bearer (DeepSeek API key). |
| `extraApiKeys` | List | `[]` | yes | 多 Key 轮询 | Rotation supported. |

Wire:

- `POST https://api.deepseek.com/v1/tools/search` (fixed host).
- Body: `{ "query": <q>, "count": clamp(resultSize, 1, 50), "need_content": false }`.
- Parse: `results[]` → `{title, url, text}`; text = `summary` if non-empty else `snippet`; if `date` parses as a **UTC** timestamp, prefixes `text` with `[Published: YYYY-MM-DD] `.
- No answer. Fetch: `POST https://api.deepseek.com/v1/tools/fetch`, body `{url}`, reads `title` + `content`.

---

### 2.13 `jina` — `JinaOptions` → `JinaSearchService`

- l10n: **Jina** / **Jina**; service name `Jina`; brand `jina`. **Fetch-capable.**

| field | type | default | secret | zh UI label | notes |
|---|---|---|---|---|---|
| `apiKey` | String | required | **yes** | API Key | Bearer; `s.jina.ai` can run keyless on a free tier but the UI treats it as required. |
| `extraApiKeys` | List | `[]` | yes | 多 Key 轮询 | Rotation supported. |

Wire:

- `POST https://s.jina.ai/` (fixed host; note the bare `/`).
- Headers: `Authorization: Bearer`, `Accept: application/json`, `Content-Type: application/json`. Body: `{ "q": <q> }` (no count).
- Effective timeout = `max(common timeout, 15000 ms)`.
- Parse: `data[]` or (fallback) `results[]` → `{title, url, text: description}`, cap `resultSize`.
- No answer. Fetch: `POST https://r.jina.ai/` with body `{url}` and `X-Retain-Images: none`; response `data.{url,title,content}`; Bearer only if key non-empty.

---

### 2.14 `bocha` — `BochaOptions` → `BochaSearchService`

- l10n: **Bocha** / **博查**; service name `Bocha`; brand `bocha`. No fetch.

| field | type | default | secret | zh UI label | notes |
|---|---|---|---|---|---|
| `apiKey` | String | required | **yes** | API Key | Bearer. |
| `freshness` | String? | `null` | no | *preset-only* | e.g. `noLimit`, `week`, `month`; sent only when non-empty. |
| `summary` | bool | `true` | no | *preset-only* | Sent on every request as `summary`. |
| `include` | String? | `null` | no | *preset-only* | Domain include list, e.g. `qq.com` and `m.163.com` separated by a pipe character; omitted when empty. |
| `exclude` | String? | `null` | no | *preset-only* | Domain exclude list; omitted when empty. |
| `extraApiKeys` | List | `[]` | yes | 多 Key 轮询 | Rotation supported. |

Wire:

- `POST https://api.bochaai.com/v1/web-search` (fixed host).
- Body: `{query, freshness?, summary, count: resultSize, include?, exclude?}`.
- Parse: requires `code == 200`; path `data.webPages.value[]` → `{title: name, url, text: summary ?? snippet}`, cap `resultSize`.
- No answer. No pagination. The four additional quality fields (`freshness`, `summary`, `include`, `exclude`) can only arrive through imported/preset JSON (no UI).

---

### 2.15 `perplexity` — `PerplexityOptions` → `PerplexitySearchService`

- l10n: **Perplexity** / **Perplexity**; service name `Perplexity`; brand `perplexity`. No fetch.

| field | type | default | secret | zh UI label | notes |
|---|---|---|---|---|---|
| `apiKey` | String | required | **yes** | API Key | Bearer. |
| `country` | String? | `null` | no | *preset-only* | ISO 3166-1 alpha-2; sent as `country` when non-empty. |
| `searchDomainFilter` | List<String>? | `null` | no | *preset-only* | Sent as `search_domain_filter`. |
| `maxTokensPerPage` | int? | `null` (API default 1024) | no | *preset-only* | Sent as `max_tokens_per_page`. |
| `extraApiKeys` | List | `[]` | yes | 多 Key 轮询 | Rotation supported. |

Wire:

- `POST https://api.perplexity.ai/search` (fixed host).
- Body: `{ "query": <q>, "max_results": clamp(resultSize,1,20), country?, search_domain_filter?, max_tokens_per_page? }`.
- Parse: `results` may be a flat list **or** a list of lists (multi-query); flatten, cap `resultSize`, map `{title, url, text: snippet}`.
- No answer (this is the Search API, not Chat Completions). No pagination.

---

### 2.16 `serper` — `SerperOptions` → `SerperSearchService`

- l10n: **Serper** / **Serper**; service name `Serper`; brand `serper`. No fetch.

| field | type | default | secret | zh UI label | notes |
|---|---|---|---|---|---|
| `apiKey` | String | required | **yes** | API Key | Header `X-API-KEY`. |
| `gl` | String | `''` | no | 国家/地区（可选） | Google country code, e.g. `us`. |
| `hl` | String | `''` | no | 语言（可选） | Google interface language, e.g. `en`. |
| `tbs` | String | `''` | no | 时间过滤（可选） | Google `tbs` filter string, e.g. `qdr:d`, `qdr:w`. |
| `page` | int | `1` | no | 页码（可选） | Only sent when `> 1`; invalid input normalizes to 1. The only provider with real pagination. |
| `extraApiKeys` | List | `[]` | yes | 多 Key 轮询 | Rotation supported. |

Wire:

- `POST https://google.serper.dev/search` (fixed host).
- Body: `{q, gl?, hl?, tbs?, page?}` — empty strings/`page==1` omitted.
- Parse: `organic[]` cap `resultSize` → `{title, url: link, text: snippet}`. No answer.

---

### 2.17 `grok` — `GrokOptions` → `GrokSearchService`

- l10n: **Grok** / **Grok**; service name `Grok`; brand `grok`. No fetch.

| field | type | default | secret | zh UI label | notes |
|---|---|---|---|---|---|
| `apiKey` | String | required (explicit empty check throws) | **yes** | API Key | Bearer. |
| `model` | String | `'grok-4.5'` | no | 模型 / Model | Hint `grok-4.5`; empty → default. |
| `reasoningEffort` | String | `'low'` if model is empty/default, else `''` | no | 思维链强度 / Reasoning Chain Strength | Hint `none / low / medium / high / xhigh`; only sent when non-empty as `reasoning.effort`. |
| `customUrl` | String | `'https://api.x.ai/v1/responses'` | no | 自定义 URL（可选） | Full Responses API URL; empty → default. |
| `systemPrompt` | String | built-in search-assistant prompt (see below) | no | 系统提示词 / System Prompt | Multi-line (3–5 lines in UI). |
| `extraApiKeys` | List | `[]` | yes | 多 Key 轮询 | Rotation supported. |

Default system prompt: “You are a helpful search assistant. Search the web to find accurate and up-to-date information for the user's query. Provide a comprehensive answer with citations.”

Wire:

- `POST <resolvedUrl>` (xAI Responses API).
- Body: `{ "model": model, "input": [ {role:"system",content:systemPrompt}, {role:"user",content:query} ], "tools": [{"type":"web_search"},{"type":"x_search"}], "store": false, "stream": false, "reasoning": {"effort": …}? }`.
- Parse:
  - `output[]` → first object with `type == "message"` and `role == "assistant"`; from its `content[]` take the first `type == "output_text"`; `answer = that.text`.
  - Items: first from top-level `citations` (strings or `{type:"url_citation",url,title}`), then if fewer than `resultSize`, from `output_text.annotations`; dedupe by URL, title falls back to URL, `text: ''`.
- Answer: **yes**. No count parameter; pagination: no.

---

### 2.18 `querit` — `QueritOptions` → `QueritSearchService`

- l10n: **Querit** / **Querit**; service name `Querit`; brand `querit`. **Fetch-capable.**

| field | type | default | secret | zh UI label | notes |
|---|---|---|---|---|---|
| `apiKey` | String | required (explicit empty check) | **yes** | API Key | Bearer. |
| `sitesInclude` | String | `''` | no | 包含站点（可选） | Split on newline/comma into `filters.sites.include[]`. |
| `sitesExclude` | String | `''` | no | 排除站点（可选） | Split into `filters.sites.exclude[]`. |
| `timeRange` | String | `''` | no | 时间范围（可选） | Sent as `filters.timeRange.date`; hint `d7`. |
| `countries` | String | `''` | no | 国家（可选） | Split into `filters.geo.countries.include[]`; hint `united states, japan`. |
| `languages` | String | `''` | no | 语言（可选） | Split into `filters.languages.include[]`; hint `english, japanese`. |
| `extraApiKeys` | List | `[]` | yes | 多 Key 轮询 | Rotation supported. |

Wire:

- `POST https://api.querit.ai/v1/search` (fixed host).
- Body: `{ "query": <q>, "count": resultSize, "filters": {...}? }`; filters omitted entirely when empty; list values split on `[\n,]`.
- Parse: `results.result[]` (nested map), cap `resultSize`; `{title (fallback url), url, text = snippet + extra snippets/sentence entries joined with "\n\n"}`; error check on `error_code`/`error_msg`.
- No answer. Fetch: `POST https://api.querit.ai/v1/contents`, Bearer, body `{urls:[url], format:"markdown", extrasMeta:true}`; content `results[0].content`, title `results[0].extrasMeta.title`.

---

### 2.19 `stepfun` — `StepFunOptions` → `StepFunSearchService`

- l10n: **StepFun** / **StepFun**; service name `StepFun`; brand `stepfun`. No fetch.
- Legacy alias: `SearchServiceOptions.fromJson` also accepts type string `step`.

| field | type | default | secret | zh UI label | notes |
|---|---|---|---|---|---|
| `apiKey` | String | required (explicit empty check) | **yes** | API Key | Bearer. |
| `url` | String | `''` (→ `https://api.stepfun.com/v1/search`) | no | 自定义 URL（可选） | Full search URL. |
| `category` | String | `''` | no | (hint only: `programming / research / gov / business`) | Sent as `category` when non-empty. |
| `extraApiKeys` | List | `[]` | yes | 多 Key 轮询 | Rotation supported. |

Wire:

- `POST <resolvedUrl>`; `Authorization: Bearer`, `Content-Type: application/json; charset=utf-8`.
- Body: `{ "query": <q>, "n": clamp(resultSize,1,20), "category"? }`.
- Parse: `results[]` cap `resultSize` → `{title, url, text: snippet ?? content}`. No answer.

---

### 2.20 `firecrawl` — `FirecrawlOptions` → `FirecrawlSearchService`

- l10n: **Firecrawl** / **Firecrawl**; service name `Firecrawl`; brand `firecrawl`. **Fetch-capable.**
- Hosted `/v2/search` accepts **keyless** requests; Bearer only raises rate limits.

| field | type | default | secret | zh UI label | notes |
|---|---|---|---|---|---|
| `apiKey` | String | `''` (optional) | **yes** | API Key | Bearer sent only when non-empty. |
| `url` | String | `''` (→ `https://api.firecrawl.dev/v2/search`) | no | 自定义 URL（可选） | Must end `/search` for fetch sibling. |
| `sources` | List<String> | `['web']` | no | *preset-only* | Converted to `[{type: value}]`. |
| `categories` | List<String> | `[]` | no | *preset-only* | Converted to `[{type: value}]`. |
| `country` | String | `''` | no | (hint only: `US`) | ISO country, e.g. `US`. |
| `location` | String | `''` | no | (hint only: `Location`) | Free-form location. |
| `extraApiKeys` | List | `[]` | yes | 多 Key 轮询 | Rotation supported. |

Wire:

- `POST <resolvedUrl>`; `Content-Type: application/json`; optional `Authorization: Bearer`.
- Body: `{query, limit: clamp(resultSize,1,100), sources?:[{type}], categories?:[{type}], country?, location?}`.
- Parse: `payload.data` if present else `payload`; append `data.web[]` then, if still under limit, `data.news[]`; item `{title, url, text: description ?? snippet ?? markdown}`; stop at `resultSize`.
- No answer. Fetch: `POST <sibling /scrape>`; body `{url, formats:["markdown"], onlyMainContent:true}`; reads `data.markdown`, `data.metadata.title/url` (title may be a list).

---

### 2.21 `tinyfish` — `TinyFishOptions` → `TinyFishSearchService`

- l10n: **TinyFish** / **TinyFish**; service name `TinyFish`; brand `tinyfish`. **Fetch-capable.**

| field | type | default | secret | zh UI label | notes |
|---|---|---|---|---|---|
| `apiKey` | String | required (explicit empty check) | **yes** | API Key | Header `X-API-Key`. |
| `url` | String | `''` (→ `https://api.search.tinyfish.ai`) | no | 自定义 URL（可选） | Full search URL; fetch derives endpoint from it. |
| `location` | String | `''` | no | (hint: `US`) | Query param `location`. |
| `language` | String | `''` | no | (hint: `en`) | Query param `language`. |
| `includeDomains` | String | `''` | no | (hint: `Include domains`) | Query param `include_domains`. |
| `excludeDomains` | String | `''` | no | (hint: `Exclude domains`) | Query param `exclude_domains`. |
| `extraApiKeys` | List | `[]` | yes | 多 Key 轮询 | Rotation supported. |

Wire:

- `GET <resolvedUrl>?query=…&location=…&language=…&include_domains=…&exclude_domains=…` (params replace any existing query).
- Auth: `X-API-Key: <key>`; no count parameter.
- Parse: `results[]` cap `resultSize` → `{title, url, text: snippet}`. No answer.
- Fetch: if search host is `api.search.tinyfish.ai`, swap host to `api.fetch.tinyfish.ai`; else sibling `/search`→`/fetch`; `POST` body `{urls:[url], format:"markdown"}`, header `X-API-Key`; reads `results[0].text/title/final_url` (non-string `text` is JSON-encoded).

---

### 2.22 `anysearch` — `AnySearchOptions` → `AnySearchSearchService`

- l10n: **AnySearch** / **AnySearch**; service name `AnySearch`; brand `anysearch`. **Fetch-capable.**
- Auth is optional; anonymous requests use a shared per-IP quota.

| field | type | default | secret | zh UI label | notes |
|---|---|---|---|---|---|
| `apiKey` | String | `''` (optional) | **yes** | API Key | Bearer only when non-empty. |
| `url` | String | `''` (→ `https://api.anysearch.com/v1/search`) | no | 自定义 URL（可选） | Must end `/search` for fetch sibling. |
| `extraApiKeys` | List | `[]` | yes | 多 Key 轮询 | Rotation supported. |

Wire:

- `POST <resolvedUrl>`; `Content-Type: application/json`; optional `Authorization: Bearer`.
- Body: `{ "query": <q>, "max_results": clamp(resultSize,1,20), "format": "json" }`.
- Parse: envelope `{code,message,request_id,data}`; error when `code != null && code != 0`; `data.results[]` → `{title, url, text: snippet if non-empty else content}`; maps all returned items (no extra client cap).
- No answer. Fetch: `POST <sibling /extract>`, body `{url}`, reads `data.{url,title,content}`; `code != 0` throws.

---

### 2.23 `kagi` — `KagiOptions` → `KagiSearchService`

- l10n: **Kagi** / **Kagi**; service name `Kagi`; brand `kagi`. No fetch.

| field | type | default | secret | zh UI label | notes |
|---|---|---|---|---|---|
| `apiKey` | String | required | **yes** | API Key | Bearer. |
| `extraApiKeys` | List | `[]` | yes | 多 Key 轮询 | Rotation supported. |

Wire:

- `POST https://kagi.com/api/v1/search` (fixed host).
- Headers: `Authorization: Bearer`, `Content-Type: application/json`, `Accept: application/json`.
- Body: `{ "query": <q>, "workflow": "search", "format": "json", "limit": clamp(resultSize,1,1024) }`.
- Parse: `data.search[]`; title/snippet HTML-entity-decoded (literal tags preserved via a fragment-parse trick); rows with empty title or URL skipped; no client cap (API limit applies).
- Error handling: non-200 or non-empty `error[]` → message joined from `error[].message/code`, suffix `(Kagi trace: <id>)` where trace comes from `x-kagi-trace` response header or `meta.trace`. No answer.

---

### 2.24 `doubao` — `DoubaoOptions` → `DoubaoSearchService`

- l10n: **Doubao** / **豆包**; service name `Doubao`; brand `doubao`. No fetch.

| field | type | default | secret | zh UI label | notes |
|---|---|---|---|---|---|
| `apiKey` | String | required (explicit empty check) | **yes** | API Key | Bearer. |
| `extraApiKeys` | List | `[]` | yes | 多 Key 轮询 | Rotation supported. |

Wire:

- `POST https://open.feedcoopapi.com/search_api/web_search` (fixed host; Volcengine/Doubao).
- Headers: `Authorization: Bearer`, `Content-Type: application/json; charset=utf-8`.
- Body is **PascalCase**: `{ "Query": <q>, "SearchType": "web", "Count": clamp(resultSize,1,50), "Filter": {"NeedUrl": true} }`.
- Parse: check `ResponseMetadata.Error` (throws `Message`/`Code`); `Result.WebResults[]` → skip rows with empty `Url`; `{title: Title, url: Url, text: Summary if non-empty else Content if non-empty else Snippet}`.
- No answer, no pagination.

---

### 2.25 `kelivo` — `KelivoOptions` → `KelivoSearchService`

- l10n: **Kelivo** / **Kelivo**; service name `Kelivo`; brand `kelivo` (`assets/icons/kelivo.png`). No fetch.
- **Built-in/hidden provider**: `KelivoOptions.builtInId = 'kelivo'`; unlocked from the About page (`unlockKelivoSearch()`), not offered in the add-provider list. Default list only contains Bing Local.

| field | type | default | secret | zh UI label | notes |
|---|---|---|---|---|---|
| `id` | String | `'kelivo'` | no | — | Only field persisted (`type:'kelivo',id:'kelivo'`). |

Wire:

- `GET https://search.psycheas.top/v1/search?q=<q>&count=<resultSize>[&language=<lang>]`.
- `Authorization: Bearer <built-in token>`; the token is embedded in the app XOR-obfuscated and is **not user configurable**. It uses a raw `http.Client` (deliberately bypassing the logged Dio client so the token never hits request logs).
- `language` from app locale: `language-country` if both present; `zh`→`zh-CN`, `en`→`en-US`, else language code.
- Parse: `results[]` → `{title, url, text: content}`. No answer. No pagination.
- For a DSH port: omit or keep behind a “built-in” service; there is no key field and no fetch.

---

### 2.26 `parallel` — `ParallelOptions` → `ParallelSearchService`

- l10n: **Parallel** / **Parallel**; service name `Parallel`; brand `parallel`. **Fetch-capable.**

| field | type | default | secret | zh UI label | notes |
|---|---|---|---|---|---|
| `apiKey` | String | required | **yes** | API Key | Header `x-api-key` (lowercase). |
| `mode` | String enum | `'advanced'` | no | 搜索模式 / Search mode | One of `advanced`, `basic`, `fast`, `turbo` (labels are English in both locales: Advanced/Basic/Fast/Turbo). |
| `extraApiKeys` | List | `[]` | yes | 多 Key 轮询 | Rotation supported. |

Wire:

- `POST https://api.parallel.ai/v1/search` (fixed host).
- Body: `{ "objective": <q>, "search_queries": [<q>], "mode": <mode> }`.
- Parse: `results[]` cap `resultSize` → `{title, url, text: excerpts[] joined "\n\n"}`. No answer, no count parameter.
- Fetch: `POST https://api.parallel.ai/v1/extract`, header `x-api-key`, body `{urls:[url], advanced_settings:{full_content:true}}`; reads `results[0].full_content`; on empty, `errors[0].error_type/http_status_code`.

---

### 2.27 `kimi` — `KimiOptions` → `KimiSearchService`

- l10n: **Kimi** / **Kimi**; service name `Kimi`; brand `kimi`. No fetch.

| field | type | default | secret | zh UI label | notes |
|---|---|---|---|---|---|
| `apiKey` | String | required | **yes** | API Key | Bearer. |
| `mode` | String enum | `'pro'` | no | 搜索模式 / Search mode | `pro` → `/v1/tools/search_pro`; `basic` → `/v1/tools/search`. Labels Pro/Basic (untranslated). |
| `extraApiKeys` | List | `[]` | yes | 多 Key 轮询 | Rotation supported. |

Wire:

- `POST https://api.moonshot.cn/v1/tools/{search|search_pro}` (fixed base).
- Body: `{ "text_query": <q>, "limit": clamp(resultSize,1,20), "timeout_seconds": clamp(ceil(commonTimeoutMs/1000),1,60) }`.
- Parse: `search_results[]` cap limit → `{title, url, text: chunks[].text joined "\n\n" if non-empty else snippet}`.
- Error: includes `x-msh-track-id` header in the message when present. No answer.

---

### 2.28 `you` — `YouSearchOptions` → `YouSearchService`

- l10n: **You.com** / **You.com**; service name `You.com`; brand `you`. **Fetch-capable.**

| field | type | default | secret | zh UI label | notes |
|---|---|---|---|---|---|
| `apiKey` | String | required | **yes** | API Key | Header `X-API-Key`. |
| `contentMode` | String enum | `'highlights'` | no | 内容模式 / Content mode | `highlights` or `snippets`. |
| `extraApiKeys` | List | `[]` | yes | 多 Key 轮询 | Rotation supported. |

Wire:

- `POST https://ydc-index.io/v1/search` (fixed host).
- Headers: `X-API-Key`, `Content-Type: application/json`.
- Body: `{ "query": <q>, "count": resultSize, "extraction": {"extraction_mode":"highlights"} }` — extraction only in `highlights` mode; omitted in `snippets` mode.
- Parse: `results.web[] + results.news[]` merged in that order, cap `resultSize`; text selection order: `contents.highlights[]` joined `\n\n` → `snippets[]` joined `\n\n` → `description`.
- No answer. Fetch: `POST https://ydc-index.io/v1/contents`, header `X-API-Key`, body `{urls:[url], formats:["markdown"]}`; response is a **list**; reads first `{url,title,markdown}`.

---

## 3. Summary table

| type | Options class | Display name (en / zh) | Auth | Needs key | Fetch-capable | Endpoint host(s) |
|---|---|---|---|---|---|---|
| `bing_local` | BingLocalOptions | Bing (Local) / Bing（Local） | browser UA, no auth | none | no | www.bing.com |
| `duckduckgo` | DuckDuckGoOptions | DuckDuckGo / DuckDuckGo | browser UA, no auth | none | no | duckduckgo.com |
| `tavily` | TavilyOptions | Tavily / Tavily | Bearer | required | **yes** | api.tavily.com |
| `exa` | ExaOptions | Exa / Exa | Bearer | required | **yes** | api.exa.ai |
| `exa_mcp` | ExaMcpOptions | Exa MCP / Exa MCP | `x-api-key` (optional) | optional | **yes** | mcp.exa.ai |
| `zhipu` | ZhipuOptions | Zhipu AI / 智谱 | Bearer | required | no | open.bigmodel.cn |
| `searxng` | SearXNGOptions | SearXNG / SearXNG | optional Basic | none (URL required) | no | self-hosted `<base>/search` |
| `linkup` | LinkUpOptions | LinkUp / LinkUp | Bearer | required | **yes** | api.linkup.so |
| `brave` | BraveOptions | Brave Search / Brave | `X-Subscription-Token` | required | no | api.search.brave.com |
| `metaso` | MetasoOptions | Metaso / 秘塔 | Bearer | required | **yes** | metaso.cn |
| `ollama` | OllamaOptions | Ollama / Ollama | Bearer | required | **yes** | ollama.com |
| `deepseek` | DeepSeekOptions | DeepSeek / DeepSeek | Bearer | required | **yes** | api.deepseek.com |
| `jina` | JinaOptions | Jina / Jina | Bearer | required (UI) | **yes** | s.jina.ai (+ r.jina.ai) |
| `bocha` | BochaOptions | Bocha / 博查 | Bearer | required | no | api.bochaai.com |
| `perplexity` | PerplexityOptions | Perplexity / Perplexity | Bearer | required | no | api.perplexity.ai |
| `serper` | SerperOptions | Serper / Serper | `X-API-KEY` | required | no | google.serper.dev |
| `grok` | GrokOptions | Grok / Grok | Bearer | required | no | api.x.ai |
| `querit` | QueritOptions | Querit / Querit | Bearer | required | **yes** | api.querit.ai |
| `stepfun` (`step` alias) | StepFunOptions | StepFun / StepFun | Bearer | required | no | api.stepfun.com |
| `firecrawl` | FirecrawlOptions | Firecrawl / Firecrawl | optional Bearer | optional | **yes** | api.firecrawl.dev |
| `tinyfish` | TinyFishOptions | TinyFish / TinyFish | `X-API-Key` | required | **yes** | api.search.tinyfish.ai (+ api.fetch.tinyfish.ai) |
| `anysearch` | AnySearchOptions | AnySearch / AnySearch | optional Bearer | optional | **yes** | api.anysearch.com |
| `kagi` | KagiOptions | Kagi / Kagi | Bearer | required | no | kagi.com |
| `doubao` | DoubaoOptions | Doubao / 豆包 | Bearer | required | no | open.feedcoopapi.com |
| `kelivo` | KelivoOptions | Kelivo / Kelivo | built-in Bearer token | built-in | no | search.psycheas.top |
| `parallel` | ParallelOptions | Parallel / Parallel | `x-api-key` | required | **yes** | api.parallel.ai |
| `kimi` | KimiOptions | Kimi / Kimi | Bearer | required | no | api.moonshot.cn |
| `you` | YouSearchOptions | You.com / You.com | `X-API-Key` | required | **yes** | ydc-index.io |

Counts: 28 types, 14 fetch-capable, 21 requiring a key, 3 optional-key, 3 keyless + 1 built-in token.

### 3.1 Quality knobs at a glance

| knob | provider(s) | field / value | UI or preset-only |
|---|---|---|---|
| Time / freshness | Bocha | `freshness` e.g. `noLimit`, `week`, `month` | preset-only |
| | Serper | `tbs` Google filter string, e.g. `qdr:d` | UI (时间过滤) |
| | Querit | `timeRange` → `filters.timeRange.date`, e.g. `d7` | UI (时间范围) |
| Include / exclude domains | Bocha | `include` / `exclude`, pipe-separated string | preset-only |
| | Querit | `sitesInclude` / `sitesExclude` (newline or comma) | UI |
| | TinyFish | `includeDomains` / `excludeDomains` (query params) | UI |
| | Perplexity | `searchDomainFilter` (list) | preset-only |
| Region / country | DuckDuckGo | `region` (`kl`, default `us-en`) | UI |
| | Serper | `gl` | UI |
| | Querit | `countries` → `filters.geo.countries.include` | UI |
| | Firecrawl | `country` (e.g. `US`), `location` | UI |
| | TinyFish | `location` query param | UI |
| | Perplexity | `country` (ISO alpha-2) | preset-only |
| Language | SearXNG | `language` query param | UI |
| | Serper | `hl` | UI |
| | Querit | `languages` → `filters.languages.include` | UI |
| | TinyFish | `language` query param | UI |
| | Bing Local / Kelivo | derived from app locale automatically | automatic |
| Model / engine / mode | Grok | `model`, `reasoningEffort`, `systemPrompt` | UI |
| | Brave | `mode` = `web` or `llmContext` | UI |
| | Parallel | `mode` = `advanced`, `basic`, `fast`, or `turbo` | UI |
| | Kimi | `mode` = `pro` or `basic` (maps to `search_pro`/`search`) | UI |
| | You | `contentMode` = `highlights` or `snippets` | UI |
| | SearXNG | `engines` (engine selection) | UI |
| | Zhipu | `search_engine` hard-coded to `search_std` | fixed |
| Max tokens | Brave | `maximumNumberOfTokens` 1024–32768 (llmContext only) | UI |
| | Perplexity | `maxTokensPerPage` (preset; API default 1024) | preset-only |
| Other fixed choices | Tavily | no `search_depth`/topic/date sent | fixed |
| | Metaso | `scope: "webpage"`, `includeSummary: false` | fixed |
| | Doubao | `SearchType: "web"`, `Filter.NeedUrl: true` | fixed |
| | Grok | tools `web_search` + `x_search`, `store:false`, `stream:false` | fixed |
| | LinkUp | `depth:"standard"`, `outputType:"sourcedAnswer"` | fixed |

---

## 4. Fetch-capable providers (exclude from any fetch UI row)

| type | fetch request | page content path |
|---|---|---|
| `tavily` | `POST <base>/extract` `{urls:<url> (bare string, not array), format:"markdown"}` | `results[0].raw_content` (title = first `#` heading) |
| `exa` | `POST <base>/contents` `{urls:[url], text:{maxCharacters:100000}}` | `results[0].text`, `statuses[0]` error check |
| `exa_mcp` | MCP tool `web_fetch_exa` `{urls:[url], maxCharacters:100000}` | parsed text `# Title\nURL: …\n<body>` |
| `linkup` | `POST https://api.linkup.so/v1/fetch` `{url}` | `markdown` |
| `metaso` | `POST https://metaso.cn/api/v1/reader` `{url}` (`Accept: text/plain`) | raw Markdown body |
| `ollama` | `POST https://ollama.com/api/web_fetch` `{url}` | `title`, `content` |
| `deepseek` | `POST https://api.deepseek.com/v1/tools/fetch` `{url}` | `title`, `content` |
| `jina` | `POST https://r.jina.ai/` `{url}` (`X-Retain-Images: none`) | `data.{url,title,content}` |
| `querit` | `POST https://api.querit.ai/v1/contents` `{urls:[url], format:"markdown", extrasMeta:true}` | `results[0].content`, `.extrasMeta.title` |
| `firecrawl` | `POST <base with /search→/scrape>` `{url, formats:["markdown"], onlyMainContent:true}` | `data.markdown`, `data.metadata.title/url` |
| `tinyfish` | `POST api.fetch.tinyfish.ai` or sibling `/fetch` `{urls:[url], format:"markdown"}` | `results[0].text/title/final_url` |
| `anysearch` | `POST <base with /search→/extract>` `{url}` | `data.{url,title,content}` |
| `parallel` | `POST https://api.parallel.ai/v1/extract` `{urls:[url], advanced_settings:{full_content:true}}` | `results[0].full_content` |
| `you` | `POST https://ydc-index.io/v1/contents` `{urls:[url], formats:["markdown"]}` | response list first `{url,title,markdown}` |

Fetch behaviour common to all: results are trimmed, empty content is an error, content is capped at **100,000 characters**, and a 10-minute/8-entry cache plus canonical-URL alias exists in `WebFetchService` (not needed in the DSH port). Providers with custom base URLs derive the fetch endpoint by replacing a trailing `/search` path segment (Tavily/Exa/Firecrawl/AnySearch, TinyFish has a host-swap special case); custom URLs that do not end in `/search` therefore fail fetch only — search still works.

---

## 5. Porting notes

### 5.1 One adapter can cover several providers

All providers are “query in → `{answer?, items[{title,url,text}]}` out”; the differences are auth header, endpoint, count field, and response path. Five request shapes cover everything:

1. **JSON POST with configurable item path** — one configurable adapter with `countField`, `itemPath`, `titleField`, `urlField`, `textField(s)`, `takeMode` covers:
   - `tavily` (`max_results`, `content`)
   - `exa` (`numResults`, nested `contents` request, `text`)
   - `ollama` (`max_results`, clamp 1–10, `content`)
   - `deepseek` (`count`, clamp 1–50, `summary` + date-prefix post-processing)
   - `anysearch` (optional auth, `max_results`, envelope `data.results`)
   - `jina` (body `{q}`, no count, `data`/`results`, `description`, min 15 s timeout)
   - `kimi` (`text_query`, `search_results`, `chunks[].text`)
   - `kagi` (`limit`, `data.search`, HTML-entity decode, error envelope + trace)
   - `firecrawl` (optional auth, `limit`, envelope `data.web`/`data.news`, 3 fallback text fields)
   - `parallel` (`x-api-key`, no count, `objective`/`search_queries`, `excerpts[]`)
   - `perplexity` (`max_results`, flat-or-nested `results[]`, `snippet`)

2. **Custom auth header + flat results** — same adapter, header name/prefix configurable:
   - `serper` (`X-API-KEY`, `organic[]`, `link`)
   - `you` (`X-API-Key`, merged `results.web`+`news`, highlights/snippets)
   - `tinyfish` (`X-API-Key`, **GET** + query params)
   - `brave` (`X-Subscription-Token`; GET web or POST llm/context, two response shapes)
   - `exa_mcp` (`x-api-key`, but **MCP JSON-RPC**, not REST — needs an MCP client or a separate adapter)

3. **Chinese/Bearer JSON envelopes** (same auth, all nested and field names differ; one mapper table per provider suffices):
   - `zhipu` `search_result[].{title,link,content}`
   - `metaso` `webpages[].{title,link,snippet}`
   - `bocha` `code/data.webPages.value[].{name,url,summary|snippet}`
   - `doubao` PascalCase `Result.WebResults[].{Title,Url,Summary|Content|Snippet}`
   - `querit` `results.result[]` with filters builder
   - `stepfun` `results[].{title,url,snippet|content}`
   - `serper`, `you` etc. are already covered above; `kimi`/`perplexity` could go in either group.

4. **Answer-producing APIs** — result items are citations/sources rather than search hits:
   - `tavily` (`answer` if gateway supplies)
   - `linkup` (`sources` + `answer`)
   - `grok` (Responses API: `output_text` is the answer; `citations`/`annotations` are the items)
   These need the adapter to expose an optional `answer` field and a different item extraction path.

5. **HTML scrapers / special transports** — cannot share the JSON adapter:
   - `bing_local` (locale-sensitive HTML scrape, Bing `/ck/a` redirect decoding)
   - `duckduckgo` (HTML scrape, `uddg` unwrap, `kl` region)
   - `searxng` (self-hosted JSON, GET query params, optional Basic auth, no count param)
   - `exa_mcp` (MCP Streamable HTTP)
   - `kelivo` (hidden built-in, fixed embedded credential)

Recommended Go shape: a `Provider` interface `{ Search(ctx, query, common) (Result, error) }` plus a `Descriptor` table (type, label, icon, auth style, needsKey, fetchCapable, field schema) so the UI can be generated from the same table; the JSON/flat adapters then need only path/field config, and special providers get bespoke implementations.

### 5.2 Cross-cutting gotchas

- **`resultSize` semantics differ per provider.** *Server-side count field only* (no client slice): Tavily (`max_results`), Exa (`numResults`), Ollama (`max_results`, clamp 1–10), DeepSeek (`count`, clamp 1–50), Zhipu (`count`), Metaso (`size`), AnySearch (`max_results`, clamp 1–20), Kagi (`limit`, clamp 1–1024), Doubao (`Count`, clamp 1–50), Kelivo (`count`), Brave web mode (`count`). *Server count field plus client cap*: Bocha (`count`), Perplexity (`max_results`, clamp 1–20), Querit (`count`), StepFun (`n`, clamp 1–20), Firecrawl (`limit`, clamp 1–100), Kimi (`limit`, clamp 1–20), You (`count`), Brave llmContext mode (`count` + `maximum_number_of_urls`), Exa MCP (`numResults`, min 1). *No count field, client-side cap only*: SearXNG, LinkUp, Jina, Serper (page only), TinyFish, Parallel, Bing, DuckDuckGo, Grok (citation items capped). Apply the same clamps/slice order or result counts differ from Kelivo.
- **Only Serper has pagination** (`page`, only sent when > 1). Everything else is a single page.
- **Only Tavily, LinkUp and Grok can return `answer`.** Tavily only reads `data.answer`; it never sends `include_answer`, so in practice LinkUp and Grok are the real answer providers.
- **Empty-key behaviour is inconsistent.** Some providers throw locally on empty key (Grok, Querit, StepFun, TinyFish, Doubao); most send `Authorization: Bearer ` and let the API fail. Keyless are Bing, DuckDuckGo, SearXNG; optional keys are Exa MCP, Firecrawl, AnySearch; Kelivo uses an embedded token.
- **Auth header names differ**: Bearer (most), `X-API-KEY` (Serper), `x-api-key` (Parallel), `X-API-Key` (TinyFish, You), `X-Subscription-Token` (Brave), `x-api-key` (Exa MCP), optional Basic (SearXNG).
- **Locale-sensitive providers**: Bing Local (`setlang`/`cc`, zh-HK→en, omit cc for us/cn/ru) and Kelivo (`language` from app locale). All Chinese providers (Zhipu, Metaso, Bocha, Doubao) and the remaining vendors are not locale-parameterized.
- **Custom base URLs** (self-hosted/gateway): Tavily, Exa, Exa MCP, SearXNG, Grok, StepFun, Firecrawl, TinyFish, AnySearch. SearXNG *requires* a URL; the others default to the vendor host. Fetch sibling-endpoint derivation only matters if fetch is ever ported (it is out of scope).
- **Preset-only fields** (no UI in desktop or mobile; preserved on edit; only enter via persisted/imported JSON): `bocha.freshness`, `bocha.summary`, `bocha.include`, `bocha.exclude`; `perplexity.country`, `perplexity.searchDomainFilter`, `perplexity.maxTokensPerPage`; `firecrawl.sources`, `firecrawl.categories`. A port that reimplements only the visible forms can hard-code their defaults, but should keep them in the model for import compatibility.
- **Enum-like fields must be normalized on read**, not trusted: Brave `mode` (`web` default), Parallel `mode` (`advanced` default), Kimi `mode` (`pro` default), You `contentMode` (`highlights` default). Invalid values silently fall back.
- **Defaults that depend on other fields**: Grok `reasoningEffort` defaults to `'low'` only when the model is empty or exactly `grok-4.5`; if a custom model is supplied and no reasoning effort, the field is empty and no `reasoning` object is sent.
- **JSON persistence detail**: nullable strings are omitted rather than written as `null` for Bocha and Perplexity fields; `extraApiKeys` is written as `apiKeys` only when non-empty. A round-trip must reproduce the same keys for import/export compatibility.
- **Built-in/hidden provider**: `kelivo` is in the factory and storage, is **not** offered in the add-provider dropdown (desktop or mobile), and is unlocked from the About page. It has no user-configurable fields, no fetch, and an embedded obfuscated token; a port can safely drop it or mark it built-in.
- **The user-visible service name has two sources**: the l10n type label (`searchServiceName*`, used in the type picker/list) and the service class `name` getter (used in the edit-dialog title and status card). They differ for `zhipu` (en “Zhipu AI” / zh “智谱” vs service name `Zhipu (智谱)`) and `metaso` (en “Metaso” / zh “秘塔” vs service name `Metaso (秘塔)`); all other providers use the same text in both places.
- **Icons**: `exa` and `exa_mcp` share `exa-color.svg`; everything else has its own asset listed in §1.6. The type picker never uses `kelivo`.
- **Out of scope for the DSH port**: provider web fetch, per-provider usage queries (Tavily/LinkUp only), connection-test/auto-test UI, multi-key management UI (but the rotation algorithm itself is trivial and worth porting if multiple keys per provider are supported), and the 10-minute fetch cache.

### 5.3 Minimal per-provider type table for a port

If the port keeps a descriptor map, the following tuple is sufficient for all UI/selection logic:

```text
(typeId, labelEn, labelZh, iconAsset, authStyle, needsKey[, fetchCapable])
```

and a separate `search(ctx, query, common, optionsJson)` switch/closures per adapter family. Put `fetchCapable = false` for the 14 non-fetch providers so a fetch selector can exclude them; nothing else about fetch needs to be implemented.
