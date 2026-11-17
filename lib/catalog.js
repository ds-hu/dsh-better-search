/**
 * Provider descriptor table — the single source of truth for the panel UI and the
 * Host registry.
 *
 * Every entry describes one search provider type ported from Kelivo
 * (`lib/core/services/search/search_service.dart`). The browser half renders the
 * add/edit form from this table; `lib/search/index.js` switches on `type` to pick
 * the matching adapter.
 *
 * Field conventions:
 * - `auth`      — how the credential is sent (`bearer`, `x-api-key`,
 *                 `x-api-key-lower`, `x-subscription-token`, `basic`, `none`).
 * - `key`       — `required`, `optional`, or `none`.
 * - `url`       — default endpoint. When `urlField` is true the panel shows an
 *                 optional "自定义 URL" input; `searxng` requires it.
 * - `extras`    — extra form fields, stored in `service.options`.
 * - `answer`    — the provider can return generator answer text in `content`.
 * - `fetch`     — Kelivo supported web fetch for this type. The DSH port does not
 *                 implement fetch; kept for documentation only.
 *
 * @module @ds-hu/dsh-better-search/lib/catalog
 */

/**
 * @typedef {object} ExtraField
 * @property {string} key - storage key inside `service.options`.
 * @property {string} zh - Chinese label.
 * @property {string} en - English label.
 * @property {'text'|'password'|'number'} [kind] - input kind; defaults to `text`.
 * @property {string} [placeholder] - hint text.
 * @property {string} [value] - default value.
 */

/**
 * @typedef {object} ProviderDescriptor
 * @property {string} type - persisted type id (Kelivo's `type` string).
 * @property {string} zh - Chinese display name.
 * @property {string} en - English display name.
 * @property {string|null} brand - file name under `assets/brands/`.
 * @property {'bearer'|'x-api-key'|'x-api-key-lower'|'x-subscription-token'|'basic'|'none'} auth
 * @property {'required'|'optional'|'none'} key
 * @property {string} url - default endpoint.
 * @property {boolean} [urlField] - surface a "自定义 URL" input.
 * @property {boolean} [urlRequired] - the URL input is mandatory (searxng).
 * @property {string} [keyLabel] - override for the key field label.
 * @property {boolean} [answer] - may return answer text.
 * @property {boolean} [fetch] - Kelivo fetch capability (not ported).
 * @property {ExtraField[]} [extras] - additional form fields.
 * @property {{zh: string, en: string}} [hint] - dialog helper text.
 */

/** @type {ProviderDescriptor[]} */
export const PROVIDERS = [
  {
    type: 'bing_local',
    zh: 'Bing（Local）',
    en: 'Bing (Local)',
    brand: 'bing-color.svg',
    auth: 'none',
    key: 'none',
    url: 'https://www.bing.com',
    hint: { zh: '抓取 Bing 网页结果，无需配置。', en: 'Scrapes Bing web results; no configuration.' },
  },
  {
    type: 'duckduckgo',
    zh: 'DuckDuckGo',
    en: 'DuckDuckGo',
    brand: 'duckduckgo-color.svg',
    auth: 'none',
    key: 'none',
    url: 'https://duckduckgo.com',
    extras: [{ key: 'region', zh: '地区（可选）', en: 'Region (optional)', placeholder: 'cn-zh' }],
    hint: { zh: '抓取 DuckDuckGo 网页结果，无需 API Key。', en: 'Scrapes DuckDuckGo results; no API key.' },
  },
  {
    type: 'tavily',
    zh: 'Tavily',
    en: 'Tavily',
    brand: 'tavily-color.svg',
    auth: 'bearer',
    key: 'required',
    url: 'https://api.tavily.com',
    urlField: true,
    answer: true,
    fetch: true,
    hint: { zh: '专为 AI 设计的搜索 API，可返回 answer。', en: 'AI-oriented search API that may return an answer.' },
  },
  {
    type: 'exa',
    zh: 'Exa',
    en: 'Exa',
    brand: 'exa-color.svg',
    auth: 'bearer',
    key: 'required',
    url: 'https://api.exa.ai',
    urlField: true,
    fetch: true,
    extras: [
      {
        key: 'searchType',
        zh: '搜索类型',
        en: 'Search type',
        kind: 'text',
        placeholder: 'auto / keyword / neural',
        value: 'auto',
      },
    ],
  },
  {
    type: 'zhipu',
    zh: '智谱',
    en: 'Zhipu AI',
    brand: 'zhipu-color.svg',
    auth: 'bearer',
    key: 'required',
    url: 'https://open.bigmodel.cn/api/paas/v4/web_search',
  },
  {
    type: 'searxng',
    zh: 'SearXNG',
    en: 'SearXNG',
    brand: 'searxng-color.svg',
    auth: 'basic',
    key: 'optional',
    url: '',
    urlField: true,
    urlRequired: true,
    keyLabel: '用户名 / 密码（可选）',
    extras: [
      { key: 'engines', zh: '引擎（可选）', en: 'Engines (optional)', placeholder: 'google,bing' },
      { key: 'language', zh: '语言（可选）', en: 'Language (optional)', placeholder: 'zh-CN' },
      { key: 'username', zh: '用户名（可选）', en: 'Username (optional)' },
      { key: 'password', zh: '密码（可选）', en: 'Password (optional)', kind: 'password' },
    ],
    hint: { zh: '自建实例，必须填写实例地址（含 /search 前的路径）。', en: 'Self-hosted instance; the base URL is required.' },
  },
  {
    type: 'linkup',
    zh: 'LinkUp',
    en: 'LinkUp',
    brand: 'linkup.svg',
    auth: 'bearer',
    key: 'required',
    url: 'https://api.linkup.so/v1/search',
    answer: true,
    fetch: true,
  },
  {
    type: 'brave',
    zh: 'Brave Search',
    en: 'Brave',
    brand: 'brave-color.svg',
    auth: 'x-subscription-token',
    key: 'required',
    url: 'https://api.search.brave.com/res/v1/web/search',
    extras: [
      { key: 'country', zh: '国家（可选）', en: 'Country (optional)', placeholder: 'CN' },
      { key: 'mode', zh: '模式', en: 'Mode', kind: 'text', placeholder: 'web / llm_context', value: 'web' },
    ],
  },
  {
    type: 'metaso',
    zh: '秘塔',
    en: 'Metaso',
    brand: 'metaso-color.svg',
    auth: 'bearer',
    key: 'required',
    url: 'https://metaso.cn/api/v1/search',
    fetch: true,
  },
  {
    type: 'ollama',
    zh: 'Ollama',
    en: 'Ollama',
    brand: 'ollama.svg',
    auth: 'bearer',
    key: 'required',
    url: 'https://ollama.com/api/web_search',
    fetch: true,
  },
  {
    type: 'deepseek',
    zh: 'DeepSeek',
    en: 'DeepSeek',
    brand: 'deepseek-color.svg',
    auth: 'bearer',
    key: 'required',
    url: 'https://api.deepseek.com',
    fetch: true,
  },
  {
    type: 'jina',
    zh: 'Jina',
    en: 'Jina',
    brand: 'jina-color.svg',
    auth: 'bearer',
    key: 'required',
    url: 'https://s.jina.ai',
    urlField: true,
    fetch: true,
  },
  {
    type: 'perplexity',
    zh: 'Perplexity',
    en: 'Perplexity',
    brand: 'perplexity-color.svg',
    auth: 'bearer',
    key: 'required',
    url: 'https://api.perplexity.ai/search',
    answer: true,
  },
  {
    type: 'bocha',
    zh: '博查',
    en: 'Bocha',
    brand: 'bocha-color.svg',
    auth: 'bearer',
    key: 'required',
    url: 'https://api.bochaai.com/v1/web-search',
  },
  {
    type: 'doubao',
    zh: '豆包',
    en: 'Doubao',
    brand: 'doubao-color.svg',
    auth: 'bearer',
    key: 'required',
    url: 'https://open.feedcoopapi.com/search_api/web_search',
  },
  {
    type: 'serper',
    zh: 'Serper',
    en: 'Serper',
    brand: 'serper.svg',
    auth: 'x-api-key',
    key: 'required',
    url: 'https://google.serper.dev/search',
    extras: [
      { key: 'gl', zh: '国家代码（可选）', en: 'Country code (optional)', placeholder: 'cn' },
      { key: 'hl', zh: '语言代码（可选）', en: 'Language code (optional)', placeholder: 'zh-cn' },
    ],
  },
  {
    type: 'querit',
    zh: 'Querit',
    en: 'Querit',
    brand: 'querit-color.svg',
    auth: 'bearer',
    key: 'required',
    url: 'https://api.querit.ai/v1/search',
    fetch: true,
  },
  {
    type: 'grok',
    zh: 'Grok',
    en: 'Grok',
    brand: 'grok.svg',
    auth: 'bearer',
    key: 'required',
    url: 'https://api.x.ai/v1/responses',
    urlField: true,
    answer: true,
    extras: [
      { key: 'model', zh: '模型（可选）', en: 'Model (optional)', placeholder: 'grok-4-fast' },
      { key: 'reasoningEffort', zh: '推理强度（可选）', en: 'Reasoning effort (optional)', placeholder: 'low' },
    ],
  },
  {
    type: 'stepfun',
    zh: 'StepFun',
    en: 'StepFun',
    brand: 'stepfun.svg',
    auth: 'bearer',
    key: 'required',
    url: 'https://api.stepfun.com/v1/search',
    urlField: true,
  },
  {
    type: 'firecrawl',
    zh: 'Firecrawl',
    en: 'Firecrawl',
    brand: 'firecrawl-color.svg',
    auth: 'bearer',
    key: 'optional',
    url: 'https://api.firecrawl.dev/v2/search',
    urlField: true,
    fetch: true,
  },
  {
    type: 'tinyfish',
    zh: 'TinyFish',
    en: 'TinyFish',
    brand: 'tinyfish-color.svg',
    auth: 'x-api-key',
    key: 'required',
    url: 'https://api.search.tinyfish.ai',
    urlField: true,
    fetch: true,
  },
  {
    type: 'anysearch',
    zh: 'AnySearch',
    en: 'AnySearch',
    brand: 'anysearch.svg',
    auth: 'bearer',
    key: 'optional',
    url: 'https://api.anysearch.com/v1/search',
    urlField: true,
    fetch: true,
  },
  {
    type: 'kagi',
    zh: 'Kagi',
    en: 'Kagi',
    brand: 'kagi-color.svg',
    auth: 'bearer',
    key: 'required',
    url: 'https://kagi.com/api/v0/search',
  },
  {
    type: 'parallel',
    zh: 'Parallel',
    en: 'Parallel',
    brand: 'parallel.svg',
    auth: 'x-api-key-lower',
    key: 'required',
    url: 'https://api.parallel.ai/v1beta/search',
    fetch: true,
    extras: [
      { key: 'mode', zh: '模式', en: 'Mode', kind: 'text', placeholder: 'advanced', value: 'advanced' },
    ],
  },
  {
    type: 'kimi',
    zh: 'Kimi',
    en: 'Kimi',
    brand: 'kimi-color.svg',
    auth: 'bearer',
    key: 'required',
    url: 'https://api.moonshot.cn/v1/search',
  },
  {
    type: 'you',
    zh: 'You.com',
    en: 'You.com',
    brand: 'you.svg',
    auth: 'x-api-key',
    key: 'required',
    url: 'https://ydc-index.io/v1/search',
    fetch: true,
    extras: [
      {
        key: 'contentMode',
        zh: '内容模式',
        en: 'Content mode',
        kind: 'text',
        placeholder: 'highlights / text',
        value: 'highlights',
      },
    ],
  },
];

/** Fast lookup by type id. @type {Map<string, ProviderDescriptor>} */
export const PROVIDERS_BY_TYPE = new Map(PROVIDERS.map((entry) => [entry.type, entry]));

/**
 * Look one provider descriptor up.
 * @param {string} type - persisted type id.
 * @returns {ProviderDescriptor|undefined} the descriptor.
 */
export function providerOf(type) {
  return PROVIDERS_BY_TYPE.get(type);
}
