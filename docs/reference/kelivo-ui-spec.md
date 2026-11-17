# Kelivo · "Search services" settings surface — pixel/behaviour spec (desktop)

Purpose: enough numeric detail to re-implement the pane faithfully in React/HTML.
Source of truth (read-only): a local read-only checkout of the Kelivo repository.

All dimensions are logical px (Flutter logical pixels == CSS px at dpr 1). Opacities are given as
`color @ alpha` computed with `Color.withValues(alpha: a)` (straight alpha compositing).
"cs.X" = `Theme.of(context).colorScheme.X` (Material 3 role). "ac.X" = `context.appColors.X`
(`AppSemanticColors` theme extension).

---

## 0. Source map

| Concern | File | Lines |
|---|---|---|
| Desktop pane, cards, rows, dialogs | `lib/desktop/setting/search_services_pane.dart` | 1–3342 |
| Pane root + list + general options | same | 30–282 |
| `_ServiceCard` | same | 284–441 |
| `_WebFetchModeRow` | same | 443–493 |
| `_ToggleRow` | same | 495–532 |
| `_StepperRow` / `_StepperButton` | same | 534–669 |
| `_BrandBadge` / `_SmallIconBtn` / `_divider` | same | 671–813 |
| `_AddServiceDialog` | same | 849–1566 |
| `_EditServiceDialog` | same | 1568–2526 |
| `_MultiKeyManageDialog` | same | 2528–2761 |
| `_ServiceTypeChips` (dead code) / `_ServiceTypeDropdown` | same | 2763–3112 |
| `_DropdownItem` / `_DeskIosButton` / `_deskModeDropdown` / `_BraveMaximumTokensField` / `_deskInputDecoration` | same | 3114–3342 |
| `SectionCard` | `lib/shared/widgets/section_card.dart` | 1–95 |
| `IosSwitch` | `lib/shared/widgets/ios_switch.dart` | 1–206 |
| `IosFormTextField` (Kimi only) | `lib/shared/widgets/ios_form_text_field.dart` | 1–323 |
| `DesktopSelectDropdown` | `lib/desktop/widgets/desktop_select_dropdown.dart` | 1–692 |
| `AppFontWeights` | `lib/theme/app_font_weights.dart` | 1–29 |
| `AppSemanticColors` / `SurfaceLadder` | `lib/theme/app_semantic_colors.dart`, `lib/theme/surface_ladder.dart` | 229 / 135 |
| Hosting (sidebar + detail slot) | `lib/desktop/desktop_settings_page.dart` | 265–406, 409–609 |
| Web-fetch mode choices | `lib/features/search/widgets/web_fetch_mode.dart` | 1–94 |
| Mobile equivalent (different layout) | `lib/features/search/pages/search_services_page.dart` | — |

There is no mobile equivalent under `lib/features/settings/`; the mobile surface is
`lib/features/search/pages/*` (see §9).

---

## 1. Hosting, layout tree, spacing

### 1.1 Host

- Hosted at `desktop_settings_page.dart:346–349` inside the right-hand "detail" slot of
  `DesktopAdaptivePanes` (`sidebarWidth: 250`). The pane is a plain widget, **not** a `Scaffold`:
  it has no app bar, no back button, and its background is whatever the host `Material` paints
  (`Theme.scaffoldBackgroundColor`, i.e. the page surface `cs.surface`).
- Settings top bar (host, not pane): height **36**, text `设置` / `Settings` at **14px / w600 /
  cs.onSurface**, left padding **16**, top padding **8** (`desktop_settings_page.dart:271–288`).
- Sidebar: width **250**, padding `(12,12,12,12)`, search entry at top, then gap **16**; menu items
  height **40**, radius **14**, padding `h10`, icon **18**, gap **10**, label **14.5 / w400**,
  item gap **8**. Selected: bg `cs.primary @0.10`, fg `cs.primary`. Hover: bg
  `cs.onSurface @(dark 0.06 / light 0.04)`. Search-services entry icon = Lucide `Earth`, label
  `搜索服务` / `Search` (`settingsPageSearch`).

### 1.2 Pane tree (`search_services_pane.dart:42–258`)

```
Container(alignment: Alignment.topCenter)                  // centres ≤960 column in the detail slot
└─ Padding(16, 12, 16, 24)                                  // LTRB
   └─ ConstrainedBox(maxWidth: 960)
      └─ CustomScrollView(slivers)
         ├─ SliverToBoxAdapter → SizedBox(h = 36) → Row
         │    ├─ Expanded → Align(centerLeft) → Text(title)
         │    │     14px / w400 / cs.onSurface @0.90
         │    └─ _SmallIconBtn(Lucide.Plus)                // 28×28, r8, icon 18; NO tooltip on
         │                                                 // desktop (mobile has one)
         ├─ SliverToBoxAdapter → SizedBox(h = 8)
         ├─ SliverReorderableList(itemCount = services.length)
         │     each item: KeyedSubtree(key = "desktop-search-service-<id>")
         │       └─ Padding(bottom = 12)                   // inter-card gap
         │          └─ ReorderableDragStartListener(index) // whole card = drag handle
         │             └─ _ServiceCard
         ├─ SliverToBoxAdapter → SizedBox(h = 16)
         ├─ SliverToBoxAdapter → SectionCard(children: [_WebFetchModeRow()])
         ├─ SliverToBoxAdapter → Padding(12, 8, 12, 0) → Text(footer)
         │     12px / line-height 1.4 / cs.onSurface @0.55
         ├─ SliverToBoxAdapter → SizedBox(h = 16)
         └─ SliverToBoxAdapter → SectionCard(children: [
               _ToggleRow(HeartPulse, autoTestOnLaunch),
               _divider,
               _StepperRow(ListOrdered, maxResults, 1…50),
               _divider,
               _StepperRow(History, timeoutSeconds, 1…300),
             ])
```

Effective vertical rhythm:

| Between | Gap |
|---|---|
| title row → first card | 8 |
| card → card | 12 |
| last card → web-fetch `SectionCard` | 12 + 16 = **28** |
| web-fetch `SectionCard` → footer hint | 8 (footer's top padding) |
| footer hint → general `SectionCard` | 16 |
| pane content bottom → viewport | 24 |

- No scrollbar styling, no dividers between service cards, no empty state: if `services` is empty
  the reorderable list renders zero items (add dialog is the only escape hatch).
- Pane horizontal padding is **16**; on viewports ≥ 992 the 960 column is centred, leaving ≥16 on each
  side.

### 1.3 `SectionCard` (shared, standard variant — used twice here)

`section_card.dart:24–94`:

- container `color: ac.surfaceCard`, `border-radius: 12`, `border: 0.6px solid ac.hairline`,
  `clip: antiAlias`, **no shadow** (shadow only if the caller passes one; this pane never does).
- `padding: EdgeInsets.symmetric(vertical: 4)` for stacked children (as used here).
- children are a `Column(crossAxisAlignment: center)`; no `dividers` flag here (this pane inserts its
  own `_divider`), so the built-in divider rule (`height 10 / 0.6px / cs.outlineVariant @0.18`) does
  **not** apply.
- `SectionCardVariant.emphasized` (radius 18, `ac.hairlineStrong`) is **not** used in this pane.

---

## 2. Service card anatomy (`_ServiceCard`, lines 284–441)

### 2.1 Box

| Property | Value |
|---|---|
| fill | `ac.surfaceCard` (never changes on hover/selected) |
| radius | **18** |
| border width | **1.0** |
| border colour, default | `cs.outlineVariant @ (dark 0.12 / light 0.08)` |
| border colour, hover **or** selected | `cs.primary @ (dark 0.35 / light 0.45)` |
| padding | `EdgeInsets.all(14)` |
| `minHeight` | **64** |
| cursor | `pointer` over the whole card |
| hover transition | none (instant border swap, no animation, no elevation, no bg) |
| selected indicator | border colour only — no checkmark, no rail, no bg tint |

### 2.2 Horizontal row (left → right)

```
[ _BrandBadge 24×24 ]  gap10  [ Expanded: name (16/w700, 1 line, ellipsis)
                                          (+ gap6 + FileText 14 @0.45 w/ tooltip) ]
                                [ gap8 + status pill ]   (skipped for local-only services)
                                gap8 + _SmallIconBtn(Settings2)
                                gap6 + _SmallIconBtn(HeartPulse)
                                gap6 + _SmallIconBtn(Trash2)
```

Details:

- **Brand badge** — `_BrandBadge.forService(service, size: 24)`: circle (`BoxShape.circle`),
  fill `cs.primary @ (dark 0.18 / light 0.10)`, brand glyph at `size * 0.62 = 14.88` centred
  (SVG recoloured to `cs.onSurface` in dark mode only for assets flagged `assetNeedsDarkInvert`;
  raster assets untouched). Fallback when no asset: first letter uppercased, `cs.primary`,
  `w700`, `fontSize = size * 0.42 = 10.08`.
  Brand key by option type: bing, duckduckgo, tavily, exa (also `exa_mcp`), zhipu, searxng, linkup,
  brave, metaso, ollama, deepseek, jina, perplexity, bocha, doubao, kagi, serper, querit, grok,
  stepfun, firecrawl, tinyfish, anysearch, parallel, kimi, you, kelivo; anything else → `search`
  (no asset ⇒ initial fallback, i.e. a circled "S").
- **Name** — `fontSize 16`, `AppFontWeights.emphasis` (=w700; Android downgrades w600+ to w500 —
  keep w700 for web), colour = inherited default text style colour (effectively `cs.onSurface`),
  `maxLines: 1`, ellipsis, inside `Flexible` so it yields to the trailing controls.
- **Capability icon (fetch)** — only when `WebFetchService.supports(service)`:
  gap **6**, Lucide `FileText`, `size 14`, colour `cs.onSurface @0.45`, wrapped in
  `Tooltip(searchServicesPageWebFetchSupported)`.
- **Connection-status pill** — suppressed for `BingLocalOptions` and `KelivoOptions`
  (local-only services, no network). `padding: h8 / v2`, `radius 999`, single-line `Text`
  `fontSize 11`, `w600`, no border. States:

  | State | Text key | bg | fg |
  |---|---|---|---|
  | testing (`_testing[id] == true`) | `searchServicesPageTestingStatus` (`测试中…`) | `cs.primary @0.12` | `cs.primary` |
  | connected (`searchConnection[id] == true`) | `searchServicesPageConnectedStatus` (`已连接`) | `ac.success @0.12` | `ac.success` |
  | failed (`== false`) | `searchServicesPageFailedStatus` (`连接失败`) | `ac.warning @0.12` | `ac.warning` |
  | not tested (`null` / absent) | `searchServicesPageNotTestedStatus` (`未测试`) | `cs.onSurface @0.06` | `cs.onSurface @0.70` |

  There is **no spinner** and no icon in the pill — the "testing" state is purely the label +
  primary-tinted pill. Status is **session-scoped** (in-memory map, not persisted) and is
  (re)computed on launch only when the auto-test toggle is on.
- **Action buttons** — three `_SmallIconBtn`s: `Settings2` (edit), `HeartPulse` (test),
  `Trash2` (delete). Each is wrapped in a `Tooltip` with
  `searchServicesPageEditServiceTooltip` / `…TestConnectionTooltip` / `…DeleteServiceTooltip`.
  `_SmallIconBtn` spec: **28×28**, `radius 8`, bg transparent, hover bg
  `cs.onSurface @(dark 0.06 / light 0.05)`, Lucide icon **18**, colour `cs.onSurface`,
  cursor pointer, **no press-scale animation**.
  The delete button is **not visually disabled** when only one service remains (tap is a no-op,
  see §7).
- **Drag handle** — none. `ReorderableDragStartListener` wraps the entire card, so a pointer-down +
  move anywhere on the card starts a reorder immediately (no long-press, no grip dots). Plain taps
  still reach the card's `GestureDetector.onTap` (select) and the inner icon buttons win over both.
  Default Flutter drag proxy: `Material(elevation 0→6, Curves.easeInOut)` — i.e. the dragged card
  floats with an M3 elevation shadow and no scale change.

---

## 3. Row widgets

All three rows share the same horizontal skeleton:
`Padding(h 12, v 11 or 8)` → `Row[ icon column 36×18, gap 12, Expanded label 15px, trailing ]`.

### 3.1 `_WebFetchModeRow` (lines 443–493) — **fetch feature, see §8**

- `padding: h12 / v8` (note: v8, not v11 — it is visually 3px shorter than the toggle rows).
- icon column: `SizedBox(width: 36)` + Lucide `FileText` `size 18`, colour `cs.onSurface @0.90`.
- gap 12 → label `searchServicesPageWebFetchModeTitle` (`抓取方式`), 15px, `cs.onSurface @0.90`.
- trailing: `DesktopSelectDropdown<String>` with `minWidth: 168` (defaults: `minHeight 34`,
  `padding h11/v6`, `radius 10`, `maxLabelWidth 240`, fill `cs.surfaceContainerHigh`,
  border `1px cs.outlineVariant @0.18`; hover/open/focus border → `cs.primary`; when open an extra
  `BoxShadow(cs.primary @0.10, blur 0, spread 2)`; label 14px `cs.onSurface @0.88` 1-line ellipsis +
  `ChevronDown 16 @0.70` on the right, rotating 0→180° in 200 ms).
  Because options carry subtitles, the overlay is `max(trigger width, min(labelWidth+60, 440))`
  (min 360 with subtitles), `maxHeight = min(360, below/above room)`, panel `radius 12`,
  bg `ac.overlaySurface`, border `0.5px cs.outlineVariant @0.12`,
  `BoxShadow(cs.shadow @(dark .32/light .08), blur 16, y6)`, panel padding `h6/v4` per tile,
  tile `radius 8`, `minHeight 32`, label 14px (`w600` when selected, `cs.onSurface @0.88`),
  subtitle 12.5px `cs.onSurface @0.60`, selected bg `cs.primary @0.12`, hover bg
  `cs.onSurface @(dark .08/light .04)`, right check `Lucide.Check 14` in `cs.primary` (alpha 0 →
  invisible when unselected).
  Options (desktop): follow (`跟随搜索 · <current target>` when the trigger shows the value),
  local, one entry per fetch-capable service, off — subtitles shown in the menu only.

### 3.2 `_ToggleRow` (lines 495–532)

- Whole row is tappable (`HitTestBehavior.opaque`) → flips the switch; the switch itself is also
  interactive.
- `padding: h12 / v11`.
- icon column 36 wide, icon 18, colour `cs.onSurface @0.90`.
- gap 12, label 15px, `cs.onSurface @0.90`, no `maxLines`/ellipsis configured (it simply wraps;
  the shipped labels all fit on one line at 960 max width).
- trailing `IosSwitch` (below).
- Used here for: `HeartPulse` + `searchServicesPageAutoTestTitle`.

**`IosSwitch` look** (`ios_switch.dart`): track **44×26**, radius **13**; hit target 44×44
(`SizedBox(44,44)` centred); inner padding **3**, thumb **20×20** circle; ON track = `cs.primary`
(solid, no glow), thumb = `cs.surfaceContainerLowest` (light: near-white) / dark+ON:
`alphaBlend(onSurface@0.02, surface)`, dark+OFF thumb `alphaBlend(onSurface@0.36, surface)`;
OFF track light = `cs.onSurface @0.08`, dark = `alphaBlend(onSurface @0.02, surface)`; OFF border
`1px cs.onSurface @((dark 0.24 / light 0.20) * 0.65 when enabled, *0.35 when disabled)`.
Animation **220 ms** `easeOutCubic` (thumb ≤ ≥), press scale 0.98 over 100 ms. Disabled thumb gets
`@0.7`. No text/labels inside.

### 3.3 `_StepperRow` (lines 534–605)

- `padding: h12 / v11`.
- icon column 36 wide, icon 18, colour `cs.onSurface @0.90`.
- gap 12, label 15px `cs.onSurface @0.90`, Expanded.
- trailing: `_StepperButton(Minus)` → gap **8** → value box **width 42**, text centred,
  **14px / w400 / cs.onSurface @0.90**, plain `'$value'` (no suffix — the unit lives in the label,
  e.g. `超时时间（秒）`) → gap 8 → `_StepperButton(Plus)`.
- Bounds enforced by the caller: max-results 1…50, timeout 1…300 **seconds** (stored ms,
  displayed `timeout ~/ 1000`); a bound → `onMinus/onPlus == null` → button disabled.

`_StepperButton` (lines 607–669): **28×28**, radius **8**, bg transparent, hover bg
`cs.onSurface @(dark 0.10 / light 0.07)`, icon **16**, icon colour `cs.onSurface` when enabled /
`cs.onSurface @0.40` when disabled; press scale **0.96** over **90 ms** `easeOutCubic`; cursor
`pointer` enabled / `basic` disabled; tap handlers null when disabled.

### 3.4 `_divider` (lines 804–813)

`Divider(height: 6, thickness: 0.6, indent: 12, endIndent: 12, color: cs.outlineVariant @0.18)`.
Net effect: rows separated by 6 px of vertical space with a 0.6 px hairline inset 12 px on both
sides.

---

## 4. Dialogs

All four dialogs share one shell:

- `Dialog(backgroundColor: ac.overlaySurface, insetPadding: h20 / v18,
  shape: RoundedRectangleBorder(radius 16))`; default M3 dialog elevation/shadow is kept
  (elevation 6, `cs.shadow`), no tint (M3 surfaceTint disabled by the theme's `DialogThemeData`
  which only sets `backgroundColor`).
  `ac.overlaySurface` = **layered mode ? `ac.surfaceCard` : `cs.surface`**; the app defaults to
  `useLayeredSheetTiles = false`, so dialogs are painted with the **page** colour
  (light `#F7F7F7`, dark `#121213`).
- Content padding `EdgeInsets.fromLTRB(16, 12, 16, 58)` for add/edit (the 58 bottom band reserves
  space for the absolutely-positioned footer button); `(16, 12, 16, 16)` for multi-key.
- Header row: `Expanded(Text(title, 14px / w700))` + `_SmallIconBtn(Lucide.X)` (28×28, r8,
  icon 18, hover `cs.onSurface @(dark .06/light .05)`) that calls `Navigator.maybePop()`.
- Field stack gap: **12** between every pair of fields.
- **No scroll view** in the add/edit dialogs: the body is a non-scrolling
  `Column(mainAxisSize.min)`; tall provider forms (Grok 5 fields, TinyFish 6, Querit 6) rely on the
  dialog fitting the window. A web port should add `overflow-y: auto` on the body.
- Field decoration (`_deskInputDecoration`, lines 3313–3342): `filled: true`,
  `fillColor: ac.surfaceFill`, radius **12**, border **0.8px** `cs.outlineVariant @0.20`
  (enabled + default identical), focused **1.0px** `cs.primary @0.45`,
  `contentPadding: h12 / v12`, `isDense: false`. Label/hint sizes come from Material 3 defaults
  (floating label 12px, inline label / value / hint 16px, hint `cs.onSurfaceVariant`) — the app
  defines **no** `InputDecorationTheme`.
- Footer button: `_DeskIosButton(filled: true, dense: true)`, `Positioned(right: 12, bottom: 12)`.
- No Cancel button anywhere on desktop (mobile has one); dismissal = X button / barrier click /
  Esc. Barrier is dismissible by default (`barrierDismissible: true`).

`_DeskIosButton` (lines 3179–3251):

| prop | dense (used) | non-dense |
|---|---|---|
| padding | `v8 h12` | `v12 h12` |
| font | **13 / w600** | 14 / w600 |
| radius | **12** | 12 |
| filled bg | `cs.primary`, hover `cs.primary @0.92` | — |
| filled fg | `cs.onPrimary` | — |
| outline fg | `cs.onSurface @0.80`, border `cs.outlineVariant @(dark .22/light .18)`, hover bg `cs.onSurface @(dark .06/light .05)` | — |
| press | scale **0.98** over **110 ms** `easeOutCubic` | — |

### 4.1 Add service dialog (lines 849–1566)

- `maxWidth: **420**`; height = content (title row 28 + 8 + type trigger + 12 + fields).
- Title: `searchServicesAddDialogTitle` (`添加搜索服务`) 14px/w700.
- After header: gap **8** → **centred type picker** → gap **12** → provider fields.
- **Type picker = `_ServiceTypeDropdown` (a custom overlay dropdown), not chips.**
  There is **no search/filter box**, no keyboard type-ahead. (`_ServiceTypeChips` at 2763–2850 is
  dead code: only its `_types` list is reused.)
  Trigger: `padding h10 / v8`, radius **10**, border 0.6px `cs.outlineVariant @0.12`, bg transparent,
  hover/open bg `cs.onSurface @(dark .06/light .04)` (120 ms animated), leading `_BrandBadge 18`,
  gap 6, label 14.5px `cs.onSurface @0.90`, gap 6, `ChevronDown 16 @0.80` (rotates 180° / 180 ms).
  Overlay: anchored under the trigger (`offset dy = triggerHeight + 6`, horizontally re-centred,
  `width = clamp(triggerWidth, 200, 320)`), `maxHeight = 40 % of window height`, panel radius **12**,
  bg `cs.surfaceContainerHigh`, border 0.5px `cs.outlineVariant @0.12`,
  `BoxShadow(cs.shadow @0.05, blur 12, y6)`; scroll padding `h8/v6`; items gap **6**.
  Item (`_DropdownItem`): `padding h8/v6`, radius **8**, selected bg `cs.primary @0.08`, hover bg
  `cs.onSurface @(dark .06/light .04)`, leading box 24×24 (badge 18), gap 8, label 14px
  `cs.onSurface @0.90`, trailing `Check 16` in `cs.primary` when selected.
- Type list order (27 entries, no `kelivo`): `bing_local, duckduckgo, tavily, exa, exa_mcp, zhipu,
  searxng, linkup, brave, metaso, jina, ollama, deepseek, perplexity, bocha, doubao, kagi, serper,
  querit, grok, stepfun, firecrawl, tinyfish, anysearch, parallel, kimi, you`.
  Display names = `searchServiceName*` (§6). Default selection = `bing_local` (`Bing（Local）`),
  which renders **zero fields**.
- Changing type resets only: `parallel` → mode `advanced`; `you` → contentMode `highlights`;
  `brave` → mode `web` + maxTokens `8192`. All other typed text is **not** cleared.
- Fields per type: see the matrix in §4.4. Default text prefilled: region `us-en`,
  model `grok-4.5`, reasoningEffort `low`, customUrl `https://api.x.ai/v1/responses`,
  systemPrompt = Grok default English prompt, mode `advanced`, contentMode `highlights`,
  maxTokens `8192`.
- **No multi-key tile in the add dialog** (single API key field only).
- Footer: only the `Add` button (`searchServicesAddDialogAdd` → `添加` / `Add`), filled+dense.
  On tap → validate Brave max-tokens (§7.5) → build options object with `id = uuid4()[0..8)` →
  `Navigator.pop(created)`.

### 4.2 Edit service dialog (lines 1568–2526)

- `maxWidth: **480**`, otherwise identical shell; footer = `Save`
  (`searchServicesEditDialogSave` → `保存` / `Save`).
- Title = the **service display name** (e.g. `Tavily`), 14px/w700 — not a localized "Edit" string.
- Header → gap **12** → fields (no type picker: the type is fixed).
- Every editable API-key provider inserts a **multi-key tile** immediately after the primary
  `API Key` field (`Tavily, Exa, ExaMcp, Zhipu, LinkUp, Metaso, Jina, Ollama, DeepSeek, Perplexity,
  Bocha, Doubao, Kagi, Brave, Grok, Serper, Querit, StepFun, Firecrawl, TinyFish, AnySearch,
  Parallel, Kimi, You`). It is **not** shown for `DuckDuckGo`, `SearXNG`, `Bing Local`.
- `Bing Local` / `Kelivo` → empty field list (dialog is title + Save; Save returns the service
  unchanged).
- `Kimi` uses `IosFormTextField` for its API key instead of `TextField`:
  `inlineLabel: false, outerPadding: EdgeInsets.zero` → a **13px/w600 label above** a painted field
  (`bg ac.surfaceCardFill`, radius **12**, minHeight **40**, inner padding h12, value 15px/w500,
  hint `cs.onSurface @(dark .42/light .46)`); gap 6 between label and field.
- Querit add uses `searchServicesDialogApiKey` while edit reuses the same; DuckDuckGo and SearXNG use
  the "Edit…" variants of the instance-URL/region strings.

**Multi-key tile** (`_multiKeyTile`, lines 2202–2258):

- container `padding h12 / v10`, radius **12**, fill `ac.surfaceFill`,
  border **0.8px** `cs.outlineVariant @0.20`, cursor pointer, whole tile tappable.
- row: `KeyRound 16` in `cs.primary`, gap **10**, title
  `searchServiceEditorMultiKeyTitle` (`多 Key 轮询`) 13px/w600 `cs.onSurface`,
  Expanded; trailing count text 12.5px — `searchServiceEditorMultiKeyNone` (`未配置`) in
  `cs.onSurface @0.55` when 0 keys, else
  `searchServiceEditorMultiKeyCount(count)` (`共 {count} 个 Key`) in `cs.primary`;
  gap 4, `ChevronRight 16` `cs.onSurface @0.50`.
- count = `(primaryKey.trim().isEmpty ? 0 : 1) + extraKeys.length`, recomputed live while the primary
  field is typed (controller listener).
- tap → builds the current options, opens `_MultiKeyManageDialog`; on close with a pool:
  primary = `pool[0]`, extras = `pool[1..]` (empty pool ⇒ primary `''`, extras `[]`).

### 4.3 Multi-key manage dialog (lines 2528–2761)

- `maxWidth: **440**`, `maxHeight: **520**`, padding `(16, 12, 16, 16)`.
- Header: `searchServiceEditorMultiKeyTitle` 14/w700 + X (returns the pool).
- gap **4** → description `searchApiKeysPageDescription` 12px / line-height 1.4 /
  `cs.onSurface @0.60`.
- gap **10** → key list (`Flexible` + `ListView.separated`, `shrinkWrap: true`):
  - row `padding v8`; `KeyRound 15` (`cs.primary` for index 0, `cs.onSurface @0.50` otherwise);
    gap **10**; masked key 13px `cs.onSurface @0.88`, 1 line ellipsis
    (mask = first 4 + `••••` + last 4; keys ≤ 8 chars → `••••••••`);
    primary badge: padding `h5/v1`, radius **5**, bg `cs.primary @0.12`, text
    `searchApiKeysPagePrimaryBadge` (`主`) 10px/w600 `cs.primary`;
    `Eye`/`EyeOff` `_SmallIconBtn` (28×28) to reveal; `Trash2` `_SmallIconBtn` to delete
    (removing an index also clears the reveal set).
  - separators: `height 1, thickness 0.6, indent 28, cs.outlineVariant @0.18`.
  - empty state: `searchApiKeysPageEmpty` (`尚未配置任何 Key。`) 12.5px `cs.onSurface @0.55`,
    bottom padding 8.
- gap **8** → batch `TextField` (`minLines 1`, `maxLines 3`, hint
  `searchApiKeysPageBatchHint` = paste one-per-line or comma-separated; typing clears the feedback).
- gap **8** → Row: `Expanded` feedback text (12px; `cs.primary` when `added > 0`, else
  `cs.onSurface @0.60`) + `_DeskIosButton(Add, filled, dense)` (`searchApiKeysPageAdd`).
- Add algorithm: split the textarea on `[\s,;]+`, trim, drop empties, drop values already in the
  pool → feedback `searchApiKeysPageBatchResult(added, skipped)` = `已添加 {added} 个，跳过 {skipped} 个重复`.
- There is **no separate Done/Save**; X returns the pool and that is the commit.

### 4.4 Per-provider field matrix

Legend: **P** = placeholder only (`hintText`), **L+** = floating label + placeholder, `[tile]` =
multi-key tile (edit only), `[mode]` = embedded `_deskModeDropdown` (an `InputDecorator` with the
label above an `embedded` dropdown: `minWidth 0`, `minHeight 24`, `padding 0`, radius 8,
`maxLabelWidth 360`).

| Type | Add dialog (top→bottom) | Edit dialog (top→bottom) |
|---|---|---|
| `bing_local` | — | — |
| `duckduckgo` | region P `地区（可选，默认 us-en）` | region P `地区（可选，默认 us-en）` |
| `tavily` | apiKey P `API Key`; url L+ `自定义 URL（可选）` / `https://api.tavily.com/search` | apiKey; **[tile]**; url |
| `exa` | apiKey P `API Key`; url L+ / `https://api.exa.ai/search` | apiKey; **[tile]**; url |
| `exa_mcp` | apiKey P `API Key（可选）`; url L+ / `https://mcp.exa.ai/mcp` | apiKey; **[tile]**; url |
| `zhipu`, `linkup`, `metaso`, `jina`, `ollama`, `deepseek`, `perplexity`, `bocha`, `doubao`, `kagi` | apiKey P `API Key` | apiKey; **[tile]** |
| `brave` | apiKey P `API Key`; [mode] `搜索模式` (Web Search=`web` / LLM Context=`llmContext`); **if mode = llmContext** maxTokens L+ `最大 token 数` / `8192`, numeric, inline error | apiKey; **[tile]**; [mode]; **if llmContext** maxTokens |
| `serper` | apiKey P `API Key`; gl P `国家/地区（可选）`; hl P `语言（可选）`; tbs P `时间过滤（可选）`; page P `页码（可选）` numeric | apiKey; **[tile]**; gl; hl; tbs; page |
| `querit` | apiKey P `API Key`; sitesInclude P `包含站点（可选）`; sitesExclude P `排除站点（可选）`; timeRange P `时间范围（可选）`; countries P `国家（可选）`; languages P `语言（可选）` | apiKey; **[tile]**; + same 5 |
| `grok` | apiKey P `API Key`; model L+ `模型` / `grok-4.5`; reasoningEffort L+ `思维链强度` / `none / low / medium / high / xhigh`; customUrl L+ `自定义 URL（可选）` / `https://api.x.ai/v1/responses`; systemPrompt P `系统提示词` (minLines 3, maxLines 5) | apiKey; **[tile]**; model; reasoningEffort; customUrl; systemPrompt |
| `searxng` | url P `实例 URL`; engines P `搜索引擎（可选）`; language P `en-US`; username P `用户名（可选）`; password P `密码（可选）` (obscured) | url P `实例 URL` (edit string); engines; language `en-US`; username; password |
| `stepfun` | apiKey P `API Key`; url L+ / `https://api.stepfun.com/v1/search`; category P `programming / research / gov / business` | apiKey; **[tile]**; url; category |
| `firecrawl` | apiKey P `API Key`; url L+ / `https://api.firecrawl.dev/v2/search`; country P `US`; location P `Location` | apiKey; **[tile]**; url; country; location |
| `tinyfish` | apiKey P `API Key`; url L+ / `https://api.search.tinyfish.ai`; location P `US`; language P `en`; includeDomains P `Include domains`; excludeDomains P `Exclude domains` | apiKey; **[tile]**; url; location; language; includeDomains; excludeDomains |
| `anysearch` | apiKey P `API Key`; url L+ / `https://api.anysearch.com/v1/search` | apiKey; **[tile]**; url |
| `parallel` | apiKey P `API Key`; [mode] `搜索模式` (Advanced/Basic/Fast/Turbo; default `advanced`) | apiKey; **[tile]**; [mode] |
| `kimi` | apiKey via `IosFormTextField` (label above `API Key`); [mode] `搜索模式` (Pro/Basic; default `pro`) | apiKey (IosFormTextField); **[tile]**; [mode] |
| `you` | apiKey P `API Key`; [mode] `内容模式` (Highlights=`highlights` / Snippets=`snippets`; default highlights) | apiKey; **[tile]**; [mode] |

Notes:
- `[mode]` dropdown mode labels for Parallel/Kimi are hard-coded English (`Advanced/Basic/Fast/Turbo`,
  `Pro/Basic`); Brave/You labels come from l10n (`Web Search`/`LLM Context`,
  `Highlights`/`Snippets` — identical strings in en, `Web Search`/`LLM Context` are **not**
  translated in zh either).
- `_BraveMaximumTokensField`: numeric keyboard, L+ label `最大 token 数`, placeholder `8192`,
  `errorText` shown in red (M3 `cs.error`, 12px) when invalid; typing clears the error.
- Save builds a new options object preserving `id` and (for Perplexity/Bocha/Firecrawl) fields that
  are not editable here (`country`, `searchDomainFilter`, `maxTokensPerPage`, `freshness`, `summary`,
  `include`, `exclude`, `sources`, `categories`).

---

## 5. Colors, radii, typography, motion

### 5.1 Semantic tokens (central definitions)

`AppSemanticColors` (`lib/theme/app_semantic_colors.dart`), derived per theme from `ColorScheme` +
`SurfaceLadder`:

| token | light | dark | used by this pane for |
|---|---|---|---|
| `ac.surfaceCard` | ladder `card` = `alphaBlend(#FFF @0.96, page)` (non-layered) | `alphaBlend(#FFF @0.10, page)` | service card fill, `SectionCard` fill |
| `ac.surfaceCardFill` | = `surfaceFill` (non-layered) | = `surfaceFill` | Kimi field fill |
| `ac.surfaceFill` | `alphaBlend(cs.onSurface @0.05, page)` | `alphaBlend(cs.onSurface @0.16, page)` | input fills, multi-key tile fill, chip fill |
| `ac.hairline` | `cs.outlineVariant @0.06` | `cs.outlineVariant @0.08` | `SectionCard` border |
| `ac.hairlineStrong` | `cs.outlineVariant @0.38` | `@0.26` | (emphasized SectionCard — unused here) |
| `ac.success` | `#2E7D32` harmonized to primary (≤15° hue shift) | `#81C784` harmonized | connected pill |
| `ac.warning` | `#F57C00` harmonized | `#FFB74D` harmonized | failed pill |
| `ac.overlaySurface` | layered ? `surfaceCard` : `cs.surface` | same rule | dialog background |
| (`successContainer` `#A5D6A7` L / `#1B5E20` D, `warningContainer` `#FFE0B2` L / `#8D4E00` D, `onSuccessContainer` `#1B5E20`/`#C8E6C9`, `onWarningContainer` `#4E2600`/`#FFE8CC` are **not** used by this pane) | | | |

`cs.outlineVariant` is **pure black** in the default light palette and **pure white** in dark
(`palettes.dart:65/97`); many other palettes do the same. Treat it as a CSS var
`--outline-variant: #000 / #FFF` and apply the given alphas, or pre-blend the rgba.

### 5.2 Concrete default-palette values (workable CSS defaults)

Default palette: `primary` `#4D5C92` / `#B6C4FF`, `onPrimary` `#FFFFFF` / `#1D2D61`,
`surface` `#F7F7F7` / `#121213`, `onSurface` `#202020` / `#F9F9F9`, `outlineVariant`
`#000000` / `#FFFFFF`, `shadow` `#000000`; page background is **not** shifted in non-layered mode.

| thing | light | dark |
|---|---|---|
| page / pane bg (`cs.surface`) | `#F7F7F7` | `#121213` |
| `ac.surfaceCard` (composite) | `≈ #FFFFFF` | `#2A2A2B` |
| `ac.surfaceFill` | `#ECECEC` | `#373738` |
| `cs.surfaceContainerHigh` (dropdown fill) | `≈ #FEFEFE` | `#202021` |
| card border default (black/white @8–12 %) | `rgba(0,0,0,.08)` | `rgba(255,255,255,.12)` |
| card border hover/selected | `rgba(77,92,146,.45)` → ≈`#AFB6CE` over card | `rgba(182,196,255,.35)` → ≈`#696F8A` |
| `SectionCard` hairline | `rgba(0,0,0,.06)` | `rgba(255,255,255,.08)` |
| `cs.primary` on card bg @10/12/18 % | `#EDEFF4` / `#EAEBF2` / `#DFE2EB` | `#383940` / `#3B3C44` / `#434651` |
| dialog bg (`ac.overlaySurface`) | `#F7F7F7` | `#121213` |
| success | `≈ #2E7D32` | `≈ #81C784` |
| warning | `≈ #F57C00` | `≈ #FFB74D` |

### 5.3 M3 role → CSS variable map for the port

| Flutter | CSS var suggestion | notes |
|---|---|---|
| `cs.primary` | `--primary` | alphas 0.08/0.10/0.12/0.18/0.20/0.35/0.45/0.92/1 |
| `cs.onPrimary` | `--on-primary` | filled buttons |
| `cs.onSurface` | `--on-surface` | text alphas 0.4/0.45/0.5/0.55/0.6/0.7/0.8/0.88/0.9/0.92 |
| `cs.onSurfaceVariant` | `--on-surface-variant` | input hint (M3 default) |
| `cs.outlineVariant` | `--outline-variant` | alphas 0.06/0.08/0.12/0.18/0.20/0.22/0.26/0.38 |
| `cs.surface` | `--surface` | page + dialog bg (non-layered) |
| `cs.surfaceContainerHigh` | `--surface-container-high` | dropdown trigger + menu fill |
| `cs.shadow` | `--shadow` | dropdown/dialog shadows |
| `ac.surfaceCard` | `--surface-card` | cards |
| `ac.surfaceFill` | `--surface-fill` | inputs / tiles |
| `ac.hairline` | `--hairline` | SectionCard border |
| `ac.success` / `ac.warning` | `--success` / `--warning` | pills |

### 5.4 Radii

| element | radius |
|---|---|
| service card | 18 |
| `SectionCard` | 12 (18 for emphasized — unused) |
| dialog | 16 |
| buttons (`_DeskIosButton`), input fields, multi-key tile | 12 |
| type-dropdown trigger, dropdown menu panel, iOS switch track | 10 (`trigger`), 12 (`panel`), 13 (switch) |
| icon buttons (28×28), stepper buttons, dropdown item | 8 |
| primary-key badge | 5 |
| pills (status, type chip) | 999 |

### 5.5 Typography

| element | size | weight | colour |
|---|---|---|---|
| pane title (`搜索服务`) | 14 | 400 | `cs.onSurface @0.9` |
| dialog title | 14 | 700 | default (`cs.onSurface`) |
| service name | 16 | 700 | default (`cs.onSurface`) |
| row labels (toggle/stepper/web-fetch) | 15 | 400 | `cs.onSurface @0.9` |
| stepper value | 14 | 400 | `cs.onSurface @0.9` |
| status pill | 11 | 600 | state colour |
| footer hint | 12 | 400, lh 1.4 | `cs.onSurface @0.55` |
| button (dense / normal) | 13 / 14 | 600 | per variant |
| multi-key title | 13 | 600 | `cs.onSurface` |
| multi-key count | 12.5 | 400 | primary / `onSurface @0.55` |
| multi-key key text | 13 | 400 | `cs.onSurface @0.88` |
| primary badge | 10 | 600 | `cs.primary` |
| type-trigger label | 14.5 | 400 | `cs.onSurface @0.9` |
| dropdown item label | 14 | 400 (600 selected) | `cs.onSurface @0.88` |
| dialog body/description | 12 | 400, lh 1.4 | `cs.onSurface @0.6` |
| field value / hint | 16 | 400 (M3 default) | `cs.onSurface` / `onSurfaceVariant` |
| floating field label | 12 | 400 (M3 default) | `cs.onSurfaceVariant` |

Font family: platform default with fallbacks `PingFang SC, Heiti SC, Hiragino Sans GB, Roboto`
(`theme_factory.dart:11–16`). No custom family. Weight caveat: `AppFontWeights` maps w600→w500 and
w700→w500 **on Android only**; the reference look (desktop) is the direct weight.

### 5.6 Motion / elevation

| interaction | motion |
|---|---|
| stepper button press | scale 0.96, 90 ms easeOutCubic |
| `_DeskIosButton` press | scale 0.98, 110 ms easeOutCubic |
| type trigger bg | 120 ms easeOutCubic |
| type dropdown chevron | 180° rotation, 180 ms |
| dropdown menu | fade + slide (y −0.06→0), 200 ms |
| `DesktopSelectDropdown` trigger | 160 ms container animation; chevron 200 ms |
| iOS switch | 220 ms easeOutCubic; press scale 0.98 / 100 ms |
| card border | **none** (instant) |
| drag proxy | Flutter default `Material` elevation 0→6, `easeInOut` |
| elevation/shadows elsewhere | none: cards/SectionCards are flat; only dialogs (M3 elevation 6) and dropdown menus (shadow above) cast shadows |

---

## 6. Localization table (zh-CN / en)

Keys rendered by the **desktop** pane and its dialogs. `{…}` = placeholder.

| key | zh-CN | en |
|---|---|---|
| `searchServicesPageTitle` | 搜索服务 | Search Services |
| `searchServicesPageAutoTestTitle` | 启动时自动测试连接 | Auto-test connections on launch |
| `searchServicesPageMaxResults` | 最大结果数 | Max Results |
| `searchServicesPageTimeoutSeconds` | 超时时间（秒） | Timeout (seconds) |
| `searchServicesPageWebFetchModeTitle` | 抓取方式 | Read pages with |
| `searchServicesPageWebFetchFooter` | 开启联网搜索后，模型还可以读取网页全文。搜索服务不支持抓取时会改用本地抓取，本地抓取无法处理需要 JavaScript 渲染或有反爬限制的页面。\n\n如已使用此处的网页抓取，建议前往「设置 → MCP」关闭内置 @kelivo/fetch，避免模型混用两个抓取工具。此处配置的网页抓取仍可正常使用。 | With web search on, the model can also read full pages. When the search service can't read pages, local reading is used, which can't handle pages that need JavaScript or block bots.\n\nIf you use the page reader configured here, disable the built-in @kelivo/fetch in Settings → MCP to avoid overlapping tools. The page reader configured here will still work. |
| `searchServicesPageWebFetchSupported` | 支持网页抓取 | Can read web pages |
| `searchServicesPageTestingStatus` | 测试中… | Testing… |
| `searchServicesPageConnectedStatus` | 已连接 | Connected |
| `searchServicesPageFailedStatus` | 连接失败 | Failed |
| `searchServicesPageNotTestedStatus` | 未测试 | Not tested |
| `searchServicesPageEditServiceTooltip` | 编辑服务 | Edit Service |
| `searchServicesPageTestConnectionTooltip` | 测试连接 | Test Connection |
| `searchServicesPageDeleteServiceTooltip` | 删除服务 | Delete Service |
| `searchServicesAddDialogTitle` | 添加搜索服务 | Add Search Service |
| `searchServicesAddDialogAdd` | 添加 | Add |
| `searchServicesAddDialogRegionOptional` | 地区（可选，默认 us-en） | Region (optional, default: us-en) |
| `searchServicesAddDialogInstanceUrl` | 实例 URL | Instance URL |
| `searchServicesAddDialogEnginesOptional` | 搜索引擎（可选） | Engines (optional) |
| `searchServicesAddDialogUsernameOptional` | 用户名（可选） | Username (optional) |
| `searchServicesAddDialogPasswordOptional` | 密码（可选） | Password (optional) |
| `searchServicesEditDialogSave` | 保存 | Save |
| `searchServicesEditDialogRegionOptional` | 地区（可选，默认 us-en） | Region (optional, default: us-en) |
| `searchServicesEditDialogInstanceUrl` | 实例 URL | Instance URL |
| `searchServicesDialogApiKey` | API Key | API Key |
| `searchServicesDialogApiKeyOptional` | API Key（可选） | API Key (optional) |
| `searchServicesFieldCustomUrlOptional` | 自定义 URL（可选） | Custom URL (optional) |
| `searchServicesDialogCountryOptional` | 国家/地区（可选） | Country/region (optional) |
| `searchServicesDialogLanguageOptional` | 语言（可选） | Language (optional) |
| `searchServicesDialogTimeFilterOptional` | 时间过滤（可选） | Time filter (optional) |
| `searchServicesDialogPageOptional` | 页码（可选） | Page (optional) |
| `searchServicesDialogSitesIncludeOptional` | 包含站点（可选） | Include sites (optional) |
| `searchServicesDialogSitesExcludeOptional` | 排除站点（可选） | Exclude sites (optional) |
| `searchServicesDialogTimeRangeOptional` | 时间范围（可选） | Time range (optional) |
| `searchServicesDialogCountriesOptional` | 国家（可选） | Countries (optional) |
| `searchServicesDialogLanguagesOptional` | 语言（可选） | Languages (optional) |
| `searchServicesDialogModel` | 模型 | Model |
| `searchServicesDialogSystemPrompt` | 系统提示词 | System Prompt |
| `searchServicesDialogSearchMode` | 搜索模式 | Search mode |
| `searchServicesDialogWebSearch` | Web Search | Web Search |
| `searchServicesDialogLlmContext` | LLM Context | LLM Context |
| `searchServicesDialogContentMode` | 内容模式 | Content mode |
| `searchServicesDialogHighlights` | Highlights | Highlights |
| `searchServicesDialogSnippets` | Snippets | Snippets |
| `searchServicesDialogMaximumTokens` | 最大 token 数 | Maximum tokens |
| `searchServicesDialogMaximumTokensInvalid` | 最大 token 数必须介于 1024 和 32768 之间。 | Maximum tokens must be between 1024 and 32768. |
| `searchServiceEditorMultiKeyTitle` | 多 Key 轮询 | Multi-key rotation |
| `searchServiceEditorMultiKeyNone` | 未配置 | Not configured |
| `searchServiceEditorMultiKeyCount` | 共 {count} 个 Key | {count} keys |
| `searchApiKeysPageDescription` | 列表中的 Key 按顺序轮询使用，第一个为主 Key；不查额度，以防触发服务商风控。 | Keys rotate in the order listed; the first is the primary key. Usage is not queried to avoid provider rate limiting. |
| `searchApiKeysPagePrimaryBadge` | 主 | Primary |
| `searchApiKeysPageBatchHint` | 可一次粘贴多个 Key：每行一个，或用逗号分隔 | Paste one or more keys — one per line or comma-separated |
| `searchApiKeysPageBatchResult` | 已添加 {added} 个，跳过 {skipped} 个重复 | Added {added}, skipped {skipped} duplicate(s) |
| `searchApiKeysPageAdd` | 添加 | Add |
| `searchApiKeysPageEmpty` | 尚未配置任何 Key。 | No keys configured yet. |
| `reasoningBudgetSheetTitle` (reused as Grok "reasoning effort" label) | 思维链强度 | Reasoning Chain Strength |
| `settingsPageSearch` (nav label, host) | 搜索服务 | Search |
| `settingsPageTitle` (host top bar) | 设置 | Settings |

Fetch-mode strings used **only** by `_WebFetchModeRow`'s dropdown (see §8):

| key | zh-CN | en |
|---|---|---|
| `searchServicesPageWebFetchFollow` | 跟随搜索服务 | Follow search service |
| `searchServicesPageWebFetchFollowValue` | 跟随搜索 · {name} | Follow search · {name} |
| `searchServicesPageWebFetchFollowSubtitle` | 当前：{name} | Currently {name} |
| `searchServicesPageWebFetchLocal` | 本地抓取 | Local |
| `searchServicesPageWebFetchLocalSubtitle` | 免费，由本机直接请求网页 | Free. This device requests the page directly. |
| `searchServicesPageWebFetchProviderSubtitle` | 使用该服务商的 API Key 和额度 | Uses this service's API key and quota |
| `searchServicesPageWebFetchOff` | 关闭 | Off |
| `searchServicesPageWebFetchOffSubtitle` | 联网时只搜索，不读取网页 | Search only, without reading pages |

Service display names (`searchServiceName*`):

| key | zh-CN | en | brand asset |
|---|---|---|---|
| …BingLocal | Bing（Local） | Bing (Local) | `bing-color.svg` |
| …DuckDuckGo | DuckDuckGo | DuckDuckGo | `duckduckgo-color.svg` |
| …Tavily | Tavily | Tavily | `tavily-color.svg` |
| …Exa | Exa | Exa | `exa-color.svg` |
| …ExaMcp | Exa MCP | Exa MCP | `exa-color.svg` |
| …Zhipu | 智谱 | Zhipu AI | (none → initial) |
| …SearXNG | SearXNG | SearXNG | `searxng-color.svg` |
| …LinkUp | LinkUp | LinkUp | `linkup.svg` |
| …Brave | Brave | Brave Search | `brave-color.svg` |
| …Metaso | 秘塔 | Metaso | `metaso-color.svg` |
| …Jina | Jina | Jina | `jina-color.svg` |
| …Ollama | Ollama | Ollama | `ollama.svg` |
| …DeepSeek | DeepSeek | DeepSeek | (none → initial) |
| …Perplexity | Perplexity | Perplexity | (none → initial) |
| …Bocha | 博查 | Bocha | `bocha-color.svg` |
| …Doubao | 豆包 | Doubao | (none → initial) |
| …Kagi | Kagi | Kagi | `kagi-color.svg` |
| …Serper | Serper | Serper | `serper.svg` |
| …Querit | Querit | Querit | `querit-color.svg` |
| …Grok | Grok | Grok | (none → initial) |
| …StepFun | StepFun | StepFun | (none → initial) |
| …Firecrawl | Firecrawl | Firecrawl | `firecrawl-color.svg` |
| …TinyFish | TinyFish | TinyFish | `tinyfish-color.svg` |
| …AnySearch | AnySearch | AnySearch | `anysearch.svg` |
| …Parallel | Parallel | Parallel | `parallel.svg` |
| …Kimi | Kimi | Kimi | (none → initial) |
| …You | You.com | You.com | `you.svg` |
| …Kelivo | Kelivo | Kelivo | `kelivo.png` |

Hard-coded (not localizable) strings in the desktop dialogs: `API Key` (placeholder for exa, zhipu
group, serper, grok, quest others use l10n), `US`, `Location`, `en`, `Include domains`,
`Exclude domains`, `en-US`, `programming / research / gov / business`,
`none / low / medium / high / xhigh`, `Advanced / Basic / Fast / Turbo`, `Pro / Basic`.

Strings that exist but are **never rendered by the desktop pane** (mobile-only or dead):
`searchServicesAddDialogServiceType`, `searchServicesAddDialogCancel`, `searchServicesAddDialogUrlRequired`,
`searchServicesAddDialogLanguageOptional`, `searchServicesAddDialogApiKeyRequired`,
`searchServicesEditDialogCancel`, `searchServicesEditDialogBingLocalNoConfig`,
`searchServicesEditDialogApiKeyRequired`, `searchServicesEditDialogUrlRequired`,
`searchServicesEditDialogEnginesOptional`, `searchServicesEditDialogLanguageOptional`,
`searchServicesEditDialogUsernameOptional`, `searchServicesEditDialogPasswordOptional`,
`searchServicesPageAtLeastOneServiceRequired`, `searchServicesPageEdit`,
`searchServicesPageAddProvider`, `searchServicesPageSearchProviders`,
`searchServicesPageWebFetchSection`, `searchServicesPageGeneralOptions`,
`searchServicesPageBackTooltip`, `searchServicesPageDone`, `searchServiceEditor*` (usage/test/
delete/discard group), `searchServiceEditorNoConfiguration`.

---

## 7. Interaction inventory

1. **Select active service** — click anywhere on a card (except the action buttons) →
   `setSearchServiceSelected(index)`; persisted (prefs key). Active card = primary border
   (§2.1); the active service is the one used for search/follow-fetch. No visual "active" text.
2. **Hover** — cards: border → primary @0.45/0.35 + pointer cursor. Icon buttons / stepper /
   `_DeskIosButton` / dropdown items: hover fill as tabulated. Tooltips appear after the Flutter
   default delay (~500 ms) for the three card buttons and the fetch icon.
3. **Drag-to-reorder** — pointer-down + move on a card starts an immediate drag (no grip, no
   long-press). While dragging, the card is proxied at Material elevation 6 (easeInOut). On drop,
   the whole list order is persisted and the `selectedIndex` is remapped by **service id** so the
   same service stays active. Bounds-checked (out-of-range indices are ignored).
4. **Test connection** — `HeartPulse`. Sets `_testing[id] = true` → pill flips to
   `测试中…` (primary tint) immediately; runs
   `search('connectivity test', settings.searchCommonOptions)`; on success
   `setSearchConnection(id, true)` → `已连接`; on any error `false` → `连接失败`; finally clears
   `_testing`. No toast, no inline error, no disable of other controls, no cancellation; the pill
   stays at its result until app restart (map is not persisted) or the next test.
   *Auto-test*: when the toggle is on, every service except `Bing Local` / `Kelivo` is tested in the
   background at launch (fire-and-forget); local ones are set to `null` (not tested).
5. **Delete** — `Trash2`. **No confirmation dialog on desktop.** If `services.length <= 1` the tap
   is a silent no-op (button is *not* disabled or greyed). Otherwise the service is removed
   immediately, and the selection index is clamped to `list.length - 1` if it fell off the end.
6. **Add** — header `Plus` → add dialog (§4.1). Default type `Bing（Local）`. On `Add`, the returned
   options are **appended to the end**; selection is unchanged; no auto connection test is run.
   Dialog dismissal (X / Esc / barrier) returns null.
7. **Save (edit)** — card `Settings2` (or a click on the row from mobile); the returned service
   replaces the item at the same index (id preserved); closes the dialog. No success toast.
   Unsaved dialog changes are discarded on dismissal (no "discard changes?" prompt on desktop).
8. **Multi-key flow** — edit dialog tile → manage dialog (§4.3). Editing the primary key updates the
   tile count live. X returns the pool and rewrites primary + extras.
9. **Validation**
   - Brave `maximumNumberOfTokens`, only when mode = `llmContext`: must be empty (⇒ default 8192) or
     an integer in **1024…32768**; otherwise Add/Save is blocked, the dialog stays open and the field
     shows `searchServicesDialogMaximumTokensInvalid` as `errorText`. Editing the field clears the
     error.
   - Everything else has **no validation**: empty API keys / URLs are accepted, no duplicate-key or
     duplicate-URL checks, no URL syntax check. SearXNG URL, DuckDuckGo region (empty ⇒ `us-en`),
     Serper page (non-numeric ⇒ 1) are normalized on save.
10. **Reorder + selection persistence failures** — none; all writes go through
    `SettingsProvider.setSearchServices` which persists.
11. **Keyboard/a11y** — the desktop pane defines no explicit focus traversal or shortcuts for cards
    (only the dropdowns have Enter/Space/Arrow handling, Esc closes the menu). Tooltips are the only
    accessibility hints; add `aria-label`s in a web port.

---

## 8. What to drop for a DSH port with no local web-fetch service

The fetch feature is a thin, self-contained slice of this pane. Remove exactly:

1. **`_WebFetchModeRow`** (lines 443–493) — the whole row widget, including its
   `DesktopSelectDropdown` (`minWidth 168`) and the `webFetchModeChoices` /
   `webFetchFollowLabel` / `effectiveWebFetchMode` helpers from
   `lib/features/search/widgets/web_fetch_mode.dart`.
2. **Its `SectionCard` wrapper** (`sliver` at lines 170–172) **and the 16 px spacer before it**
   (line 169) **and the footer hint block** (lines 173–185, `Padding(12,8,12,0)` +
   `searchServicesPageWebFetchFooter`). After removal the pane is:
   header row (36) → gap 8 → cards (12 gaps) → gap 16 → general-options `SectionCard`.
3. **The capability icon in the card**: the
   `if (WebFetchService.supports(service)) … FileText 14 @0.45 + Tooltip` branch
   (lines 375–385) and its 6 px gap.
4. **Strings to delete from the catalog** (nothing else references them): `searchServicesPageWebFetchModeTitle`,
   `searchServicesPageWebFetchFooter`, `searchServicesPageWebFetchSupported`, plus the eight
   choice strings listed in §6 (`…Follow`, `…FollowValue`, `…FollowSubtitle`, `…Local`,
   `…LocalSubtitle`, `…ProviderSubtitle`, `…Off`, `…OffSubtitle`). Also the unused-but-adjacent
   `searchServicesPageWebFetchSection`.
5. **Imports / services**: `core/services/search/web_fetch_service.dart`,
   `features/search/widgets/web_fetch_mode.dart`, the `WebFetchMode` enum and
   `WebFetchService.supports/supportsType/effectiveMode/resolve` calls. Provider classes that only
   implement `WebFetchCapable` for fetch (Exa MCP's fetch side, Firecrawl/TinyFish/AnySearch's fetch
   side) can keep their **search** fields — only the `fetch()` implementations and the capability
   badge go.
6. **Keep** (fetch-independent): pane title + `Plus`; reorderable cards; brand badge; name;
   4-state connection pill (if DSH keeps a connectivity test); the three action buttons + tooltips;
   `_ToggleRow` (auto-test), both `_StepperRow`s (max results, timeout); all add/edit dialogs,
   multi-key flow, validation; every l10n key not listed in (4).

If DSH later gains its own page-reader setting, the removed slot is exactly the seam: one
`SectionCard` with one 15 px row (`icon 36/18` + label + trailing control) plus an optional
12 px footer hint.

---

## 9. Mobile equivalent (differences, brief)

There is **no** mobile search-services surface under `lib/features/settings/`; the mobile version is
`lib/features/search/pages/search_services_page.dart` (+ `search_service_editor_page.dart`,
`search_api_keys_page.dart`). Differences:

- `Scaffold` + `AppBar` (back `ArrowLeft`, title `searchServicesPageTitle`, `Plus` action) instead of
  the inline 36 px header row.
- Section headers (`搜索提供商` / `网页抓取` / `通用选项`, 13px/w600/onSurface@0.8) with
  `Padding(12, 18, 12, 6)`; desktop has no section headers.
- All services live in **one** `SectionCard` as flat rows (`_iosProviderRow` + `_iosDivider`), not
  per-card boxes; tapping a row opens a **full editor page** (not a dialog); no drag-to-reorder,
  no selection-by-tap (selection handled elsewhere).
- Web-fetch mode is a **full-width row with right-aligned value + `ChevronRight`** that opens an
  option sheet, versus the desktop inline dropdown.
- Add/edit are pages with cancel + save buttons; delete has a confirmation dialog
  (`searchServiceEditorDeleteTitle` / `…DeleteMessage`), which desktop lacks.
- Same status-pill semantics/colors, same multi-key management strings.

---

## Appendix A — quick port checklist

- [ ] 960 max-width centred column, padding `16 12 16 24`.
- [ ] 36 px header: title 14/400/onSurface@.9 + 28 px `Plus` (hover `onSurface@.05`).
- [ ] Card: 18r, 1 px border (black@.08 / white@.12 → primary@.45/.35 on hover/selected),
      14 padding, min-height 64, badge 24, name 16/700, pill 11/600 h8/v2, three 28 px icon buttons.
- [ ] 12 px between cards; 28 px before the general section; 16 px after footer/rows.
- [ ] `SectionCard` 12r + hairline border 0.6 px + 4 px vertical padding; `_divider`
      6 px tall / 0.6 px / inset 12 / outlineVariant@.18.
- [ ] Toggle row and stepper row `h12/v11`, icon column exactly 36 wide / icon 18, gap 12, label 15.
- [ ] Stepper: 28×28 r8 buttons (hover onSurface@.07 light / .10 dark, disabled icon @.4),
      42 px value box, 8 px gaps.
- [ ] Dialogs 420 / 480 / 440(×520 max) wide, 16r, inset 20/18, padding `16 12 16 58`, footer button
      bottom-right 12/12, type dropdown (not chips, no search filter) trigger r10 + overlay r12.
- [ ] Inputs: fill `--surface-fill`, 12r, 0.8 px outlineVariant@.2, focus primary@.45 1 px,
      padding 12/12.
- [ ] Multi-key tile `h12/v10`, 12r, fill surfaceFill, 0.8 px @.2, KeyRound primary, count right.
- [ ] All strings from §6; only Brave max-tokens has validation; delete silently no-ops at 1 item.
- [ ] No spinner anywhere; "Testing…" is a pill state only.
