window.__ModuleLoader__.load({
	id: "@ds-hu/dsh-better-search",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const { useState, useEffect, useRef, useCallback, useMemo } = react;
		const h = react.createElement;

		const NS = "betterSearch";
		const API_BASE = "/better-search/api";
		const PANEL_ID = "better-search";
		const POLL_MS = 4000;
		const CSS_TAG = "@ds-hu/dsh-better-search";
		const ROUTE_PLUGIN = "@ds-hu/dsh-better-search";
		const DEFAULT_LIMITS = {
			maxResults: { min: 1, max: 50 },
			timeoutMs: { min: 1000, max: 300000 },
		};

		/* ================================================================ */
		/* runtime state shared with the disposer                            */
		/* ================================================================ */

		/** The locale translator; tests may swap it through setTestRuntime. */
		let tt = (key) => key;
		/** Current browser plugin context, used by helpers that read the locale. */
		let appCtx = null;
		/** The stylesheet node this module owns, if it has mounted one. */
		let cssTag = null;
		/** Provider descriptors cached across panel mounts. */
		let catalogCache = null;
		/** Every interval this module owns, so disposal can never leak one. */
		const timers = new Set();
		/** Every fetch controller this module owns, so disposal aborts them. */
		const liveRequests = new Set();

		function t(key, params) {
			const raw = tt(key, params);
			if (raw === key && params) {
				let out = key;
				for (const name of Object.keys(params)) out = out.split("{" + name + "}").join(String(params[name]));
				return out;
			}
			return raw;
		}

		function currentLang() {
			try {
				const locale = appCtx && appCtx.locale;
				const snapshot = locale && typeof locale.getLocale === "function" ? locale.getLocale() : undefined;
				const active = snapshot && typeof snapshot.active === "string" ? snapshot.active : undefined;
				if (active !== undefined && active.toLowerCase().startsWith("en")) return "en";
			} catch {
				/* fall through to the plugin default */
			}
			return "zh";
		}

		/**
		 * Swap the module-level runtime for tests.
		 * @param {any} ctx - fake context with a `locale` service.
		 * @param {(key: string, params?: object) => string} translate - translate function.
		 * @returns {() => void} restores the previous runtime.
		 */
		function setTestRuntime(ctx, translate) {
			const previous = { ctx: appCtx, translate: tt };
			appCtx = ctx;
			tt = translate;
			return () => {
				appCtx = previous.ctx;
				tt = previous.translate;
			};
		}

		function disposeRuntime() {
			for (const timer of timers) clearInterval(timer);
			timers.clear();
			for (const controller of liveRequests) {
				try {
					controller.abort();
				} catch {
					/* an aborted controller cannot fail twice */
				}
			}
			liveRequests.clear();
		}

		/* ================================================================ */
		/* small utilities                                                   */
		/* ================================================================ */

		function cx() {
			let out = "";
			for (let index = 0; index < arguments.length; index += 1) {
				const part = arguments[index];
				if (part) out += (out === "" ? "" : " ") + part;
			}
			return out;
		}

		function isAbortError(failure) {
			return Boolean(failure && (failure.name === "AbortError" || failure.code === 20));
		}

		function isDocumentHidden() {
			return typeof document !== "undefined" && document.visibilityState === "hidden";
		}

		function clamp(value, min, max) {
			if (!Number.isFinite(value)) return min;
			if (value < min) return min;
			if (value > max) return max;
			return value;
		}

		function hasOwn(object, key) {
			return object !== null && object !== undefined && Object.prototype.hasOwnProperty.call(object, key);
		}

		/**
		 * One JSON call to the Host API.
		 * @param {string} path - path below API_BASE.
		 * @param {{ method?: string, body?: any, signal?: AbortSignal }} [options] - request options.
		 * @returns {Promise<any>} the parsed answer.
		 */
		async function apiFetch(path, options) {
			const opts = options || {};
			const request = {
				method: opts.method || "GET",
				headers: { Accept: "application/json" },
				signal: opts.signal,
			};
			if (opts.body !== undefined) {
				request.headers["Content-Type"] = "application/json";
				request.body = JSON.stringify(opts.body);
			}
			const response = await fetch(API_BASE + path, request);
			let payload = null;
			try {
				payload = await response.json();
			} catch {
				/* a non-JSON body is reported through the status code */
			}
			if (!response.ok || (payload && payload.ok === false)) {
				const message = (payload && (payload.error || payload.code)) || "HTTP " + response.status;
				const failure = new Error(message);
				failure.status = response.status;
				failure.code = payload && payload.code;
				failure.field = payload && payload.field;
				throw failure;
			}
			return payload;
		}

		function apiMutate(method, path, body) {
			return apiFetch(path, { method, body });
		}

		function servicePath(service) {
			return "/services/" + encodeURIComponent(service && service.id !== undefined ? service.id : "");
		}

		function errorMessage(failure) {
			if (!failure) return "request failed";
			if (typeof failure.message === "string" && failure.message !== "") return failure.message;
			return "request failed";
		}

		/**
		 * First visible character of a display name, used when no brand asset exists.
		 * @param {string} name - display name.
		 * @returns {string} one upper-cased character, or "?".
		 */
		function letterOf(name) {
			const text = typeof name === "string" ? name.trim() : "";
			if (text === "") return "?";
			const first = Array.from(text)[0];
			return typeof first === "string" && first !== "" ? first.toUpperCase() : "?";
		}

		function brandUrlOf(brand) {
			if (typeof brand !== "string" || brand === "") return "";
			return API_BASE + "/brand/" + encodeURIComponent(brand);
		}

		/* ================================================================ */
		/* dictionaries                                                      */
		/* ================================================================ */

		const zh = {
			"panel": "搜索服务",
			"searchServicesPageTitle": "搜索服务",
			"searchServicesPageAddProvider": "添加提供商",
			"searchServicesPageTestingStatus": "测试中…",
			"searchServicesPageConnectedStatus": "已连接",
			"searchServicesPageFailedStatus": "连接失败",
			"searchServicesPageNotTestedStatus": "未测试",
			"searchServicesPageEditServiceTooltip": "编辑服务",
			"searchServicesPageTestConnectionTooltip": "测试连接",
			"searchServicesPageDeleteServiceTooltip": "删除服务",
			"searchServicesPageAutoTestTitle": "启动时自动测试连接",
			"searchServicesPageMaxResults": "最大结果数",
			"searchServicesPageTimeoutSeconds": "超时时间（秒）",
			"searchServicesAddDialogTitle": "添加搜索服务",
			"searchServicesAddDialogAdd": "添加",
			"searchServicesAddDialogInstanceUrl": "实例 URL",
			"searchServicesAddDialogServiceType": "服务商类型",
			"searchServicesAddDialogUrlRequired": "请填写实例 URL。",
			"searchServicesAddDialogApiKeyRequired": "请输入 API Key。",
			"dialog.catalogEmpty": "宿主持久化目录里没有可添加的服务商类型。",
			"searchServicesEditDialogSave": "保存",
			"searchServicesDialogApiKey": "API Key",
			"searchServicesDialogApiKeyOptional": "API Key（可选）",
			"searchServicesFieldCustomUrlOptional": "自定义 URL（可选）",
			"searchServiceEditorMultiKeyTitle": "多 Key 轮询",
			"searchServiceEditorMultiKeyNone": "未配置",
			"searchServiceEditorMultiKeyCount": "共 {count} 个 Key",
			"searchServiceEditorMultiKeyCountOne": "共 {count} 个 Key",
			"searchApiKeysPageDescription": "列表中的 Key 按顺序轮询使用，第一个为主 Key；不查额度，以防触发服务商风控。",
			"searchApiKeysPagePrimaryBadge": "主",
			"searchApiKeysPageBatchHint": "可一次粘贴多个 Key：每行一个，或用逗号分隔",
			"searchApiKeysPageBatchResult": "已添加 {added} 个，跳过 {skipped} 个重复",
			"searchApiKeysPageAdd": "添加",
			"searchApiKeysPageEmpty": "尚未配置任何 Key。",
			"fetch.pinFailed": "无法固定抓取方式：{message}",
			"searchServicesPageWebFetchModeTitle": "抓取方式",
			"searchServicesPageWebFetchFollow": "跟随搜索服务",
			"searchServicesPageWebFetchOfficial": "仅官方服务",
			"searchServicesPageWebFetchFollowSubtitle": "当前：{name}",
			"searchServicesPageWebFetchProviderSubtitle": "使用该服务商的 API Key 和额度",
			"searchServicesPageWebFetchOfficialSubtitle": "交给 DSH 内置的网页抓取",
			"searchServicesPageWebFetchUnsupported": "当前搜索服务不支持网页抓取",
			"searchServicesPageWebFetchSupported": "支持网页抓取",
			"searchServiceEditorUsageTitle": "账户用量",
			"searchServiceEditorUsageNotQueried": "尚未查询用量。",
			"searchServiceEditorUsageQuery": "查询用量",
			"searchServiceEditorUsageQuerying": "查询中…",
			"searchServiceEditorUsageRemaining": "剩余 {remaining} 额度",
			"searchServiceEditorUsageBalance": "余额 {balance}",
			"searchServiceEditorUsageUsed": "已使用 {used} / {limit} 额度",
			"searchServiceEditorUsageFailed": "用量查询失败：{message}",
			"searchApiKeysPageLoading": "正在读取 Key…",
			"searchApiKeysPageLoadFailed": "无法读取 Key：{message}",
			"keyDialog.reveal": "显示 Key",
			"keyDialog.hide": "隐藏 Key",
			"keyDialog.delete": "删除该 Key",
			"notice.fetchSaved": "已更新抓取方式",
			"notice.fetchFailed": "抓取方式更新失败：{message}",
			"notice.keysFailed": "Key 操作失败：{message}",
			"delete.title": "删除搜索服务",
			"delete.body": "确定删除「{name}」吗？此操作不可撤销。",
			"delete.action": "删除",
			"delete.deleting": "删除中…",
			"common.close": "关闭",
			"common.retry": "重试",
			"common.cancel": "取消",
			"stepper.minus": "减少",
			"stepper.plus": "增加",
			"page.addTooltip": "添加提供商",
			"card.builtin": "内置",
			"card.select": "选择此搜索服务",
			"list.loading": "正在读取搜索服务…",
			"list.error": "无法读取搜索服务：{message}",
			"list.stale": "显示的是上次成功读取的数据。",
			"list.emptyTitle": "还没有第三方搜索服务",
			"list.emptyHint": "添加一个搜索服务商，它就会出现在这里；选中的服务用于模型的 web_search。",
			"list.emptyAction": "添加搜索服务",
			"pin.warn": "无法把搜索提供方固定到宿主：{error}",
			"pin.unknown": "未知错误",
			"page.footerHint": "选中的服务用于模型的 web_search。内置服务不可删除，第三方服务至少保留一个。",
			"notice.dismiss": "关闭提示",
			"notice.selected": "已切换当前搜索服务",
			"notice.saved": "已保存",
			"notice.added": "已添加",
			"notice.deleted": "已删除",
			"notice.reordered": "已更新排序",
			"notice.commonSaved": "已更新通用选项",
			"notice.selectFailed": "切换失败：{message}",
			"notice.saveFailed": "保存失败：{message}",
			"notice.deleteFailed": "删除失败：{message}",
			"notice.reorderFailed": "排序失败：{message}",
			"notice.commonFailed": "更新失败：{message}",
			"notice.testOk": "连接成功（{ms} ms）",
			"notice.testOkNoMs": "连接成功",
			"notice.testFailed": "测试失败：{message}",
			"notice.driftSearch": "官方搜索设置已切换为「{name}」，已同步到本面板。",
			"notice.driftFetch": "官方抓取设置已变更，已同步到本面板。",
			"notice.driftHealed": "检测到失效的检索设置，已恢复为官方服务。",
			"notice.driftForeign": "当前搜索提供方由其他插件设置（{providerId}），本面板未接管。",
			"notice.driftSyncFailed": "同步官方搜索设置失败：{message}",
			"dialog.name": "名称",
			"dialog.keyPlaceholder": "输入 API Key",
			"dialog.keySavedPlaceholder": "已保存，留空则不修改",
			"dialog.keyClear": "清除已保存的 Key",
			"dialog.keyClearUndo": "撤销清除",
			"dialog.catalogLoading": "正在加载服务商目录…",
			"dialog.catalogError": "无法加载服务商目录：{message}",
			"dialog.typeGroup.noKey": "无需 API Key",
			"dialog.typeGroup.key": "API Key",
			"dialog.typeGroup.selfHosted": "自建实例",
			"dialog.editTitle": "编辑搜索服务",
			"dialog.saving": "保存中…",
		};

		const en = {
			"panel": "Search services",
			"searchServicesPageTitle": "Search Services",
			"searchServicesPageAddProvider": "Add provider",
			"searchServicesPageTestingStatus": "Testing…",
			"searchServicesPageConnectedStatus": "Connected",
			"searchServicesPageFailedStatus": "Failed",
			"searchServicesPageNotTestedStatus": "Not tested",
			"searchServicesPageEditServiceTooltip": "Edit Service",
			"searchServicesPageTestConnectionTooltip": "Test Connection",
			"searchServicesPageDeleteServiceTooltip": "Delete Service",
			"searchServicesPageAutoTestTitle": "Auto-test connections on launch",
			"searchServicesPageMaxResults": "Max Results",
			"searchServicesPageTimeoutSeconds": "Timeout (seconds)",
			"searchServicesAddDialogTitle": "Add Search Service",
			"searchServicesAddDialogAdd": "Add",
			"searchServicesAddDialogInstanceUrl": "Instance URL",
			"searchServicesAddDialogServiceType": "Service type",
			"searchServicesAddDialogUrlRequired": "An instance URL is required.",
			"searchServicesAddDialogApiKeyRequired": "Enter an API key.",
			"dialog.catalogEmpty": "The host catalog offers no addable provider types.",
			"searchServicesEditDialogSave": "Save",
			"searchServicesDialogApiKey": "API Key",
			"searchServicesDialogApiKeyOptional": "API Key (optional)",
			"searchServicesFieldCustomUrlOptional": "Custom URL (optional)",
			"searchServiceEditorMultiKeyTitle": "Multi-key rotation",
			"searchServiceEditorMultiKeyNone": "Not configured",
			"searchServiceEditorMultiKeyCount": "{count} keys",
			"searchServiceEditorMultiKeyCountOne": "{count} key",
			"searchApiKeysPageDescription": "Keys rotate in the order listed; the first is the primary key. Usage is not queried to avoid provider rate limiting.",
			"searchApiKeysPagePrimaryBadge": "Primary",
			"searchApiKeysPageBatchHint": "Paste one or more keys — one per line or comma-separated",
			"searchApiKeysPageBatchResult": "Added {added}, skipped duplicates: {skipped}",
			"searchApiKeysPageAdd": "Add",
			"searchApiKeysPageEmpty": "No keys configured yet.",
			"fetch.pinFailed": "Could not pin the fetch provider: {message}",
			"searchServicesPageWebFetchModeTitle": "Read pages with",
			"searchServicesPageWebFetchFollow": "Follow search service",
			"searchServicesPageWebFetchOfficial": "Official only",
			"searchServicesPageWebFetchFollowSubtitle": "Currently: {name}",
			"searchServicesPageWebFetchProviderSubtitle": "Uses this service's API key and quota",
			"searchServicesPageWebFetchOfficialSubtitle": "DSH's built-in fetch provider",
			"searchServicesPageWebFetchUnsupported": "The current search service cannot read pages",
			"searchServicesPageWebFetchSupported": "Can read pages",
			"searchServiceEditorUsageTitle": "Account usage",
			"searchServiceEditorUsageNotQueried": "Usage has not been queried yet.",
			"searchServiceEditorUsageQuery": "Check usage",
			"searchServiceEditorUsageQuerying": "Checking…",
			"searchServiceEditorUsageRemaining": "{remaining} credits remaining",
			"searchServiceEditorUsageBalance": "Balance: {balance}",
			"searchServiceEditorUsageUsed": "{used} of {limit} credits used",
			"searchServiceEditorUsageFailed": "Could not query usage: {message}",
			"searchApiKeysPageLoading": "Reading keys…",
			"searchApiKeysPageLoadFailed": "Cannot read keys: {message}",
			"keyDialog.reveal": "Show key",
			"keyDialog.hide": "Hide key",
			"keyDialog.delete": "Delete this key",
			"notice.fetchSaved": "Fetch provider updated",
			"notice.fetchFailed": "Could not update the fetch provider: {message}",
			"notice.keysFailed": "Key operation failed: {message}",
			"delete.title": "Delete search service",
			"delete.body": "Delete “{name}”? This cannot be undone.",
			"delete.action": "Delete",
			"delete.deleting": "Deleting…",
			"common.close": "Close",
			"common.retry": "Retry",
			"common.cancel": "Cancel",
			"stepper.minus": "Decrease",
			"stepper.plus": "Increase",
			"page.addTooltip": "Add provider",
			"card.builtin": "Built-in",
			"card.select": "Select this search service",
			"list.loading": "Reading search services…",
			"list.error": "Cannot read search services: {message}",
			"list.stale": "Showing the last successful read.",
			"list.emptyTitle": "No third-party search services yet",
			"list.emptyHint": "Add a search provider and it will appear here; the selected service backs the model's web_search.",
			"list.emptyAction": "Add search service",
			"pin.warn": "Could not pin the search provider on the host: {error}",
			"pin.unknown": "Unknown error",
			"page.footerHint": "The selected service backs the model's web_search. Built-in services can't be deleted; keep at least one third-party service.",
			"notice.dismiss": "Dismiss",
			"notice.selected": "Active search service updated",
			"notice.saved": "Saved",
			"notice.added": "Added",
			"notice.deleted": "Deleted",
			"notice.reordered": "Order updated",
			"notice.commonSaved": "Common options updated",
			"notice.selectFailed": "Switch failed: {message}",
			"notice.saveFailed": "Save failed: {message}",
			"notice.deleteFailed": "Delete failed: {message}",
			"notice.reorderFailed": "Reorder failed: {message}",
			"notice.commonFailed": "Update failed: {message}",
			"notice.testOk": "Connection succeeded ({ms} ms)",
			"notice.testOkNoMs": "Connection succeeded",
			"notice.testFailed": "Test failed: {message}",
			"notice.driftSearch": "DSH's web-search settings switched to {name}; the panel is now in sync.",
			"notice.driftFetch": "DSH's fetch provider changed; the panel is now in sync.",
			"notice.driftHealed": "A stale provider selection was found and restored to the shipped service.",
			"notice.driftForeign": "Another plugin owns the current search provider ({providerId}); the panel leaves it alone.",
			"notice.driftSyncFailed": "Could not sync DSH's web-search settings: {message}",
			"dialog.name": "Name",
			"dialog.keyPlaceholder": "Enter API key",
			"dialog.keySavedPlaceholder": "Saved — leave blank to keep it",
			"dialog.keyClear": "Clear saved key",
			"dialog.keyClearUndo": "Undo clear",
			"dialog.catalogLoading": "Loading the provider catalog…",
			"dialog.catalogError": "Cannot load the provider catalog: {message}",
			"dialog.typeGroup.noKey": "No API key",
			"dialog.typeGroup.key": "API Key",
			"dialog.typeGroup.selfHosted": "Self-hosted",
			"dialog.editTitle": "Edit Search Service",
			"dialog.saving": "Saving…",
		};

		/* ================================================================ */
		/* styles                                                            */
		/* ================================================================ */

		const CSS = `
.bs-root{display:flex;flex-direction:column;flex:1;min-height:0;height:100%;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:13px;line-height:1.5;}
.bs-root *{box-sizing:border-box;}
.bs-root button,.bs-root input,.bs-root textarea,.bs-root select{font-family:inherit;}
.bs-root :focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;}
.bs-scroll{flex:1;min-height:0;overflow:auto;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent;scrollbar-gutter:stable;}
.bs-pane{display:flex;flex-direction:column;width:100%;max-width:960px;min-height:100%;margin:0 auto;padding:16px 12px 24px;}
.bs-head{display:flex;flex:none;align-items:center;gap:8px;height:36px;}
.bs-title{flex:1;min-width:0;margin:0;font-size:14px;font-weight:400;line-height:20px;color:color-mix(in srgb,var(--dsw-alias-label-primary) 90%,transparent);}
.bs-iconBtn{display:grid;flex:none;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;}
.bs-iconBtn svg{display:block;width:18px;height:18px;}
.bs-iconBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}
.bs-iconBtn:disabled{opacity:.45;cursor:default;}
.bs-iconBtnSm svg{width:17px;height:17px;}
.bs-iconBtnDanger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);}
.bs-services{display:flex;flex-direction:column;gap:12px;margin:8px 0 0;padding:0;list-style:none;}
.bs-card{position:relative;display:flex;align-items:center;gap:10px;min-height:64px;padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:calc(var(--dsw-radius-md) + 2px);background:var(--dsw-alias-settings-card-fill);cursor:pointer;}
.bs-card:hover,.bs-card[data-selected="true"]{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,transparent);}
.bs-card[data-builtin="true"]{cursor:pointer;}
.bs-card[data-dragging="true"]{opacity:.45;}
.bs-card[data-drop="before"]{box-shadow:0 2px 0 0 var(--dsw-alias-state-business-primary);}
.bs-card[data-drop="after"]{box-shadow:0 -2px 0 0 var(--dsw-alias-state-business-primary);}
.bs-badge{display:grid;flex:none;place-items:center;width:24px;height:24px;border-radius:50%;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent);color:var(--dsw-alias-state-business-primary);overflow:hidden;}
.bs-badge img{display:block;width:15px;height:15px;object-fit:contain;}
.bs-badgeLetter{font-size:10px;font-weight:700;line-height:1;}
.bs-name{display:flex;flex:1 1 auto;align-items:center;gap:6px;min-width:0;overflow:hidden;font-size:16px;font-weight:700;line-height:22px;}
.bs-nameText{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.bs-tag{flex:none;font-size:10px;font-style:normal;font-weight:600;letter-spacing:.02em;line-height:15px;color:color-mix(in srgb,var(--dsw-alias-label-primary) 45%,transparent);}
.bs-pill{flex:none;padding:2px 8px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent);color:color-mix(in srgb,var(--dsw-alias-label-primary) 70%,transparent);font-size:11px;font-weight:600;line-height:1.45;white-space:nowrap;}
.bs-pill[data-state="ok"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent);color:var(--dsw-alias-state-success-primary);}
.bs-pill[data-state="fail"]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-primary);}
.bs-pill[data-state="test"]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent);color:var(--dsw-alias-state-business-primary);}
.bs-actions{display:flex;flex:none;align-items:center;gap:6px;margin-left:8px;}
.bs-sectionCard{margin-top:28px;padding:4px 0;border:.6px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-settings-card-fill);}
.bs-row{display:flex;align-items:center;gap:12px;padding:11px 12px;}
.bs-row+.bs-row{box-shadow:inset 0 7px 0 -6.4px var(--dsw-alias-border-l3);}
.bs-rowIcon{display:grid;flex:none;place-items:center;width:36px;color:color-mix(in srgb,var(--dsw-alias-label-primary) 90%,transparent);}
.bs-rowIcon svg{display:block;width:18px;height:18px;}
.bs-rowLabel{flex:1;min-width:0;font-size:15px;line-height:22px;color:color-mix(in srgb,var(--dsw-alias-label-primary) 90%,transparent);}
.bs-rowValue{width:42px;text-align:center;font-size:14px;font-variant-numeric:tabular-nums;color:color-mix(in srgb,var(--dsw-alias-label-primary) 90%,transparent);}
.bs-stepper{display:flex;flex:none;align-items:center;gap:8px;}
.bs-stepBtn{display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font-size:16px;line-height:1;cursor:pointer;}
.bs-stepBtn svg{width:16px;height:16px;}
.bs-stepBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}
.bs-stepBtn:disabled{opacity:.4;cursor:default;}
.bs-switch{position:relative;flex:none;width:36px;height:20px;padding:0;border:0;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent);cursor:pointer;transition:background .22s cubic-bezier(.2,.7,.3,1);}
.bs-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-switch-thumb);box-shadow:0 1px 2px var(--dsw-alias-bg-mask-2);transition:transform .22s cubic-bezier(.2,.7,.3,1);}
.bs-switch[aria-checked="true"]{background:var(--dsw-alias-state-business-primary);}
.bs-switch[aria-checked="true"]::after{transform:translateX(16px);}
.bs-switch:disabled{opacity:.5;cursor:default;}
.bs-hint{margin:16px 0 0;padding:0;font-size:12px;line-height:1.4;color:color-mix(in srgb,var(--dsw-alias-label-primary) 55%,transparent);}
.bs-banner{display:flex;flex:none;align-items:flex-start;gap:8px;margin:8px 0 0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-fill-l1,var(--dsw-alias-bg-module-platform));font-size:12.5px;line-height:18px;}
.bs-banner[data-kind="error"]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--dsw-alias-state-error-primary);}
.bs-banner[data-kind="warn"]{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 32%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent);color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary));}
.bs-banner[data-kind="ok"]{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 28%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);color:var(--dsw-alias-state-success-primary);}
.bs-bannerText{flex:1;min-width:0;overflow-wrap:anywhere;}
.bs-bannerDismiss{flex:none;display:grid;place-items:center;width:20px;height:20px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:inherit;opacity:.75;cursor:pointer;}
.bs-bannerDismiss:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover);}
.bs-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:8px 16px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;font-weight:600;line-height:18px;white-space:nowrap;cursor:pointer;}
.bs-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}
.bs-btn:disabled{opacity:.5;cursor:default;}
.bs-btnFilled{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);}
.bs-btnFilled:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);}
.bs-btnDanger{color:var(--dsw-alias-state-error-primary);}
.bs-btnDanger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);}
.bs-btnSm{padding:4px 10px;border-radius:var(--dsw-radius-sm);font-size:12px;font-weight:500;line-height:18px;}
.bs-empty{display:flex;flex-direction:column;align-items:center;gap:10px;margin:8px 0 0;padding:40px 24px;border:1px dashed var(--dsw-alias-border-l3);border-radius:calc(var(--dsw-radius-md) + 2px);background:var(--dsw-alias-settings-card-fill);text-align:center;}
.bs-emptyGlyph{display:flex;align-items:center;justify-content:center;width:64px;height:64px;border-radius:50%;background:var(--dsw-alias-fill-l2,var(--dsw-alias-bg-module-platform));color:var(--dsw-alias-label-tertiary);}
.bs-emptyTitle{margin:0;font-size:15px;font-weight:600;line-height:22px;}
.bs-emptyHint{max-width:420px;margin:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-tertiary);}
.bs-empty .bs-btn{margin-top:4px;}
.bs-loading{display:flex;flex-direction:column;gap:12px;margin-top:8px;}
.bs-skelCard{height:64px;border:1px solid var(--dsw-alias-settings-card-stroke);border-radius:calc(var(--dsw-radius-md) + 2px);background:var(--dsw-alias-bg-skeleton);}
.bs-overlay{position:fixed;inset:0;z-index:80;display:grid;place-items:center;padding:20px 18px;background:var(--dsw-alias-bg-mask-1);}
.bs-dialog{position:relative;width:min(420px,100%);max-height:min(560px,100%);padding:12px 16px 0;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1));box-shadow:var(--dsw-elevation-prominent);overflow:hidden;display:flex;flex-direction:column;}
.bs-dialog[data-size="edit"]{width:min(480px,calc(100% - 32px));max-height:min(780px,calc(100% - 32px));}
.bs-dialogHead{display:flex;flex:none;align-items:center;gap:8px;}
.bs-dialogTitle{flex:1;min-width:0;margin:0;font-size:14px;font-weight:700;line-height:20px;}
.bs-dialogBody{display:flex;flex-direction:column;flex:1 1 auto;gap:12px;min-height:0;margin-top:8px;padding-bottom:8px;overflow:auto;overscroll-behavior:contain;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent;}
.bs-dialogFoot{display:flex;flex:none;justify-content:flex-end;gap:8px;padding:10px 0 12px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1));}
.bs-dialogError{margin:0;padding:8px 10px;border-radius:var(--dsw-radius-sm);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;}
.bs-field{display:flex;flex-direction:column;gap:6px;min-width:0;}
.bs-fieldLabel{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}
.bs-input,.bs-textarea{width:100%;padding:10px 12px;border:.8px solid color-mix(in srgb,var(--dsw-alias-label-primary) 20%,transparent);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-fill-l1,var(--dsw-alias-bg-module-platform));color:var(--dsw-alias-label-primary);font:inherit;font-size:15px;line-height:22px;}
.bs-input:hover,.bs-textarea:hover{border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 28%,transparent);}
.bs-input:focus,.bs-textarea:focus{outline:none;border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 60%,transparent);}
.bs-input[aria-invalid="true"],.bs-textarea[aria-invalid="true"]{border-color:var(--dsw-alias-state-error-primary);}
.bs-input::placeholder,.bs-textarea::placeholder{color:color-mix(in srgb,var(--dsw-alias-label-primary) 45%,transparent);}
.bs-textarea{min-height:76px;resize:vertical;font-size:13px;line-height:1.5;}
.bs-fieldError{margin:0;font-size:11.5px;line-height:16px;color:var(--dsw-alias-state-error-primary);}
.bs-fieldHint{margin:0;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary);}
.bs-select{position:relative;min-width:0;}
.bs-selectTrigger{display:flex;align-items:center;gap:8px;width:100%;padding:9px 12px;border:.8px solid color-mix(in srgb,var(--dsw-alias-label-primary) 20%,transparent);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-fill-l1,var(--dsw-alias-bg-module-platform));color:color-mix(in srgb,var(--dsw-alias-label-primary) 90%,transparent);font:inherit;font-size:14.5px;line-height:22px;text-align:left;cursor:pointer;}
.bs-selectTrigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}
.bs-selectTrigger:disabled{opacity:.5;cursor:default;}
.bs-selectTrigger .bs-badge{width:20px;height:20px;}
.bs-selectTrigger .bs-badge img{width:13px;height:13px;}
.bs-selectLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.bs-chev{flex:none;display:inline-flex;color:var(--dsw-alias-label-tertiary);transition:transform .18s ease;}
.bs-select[data-open="true"] .bs-chev{transform:rotate(180deg);}
.bs-menu{position:fixed;z-index:90;margin:0;padding:6px;overflow:auto;list-style:none;border:.6px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1));box-shadow:var(--dsw-elevation-prominent);scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent;}
.bs-menuGroupWrap{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none;}
.bs-menuGroupWrap+.bs-menuGroupWrap{margin-top:4px;}
.bs-menuGroup{padding:6px 8px 2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);}
.bs-typeRow{display:flex;align-items:center;gap:10px;width:100%;padding:7px 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:color-mix(in srgb,var(--dsw-alias-label-primary) 88%,transparent);font:inherit;font-size:14px;line-height:20px;text-align:left;cursor:pointer;}
.bs-typeRow:hover{background:var(--dsw-alias-interactive-bg-hover);}
.bs-typeRow[data-active="true"]{color:var(--dsw-alias-state-business-primary);font-weight:600;}
.bs-typeName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.bs-typeCheck{display:inline-flex;flex:none;width:16px;height:16px;color:var(--dsw-alias-state-business-primary);opacity:0;}
.bs-typeRow[data-active="true"] .bs-typeCheck{opacity:1;}
.bs-keyTile{display:flex;align-items:center;gap:10px;width:100%;padding:10px 12px;border:.8px solid color-mix(in srgb,var(--dsw-alias-label-primary) 20%,transparent);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-fill-l1,var(--dsw-alias-bg-module-platform));color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer;}
.bs-keyTile:hover{background:var(--dsw-alias-interactive-bg-hover);}
.bs-keyTileIcon{display:inline-flex;flex:none;color:var(--dsw-alias-state-business-primary);}
.bs-keyTileTitle{flex:1;min-width:0;font-size:13px;font-weight:600;line-height:20px;}
.bs-keyTileCount{flex:none;font-size:12.5px;line-height:18px;color:var(--dsw-alias-state-business-primary);}
.bs-keyTileCount[data-empty="true"]{color:color-mix(in srgb,var(--dsw-alias-label-primary) 55%,transparent);}
.bs-keyPanel{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-fill-l1,var(--dsw-alias-bg-module-platform));}
.bs-keyList{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none;}
.bs-keyRow{display:flex;align-items:center;gap:8px;min-width:0;font-size:13px;line-height:18px;}
.bs-keyMask{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:color-mix(in srgb,var(--dsw-alias-label-primary) 88%,transparent);}
.bs-keyBadge{flex:none;padding:1px 5px;border-radius:5px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent);color:var(--dsw-alias-state-business-primary);font-size:10px;font-weight:600;line-height:15px;}
.bs-keyEmpty{margin:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-tertiary);}
.bs-keyActions{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;}
.bs-keyRow .bs-iconBtn{width:24px;height:24px;color:var(--dsw-alias-label-tertiary);}
.bs-keyRow .bs-iconBtn svg{width:15px;height:15px;}
.bs-keyRow .bs-iconBtn:hover{color:var(--dsw-alias-label-primary);}
.bs-confirmText{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);}
.bs-confirmName{color:var(--dsw-alias-label-primary);font-weight:600;}
.bs-inlineButtons{display:inline-flex;align-items:center;gap:6px;}
.bs-keyTile[aria-expanded="true"] .bs-chev{transform:rotate(90deg);}
.bs-fetchBadge{display:inline-flex;flex:none;align-items:center;color:color-mix(in srgb,var(--dsw-alias-label-primary) 45%,transparent);}
.bs-fetchBadge svg{display:block;width:14px;height:14px;}
.bs-fetchRow{padding:8px 12px;}
.bs-fetchSelect{position:relative;flex:none;}
.bs-fetchTrigger{display:inline-flex;align-items:center;gap:8px;min-width:168px;max-width:240px;min-height:34px;padding:6px 11px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent);border-radius:10px;background:var(--dsw-alias-fill-l2,var(--dsw-alias-bg-module-platform));color:color-mix(in srgb,var(--dsw-alias-label-primary) 88%,transparent);font:inherit;font-size:14px;line-height:20px;cursor:pointer;}
.bs-fetchTrigger:hover{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,transparent);}
.bs-fetchSelect[data-open="true"] .bs-fetchTrigger{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent);}
.bs-fetchTrigger:disabled{opacity:.5;cursor:default;}
.bs-fetchTriggerLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;}
.bs-fetchTrigger .bs-chev{color:color-mix(in srgb,var(--dsw-alias-label-primary) 70%,transparent);}
.bs-fetchSelect[data-open="true"] .bs-chev{transform:rotate(180deg);}
.bs-modeRow{display:flex;align-items:center;gap:10px;width:100%;min-height:32px;padding:6px 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:color-mix(in srgb,var(--dsw-alias-label-primary) 88%,transparent);font:inherit;text-align:left;cursor:pointer;}
.bs-modeRow:hover{background:var(--dsw-alias-interactive-bg-hover);}
.bs-modeRow[data-selected="true"]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent);}
.bs-modeMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;}
.bs-modeLabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:20px;}
.bs-modeRow[data-selected="true"] .bs-modeLabel{font-weight:600;}
.bs-modeSub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;line-height:17px;color:color-mix(in srgb,var(--dsw-alias-label-primary) 60%,transparent);}
.bs-modeCheck{display:inline-flex;flex:none;color:var(--dsw-alias-state-business-primary);opacity:0;}
.bs-modeRow[data-selected="true"] .bs-modeCheck{opacity:1;}
.bs-fetchNotes{padding:0 12px 8px 60px;}
.bs-fetchNote{margin:0;font-size:12px;line-height:1.4;color:color-mix(in srgb,var(--dsw-alias-label-primary) 55%,transparent);}
.bs-fetchNote[data-kind="warn"]{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary));}
.bs-fetchNote[data-kind="error"]{color:var(--dsw-alias-state-error-primary);}
.bs-usage{margin-top:4px;padding:12px;border:.6px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-settings-card-fill);}
.bs-usageHead{display:flex;align-items:center;gap:10px;}
.bs-usageIcon{display:grid;flex:none;place-items:center;width:24px;height:24px;border-radius:50%;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent);color:var(--dsw-alias-state-business-primary);}
.bs-usageTitle{flex:1;min-width:0;margin:0;font-size:15px;font-weight:600;line-height:22px;}
.bs-usageRefresh{width:28px;height:28px;color:var(--dsw-alias-state-business-primary);}
.bs-usageRefresh svg{width:18px;height:18px;}
.bs-usageRefresh:disabled{opacity:.5;}
.bs-usageBody{display:flex;flex-direction:column;gap:10px;margin-top:12px;}
.bs-usageMuted{margin:0;font-size:13px;line-height:19px;color:color-mix(in srgb,var(--dsw-alias-label-primary) 64%,transparent);}
.bs-usageError{margin:0;font-size:13px;line-height:1.35;color:var(--dsw-alias-state-error-primary);}
.bs-usageNumbers{display:flex;flex-direction:column;gap:10px;}
.bs-usageNumberRow{display:flex;align-items:center;gap:8px;}
.bs-usageRemaining{flex:1;min-width:0;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:17px;font-weight:600;line-height:24px;color:var(--dsw-alias-state-business-primary);}
.bs-usageUsed{flex:none;font-size:12.5px;line-height:18px;text-align:right;color:color-mix(in srgb,var(--dsw-alias-label-primary) 68%,transparent);}
.bs-usageBar{position:relative;height:7px;border-radius:4px;overflow:hidden;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,transparent);}
.bs-usageBarFill{display:block;height:100%;border-radius:4px;background:var(--dsw-alias-state-business-primary);transition:width .18s ease;}
.bs-usageBalance{margin:0;font-size:20px;font-weight:600;line-height:26px;color:var(--dsw-alias-state-business-primary);}
.bs-dialog[data-size="keys"]{width:min(440px,calc(100% - 32px));height:min(520px,calc(100% - 32px));}
.bs-dialog[data-size="keys"] .bs-dialogBody{overflow:hidden;padding-bottom:8px;}
.bs-keyDialog{display:flex;flex:1 1 auto;flex-direction:column;gap:8px;min-height:0;}
.bs-keyDialogDesc{margin:0;font-size:12px;line-height:1.4;color:color-mix(in srgb,var(--dsw-alias-label-primary) 60%,transparent);}
.bs-keyScroll{flex:1 1 auto;min-height:0;overflow:auto;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent;}
.bs-keyManageList{gap:0;}
.bs-keyManageRow{position:relative;display:flex;align-items:center;gap:10px;padding:8px 0;font-size:13px;line-height:18px;}
.bs-keyManageRow+.bs-keyManageRow::before{content:"";position:absolute;top:0;left:28px;right:0;height:.6px;background:var(--dsw-alias-border-l3);}
.bs-keyRound{display:inline-flex;flex:none;color:color-mix(in srgb,var(--dsw-alias-label-primary) 50%,transparent);}
.bs-keyManageRow[data-primary="true"] .bs-keyRound{color:var(--dsw-alias-state-business-primary);}
.bs-keyPrimary{flex:none;padding:1px 5px;border-radius:5px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent);color:var(--dsw-alias-state-business-primary);font-size:10px;font-weight:600;line-height:15px;}
.bs-keyManageRow .bs-iconBtn{width:28px;height:28px;color:var(--dsw-alias-label-tertiary);}
.bs-keyManageRow .bs-iconBtn svg{width:16px;height:16px;}
.bs-keyManageRow .bs-iconBtn:hover:not(:disabled){color:var(--dsw-alias-label-primary);}
.bs-keyDialog .bs-textarea{min-height:38px;max-height:66px;resize:none;}
.bs-keyDialogFoot{display:flex;flex:none;align-items:center;justify-content:space-between;gap:8px;}
.bs-keyFeedback{flex:1;min-width:0;font-size:12px;line-height:18px;color:color-mix(in srgb,var(--dsw-alias-label-primary) 60%,transparent);}
.bs-keyFeedback[data-added="true"]{color:var(--dsw-alias-state-business-primary);}
.bs-keyFeedback[data-error="true"]{color:var(--dsw-alias-state-error-primary);}
.bs-keyLoadError{display:flex;flex-direction:column;align-items:flex-start;gap:8px;}
@media (max-width:640px){
.bs-pane{padding:12px 8px 20px;}
.bs-card{flex-wrap:wrap;gap:8px 10px;padding:12px;}
.bs-name{flex-basis:calc(100% - 34px);}
.bs-actions{margin-left:auto;}
.bs-dialog{padding:12px 14px 0;}
}
`;

		/**
		 * Install the one stylesheet tag this plugin owns and remove it on dispose.
		 * The tag carries `data-plugin` so a second mount (or a hot reload) reuses
		 * the node instead of duplicating the stylesheet.
		 * @returns {() => void} the release function.
		 */
		function mountCss() {
			if (typeof document === "undefined") return () => {};
			let tag = cssTag;
			if (!tag || tag.parentNode === null) {
				tag = typeof document.querySelector === "function" ? document.querySelector('style[data-plugin="' + ROUTE_PLUGIN + '"]') : null;
			}
			if (!tag) {
				tag = document.createElement("style");
				tag.dataset.plugin = ROUTE_PLUGIN;
				tag.dataset.pluginCss = ROUTE_PLUGIN + "/client.css";
				tag.textContent = CSS;
				document.head.appendChild(tag);
			}
			cssTag = tag;
			return () => {
				if (tag && tag.parentNode) tag.parentNode.removeChild(tag);
				if (cssTag === tag) cssTag = null;
			};
		}

		/* ================================================================ */
		/* glyphs                                                            */
		/* ================================================================ */

		function svg(props) {
			const options = props || {};
			const size = options.size || 16;
			const children = Array.prototype.slice.call(arguments, 1);
			return h("svg", {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: options.strokeWidth || 1.7,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				focusable: "false",
			}, ...children);
		}

		/** Sidebar entry: a magnifier with a four-point spark. */
		function PanelIcon(props) {
			const options = props || {};
			const size = options.size || 16;
			const active = options.active === true;
			return svg({ size, strokeWidth: active ? 1.9 : 1.7 },
				h("circle", { cx: 10, cy: 10, r: 6.4 }),
				h("path", { d: "m19.4 19.4-4-4" }),
				h("path", { d: "M18.6 3.2v3.4M16.9 4.9h3.4" }));
		}

		function PlusGlyph(props) {
			return svg({ size: props && props.size },
				h("path", { d: "M12 5v14M5 12h14" }));
		}

		function CloseGlyph(props) {
			return svg({ size: props && props.size },
				h("path", { d: "M18 6 6 18M6 6l12 12" }));
		}

		function ChevronDownGlyph(props) {
			return svg({ size: props && props.size, strokeWidth: 1.8 },
				h("path", { d: "m6 9 6 6 6-6" }));
		}

		function ChevronRightGlyph(props) {
			return svg({ size: props && props.size, strokeWidth: 1.8 },
				h("path", { d: "m9 6 6 6-6 6" }));
		}

		function CheckGlyph(props) {
			return svg({ size: props && props.size, strokeWidth: 2 },
				h("path", { d: "M20 6 9 17l-5-5" }));
		}

		function MinusGlyph(props) {
			return svg({ size: props && props.size },
				h("path", { d: "M5 12h14" }));
		}

		function EditGlyph(props) {
			return svg({ size: props && props.size, strokeWidth: 1.6 },
				h("circle", { cx: 12, cy: 12, r: 3 }),
				h("path", { d: "M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z" }));
		}

		function HeartPulseGlyph(props) {
			return svg({ size: props && props.size },
				h("path", { d: "M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" }),
				h("path", { d: "M3.2 12.4h4.3l1.5-2.6 2.4 5.2 1.9-3.3 1.2.7h4.3", strokeWidth: 1.3 }));
		}

		function TrashGlyph(props) {
			return svg({ size: props && props.size, strokeWidth: 1.6 },
				h("path", { d: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" }),
				h("path", { d: "M10 11v5M14 11v5" }));
		}

		function KeyGlyph(props) {
			return svg({ size: props && props.size, strokeWidth: 1.7 },
				h("circle", { cx: 8, cy: 15, r: 4 }),
				h("path", { d: "m10.8 12.2 8.2-8.2M16.5 6.5 19 9M14 9l2.5 2.5" }));
		}

		function KeyRoundGlyph(props) {
			return svg({ size: props && props.size, strokeWidth: 1.6 },
				h("circle", { cx: 16.5, cy: 7.5, r: 0.8, fill: "currentColor", stroke: "none" }),
				h("path", { d: "m10.6 13.4 8.5-8.5a5.4 5.4 0 0 0-7.6-1 5.4 5.4 0 0 0-1 7.6l-6.6 6.6a2 2 0 0 0-.4.9V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1.1" }));
		}

		function FileTextGlyph(props) {
			return svg({ size: props && props.size, strokeWidth: 1.6 },
				h("path", { d: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" }),
				h("path", { d: "M14 3v6h6M8 13h8M8 17h5" }));
		}

		function WalletGlyph(props) {
			return svg({ size: props && props.size, strokeWidth: 1.6 },
				h("path", { d: "M20 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-3" }),
				h("path", { d: "M3 8h18v4h-4a2 2 0 0 0 0 4h4v-2" }));
		}

		function RefreshCwGlyph(props) {
			return svg({ size: props && props.size, strokeWidth: 1.6 },
				h("path", { d: "M21 12a9 9 0 0 1-15.5 6.2L3 16" }),
				h("path", { d: "M3 12a9 9 0 0 1 15.5-6.2L21 8" }),
				h("path", { d: "M21 3v5h-5M3 21v-5h5" }));
		}

		function EyeGlyph(props) {
			return svg({ size: props && props.size, strokeWidth: 1.6 },
				h("path", { d: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" }),
				h("circle", { cx: 12, cy: 12, r: 3 }));
		}

		function EyeOffGlyph(props) {
			return svg({ size: props && props.size, strokeWidth: 1.6 },
				h("path", { d: "M9.9 9.9a3 3 0 0 0 4.2 4.2" }),
				h("path", { d: "M10.7 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a13.2 13.2 0 0 1-1.7 2.7M6.6 6.6A13.5 13.5 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6" }),
				h("path", { d: "m2 2 20 20" }));
		}

		function ListGlyph(props) {
			return svg({ size: props && props.size, strokeWidth: 0 },
				h("circle", { cx: 9, cy: 6, r: 1.3, fill: "currentColor" }),
				h("circle", { cx: 15, cy: 6, r: 1.3, fill: "currentColor" }),
				h("circle", { cx: 9, cy: 12, r: 1.3, fill: "currentColor" }),
				h("circle", { cx: 15, cy: 12, r: 1.3, fill: "currentColor" }),
				h("circle", { cx: 9, cy: 18, r: 1.3, fill: "currentColor" }),
				h("circle", { cx: 15, cy: 18, r: 1.3, fill: "currentColor" }));
		}

		function ClockGlyph(props) {
			return svg({ size: props && props.size },
				h("circle", { cx: 12, cy: 12, r: 8.5 }),
				h("path", { d: "M12 7.5V12l3 2" }));
		}

		function ToggleGlyph(props) {
			return svg({ size: props && props.size },
				h("rect", { x: 3, y: 7, width: 18, height: 10, rx: 5 }),
				h("circle", { cx: 15.5, cy: 12, r: 2.6, fill: "currentColor", stroke: "none" }));
		}

		function SearchGlyph(props) {
			return svg({ size: props && props.size, strokeWidth: 1.5 },
				h("circle", { cx: 10.5, cy: 10.5, r: 7 }),
				h("path", { d: "m20 20-3.4-3.4" }),
				h("path", { d: "M18.8 2.6v3.2M17.2 4.2h3.2" }));
		}

		/* ================================================================ */
		/* primitive controls                                                */
		/* ================================================================ */

		function errorIdFor(id) {
			return id ? id + "-error" : undefined;
		}

		/**
		 * A labelled text input with an optional error message.
		 * @param {any} props - id, label, value, onChange, placeholder, type, error, hint.
		 * @returns {any} the field element.
		 */
		function TextField(props) {
			const id = props.id;
			const errorId = errorIdFor(id);
			const hintId = id ? id + "-hint" : undefined;
			return h("div", { className: "bs-field" },
				props.label ? h("label", { className: "bs-fieldLabel", htmlFor: id }, props.label) : null,
				h("input", {
					id,
					className: "bs-input",
					"data-testid": props.testId,
					type: props.type || "text",
					value: props.value === undefined || props.value === null ? "" : props.value,
					placeholder: props.placeholder === undefined ? "" : props.placeholder,
					"aria-label": props.ariaLabel || (props.label ? undefined : props.placeholder),
					"aria-invalid": props.error ? "true" : undefined,
					"aria-describedby": props.error ? errorId : (props.hint ? hintId : undefined),
					autoComplete: props.autoComplete || "off",
					spellCheck: false,
					disabled: props.disabled,
					maxLength: props.maxLength,
					onChange: (event) => props.onChange(event.target.value),
				}),
				props.error
					? h("p", { id: errorId, className: "bs-fieldError", role: "alert" }, props.error)
					: (props.hint ? h("p", { id: hintId, className: "bs-fieldHint" }, props.hint) : null));
		}

		function TextAreaField(props) {
			const id = props.id;
			const hintId = id ? id + "-hint" : undefined;
			return h("div", { className: "bs-field" },
				props.label ? h("label", { className: "bs-fieldLabel", htmlFor: id }, props.label) : null,
				h("textarea", {
					id,
					className: "bs-textarea",
					"data-testid": props.testId,
					value: props.value === undefined || props.value === null ? "" : props.value,
					placeholder: props.placeholder === undefined ? "" : props.placeholder,
					"aria-label": props.ariaLabel || (props.label ? undefined : props.placeholder),
					"aria-describedby": hintId,
					rows: props.rows || 3,
					spellCheck: false,
					disabled: props.disabled,
					onChange: (event) => props.onChange(event.target.value),
				}),
				props.hint ? h("p", { id: hintId, className: "bs-fieldHint" }, props.hint) : null);
		}

		function Switch(props) {
			return h("button", {
				type: "button",
				role: "switch",
				className: "bs-switch",
				"data-testid": props.testId,
				"aria-checked": props.checked === true ? "true" : "false",
				"aria-label": props.label,
				disabled: props.disabled,
				onClick: () => props.onChange(!props.checked),
			});
		}

		function Stepper(props) {
			const value = typeof props.value === "number" && Number.isFinite(props.value) ? props.value : props.min;
			return h("span", { className: "bs-stepper" },
				h("button", {
					type: "button",
					className: "bs-stepBtn",
					"data-testid": props.testId ? props.testId + "-minus" : undefined,
					"aria-label": t("stepper.minus"),
					disabled: props.disabled || value <= props.min,
					onClick: () => props.onChange(clamp(value - props.step, props.min, props.max)),
				}, h(MinusGlyph, { size: 16 })),
				h("span", { className: "bs-rowValue", "data-testid": props.testId ? props.testId + "-value" : undefined, "aria-live": "polite" }, String(value)),
				h("button", {
					type: "button",
					className: "bs-stepBtn",
					"data-testid": props.testId ? props.testId + "-plus" : undefined,
					"aria-label": t("stepper.plus"),
					disabled: props.disabled || value >= props.max,
					onClick: () => props.onChange(clamp(value + props.step, props.min, props.max)),
				}, h(PlusGlyph, { size: 16 })));
		}

		function BrandBadge(props) {
			const [failed, setFailed] = useState(false);
			const url = brandUrlOf(props.brand);
			if (url !== "" && !failed) {
				return h("span", { className: "bs-badge", "aria-hidden": "true" },
					h("img", {
						src: url,
						alt: "",
						draggable: false,
						loading: "lazy",
						"data-testid": "brand-image",
						onError: () => setFailed(true),
					}));
			}
			return h("span", { className: "bs-badge", "aria-hidden": "true" },
				h("span", { className: "bs-badgeLetter" }, letterOf(props.name)));
		}

		let dialogSeq = 0;

		/**
		 * A modal dialog: role=dialog, Escape closes, focus enters and returns to
		 * the trigger. Rendered inline (no portal) so it unmounts with the panel.
		 */
		function Modal(props) {
			const panelRef = useRef(null);
			const previousFocus = useRef(null);
			const closeRef = useRef(props.onClose);
			closeRef.current = props.onClose;
			const labelRef = useRef(null);
			if (labelRef.current === null) {
				dialogSeq += 1;
				labelRef.current = "bs-dialog-title-" + dialogSeq;
			}
			useEffect(() => {
				previousFocus.current = typeof document !== "undefined" ? document.activeElement : null;
				const node = panelRef.current;
				if (node && typeof node.focus === "function") node.focus();
				const onKeyDown = (event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
						closeRef.current();
						return;
					}
					if (event.key !== "Tab" || !node || typeof node.querySelectorAll !== "function") return;
					const focusables = node.querySelectorAll('button:not(:disabled),[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])');
					const list = Array.prototype.filter.call(focusables, (element) => element.offsetParent !== null);
					if (list.length === 0) {
						event.preventDefault();
						node.focus();
						return;
					}
					const first = list[0];
					const last = list[list.length - 1];
					if (event.shiftKey && document.activeElement === first) {
						event.preventDefault();
						last.focus();
					} else if (!event.shiftKey && document.activeElement === last) {
						event.preventDefault();
						first.focus();
					}
				};
				if (typeof document !== "undefined") document.addEventListener("keydown", onKeyDown, true);
				return () => {
					if (typeof document !== "undefined") document.removeEventListener("keydown", onKeyDown, true);
					const previous = previousFocus.current;
					if (previous && typeof previous.focus === "function" && previous.isConnected !== false) previous.focus();
				};
			}, []);
			return h("div", {
				className: "bs-overlay",
				onMouseDown: (event) => {
					if (event.target === event.currentTarget) props.onClose();
				},
			},
			h("div", {
				ref: panelRef,
				className: "bs-dialog",
				"data-size": props.size === "edit" ? "edit" : (props.size === "keys" ? "keys" : "add"),
				role: "dialog",
				"aria-modal": "true",
				"aria-labelledby": labelRef.current,
				"data-testid": props.testId,
				tabIndex: -1,
			},
			h("div", { className: "bs-dialogHead" },
				h("h2", { className: "bs-dialogTitle", id: labelRef.current }, props.title),
				h("button", {
					type: "button",
					className: "bs-iconBtn",
					"data-testid": props.closeTestId,
					"aria-label": t("common.close"),
					onClick: props.onClose,
				}, h(CloseGlyph, { size: 16 }))),
			h("div", { className: "bs-dialogBody" }, props.children),
			props.footer ? h("div", { className: "bs-dialogFoot" }, props.footer) : null));
		}

		function Banner(props) {
			const kind = props.kind || "error";
			return h("div", {
				className: "bs-banner",
				"data-kind": kind,
				"data-testid": props.testId,
				role: kind === "error" ? "alert" : "status",
			},
			h("span", { className: "bs-bannerText" }, props.text),
			props.onRetry
				? h("button", { type: "button", className: "bs-btn bs-btnSm", onClick: props.onRetry }, t("common.retry"))
				: null,
			props.onDismiss
				? h("button", {
					type: "button",
					className: "bs-bannerDismiss",
					"aria-label": t("notice.dismiss"),
					onClick: props.onDismiss,
				}, h(CloseGlyph, { size: 14 }))
				: null);
		}

		function displayName(service) {
			if (!service) return "";
			if (currentLang() === "en" && typeof service.nameEn === "string" && service.nameEn !== "") return service.nameEn;
			if (typeof service.name === "string" && service.name !== "") return service.name;
			return typeof service.type === "string" ? service.type : "";
		}

		function statusOf(service, testing) {
			if (!service) return "idle";
			if (testing === true) return "test";
			if (service.connected === true) return "ok";
			if (service.connected === false) return "fail";
			return "idle";
		}

		function StatusPill(props) {
			const status = props.status || "idle";
			const keys = {
				ok: "searchServicesPageConnectedStatus",
				fail: "searchServicesPageFailedStatus",
				test: "searchServicesPageTestingStatus",
				idle: "searchServicesPageNotTestedStatus",
			};
			return h("span", {
				className: "bs-pill",
				"data-state": status,
				"data-testid": "status-pill",
			}, t(keys[status] || keys.idle));
		}

		/* ================================================================ */
		/* catalog + state helpers                                           */
		/* ================================================================ */

		function providerName(provider) {
			if (!provider) return "";
			const zhName = typeof provider.zh === "string" && provider.zh !== "" ? provider.zh : provider.type;
			const enName = typeof provider.en === "string" && provider.en !== "" ? provider.en : zhName;
			return currentLang() === "en" ? enName : zhName;
		}

		function descriptorOf(providers, type) {
			if (!Array.isArray(providers)) return null;
			for (const provider of providers) {
				if (provider && provider.type === type) return provider;
			}
			return null;
		}

		function defaultType(providers) {
			if (!Array.isArray(providers) || providers.length === 0) return "";
			const first = providers[0];
			return first && typeof first.type === "string" ? first.type : "";
		}

		function groupProviders(providers) {
			const groups = [
				{ key: "noKey", label: () => t("dialog.typeGroup.noKey"), items: [] },
				{ key: "key", label: () => t("dialog.typeGroup.key"), items: [] },
				{ key: "self", label: () => t("dialog.typeGroup.selfHosted"), items: [] },
			];
			const list = Array.isArray(providers) ? providers : [];
			for (const provider of list) {
				if (!provider || typeof provider.type !== "string") continue;
				const target = provider.key === "none" ? groups[0] : (provider.urlRequired === true ? groups[2] : groups[1]);
				target.items.push(provider);
			}
			return groups.filter((group) => group.items.length > 0);
		}

		/**
		 * Filter catalog descriptors down to the types the Host can serve.
		 * @param {any[]} providers - catalog descriptors.
		 * @param {any} supportedTypes - `supportedTypes` from GET /catalog.
		 * @returns {any[]} the descriptors the add dialog may offer.
		 */
		function filterSupported(providers, supportedTypes) {
			const list = Array.isArray(providers) ? providers : [];
			if (!Array.isArray(supportedTypes) || supportedTypes.length === 0) return list;
			return list.filter((provider) => provider && supportedTypes.indexOf(provider.type) !== -1);
		}

		function defaultOptions(descriptor) {
			const options = {};
			if (descriptor && Array.isArray(descriptor.extras)) {
				for (const extra of descriptor.extras) {
					if (!extra || typeof extra.key !== "string") continue;
					options[extra.key] = extra.value === undefined || extra.value === null ? "" : String(extra.value);
				}
			}
			return options;
		}

		function initialOptions(descriptor, stored) {
			const base = defaultOptions(descriptor);
			if (stored && typeof stored === "object") {
				for (const extra of (descriptor && Array.isArray(descriptor.extras) ? descriptor.extras : [])) {
					if (!extra || typeof extra.key !== "string") continue;
					if (extra.kind === "password") continue;
					if (hasOwn(stored, extra.key) && stored[extra.key] !== null && stored[extra.key] !== undefined) {
						base[extra.key] = String(stored[extra.key]);
					}
				}
			}
			return base;
		}

		/**
		 * Build the `options` payload from the dialog draft, preserving option keys
		 * this catalog entry does not know about.
		 * @param {any} descriptor - catalog descriptor for the chosen type.
		 * @param {object} draft - draft values keyed by extra.key.
		 * @param {object} original - stored options of the edited service.
		 * @returns {object} the options to save.
		 */
		function buildOptions(descriptor, draft, original) {
			const out = {};
			if (original && typeof original === "object") {
				for (const key of Object.keys(original)) out[key] = original[key];
			}
			const extras = descriptor && Array.isArray(descriptor.extras) ? descriptor.extras : [];
			for (const extra of extras) {
				if (!extra || typeof extra.key !== "string") continue;
				const raw = draft && hasOwn(draft, extra.key) ? draft[extra.key] : "";
				const value = raw === undefined || raw === null ? "" : String(raw).trim();
				if (value !== "") out[extra.key] = value;
				else if (extra.kind !== "password") delete out[extra.key];
			}
			return out;
		}

		function maskKey(value) {
			const key = typeof value === "string" ? value : "";
			if (key.length <= 8) return "••••••••";
			return key.slice(0, 4) + "••••" + key.slice(-4);
		}

		/**
		 * Split a pasted key blob into unique keys.
		 * @param {string} text - one per line or comma/semicolon separated.
		 * @returns {string[]} unique, non-empty keys in input order.
		 */
		function parseKeyList(text) {
			const parts = String(text === undefined || text === null ? "" : text).split(/[\s,;]+/u);
			const out = [];
			for (const part of parts) {
				const key = part.trim();
				if (key === "") continue;
				if (out.indexOf(key) === -1) out.push(key);
			}
			return out;
		}

		function normalizedLimits(catalogCommon) {
			const limits = { maxResults: { min: DEFAULT_LIMITS.maxResults.min, max: DEFAULT_LIMITS.maxResults.max }, timeoutMs: { min: DEFAULT_LIMITS.timeoutMs.min, max: DEFAULT_LIMITS.timeoutMs.max } };
			const source = catalogCommon && typeof catalogCommon === "object" && catalogCommon.limits && typeof catalogCommon.limits === "object"
				? catalogCommon.limits
				: null;
			if (source) {
				for (const name of ["maxResults", "timeoutMs"]) {
					const entry = source[name];
					if (!entry || typeof entry !== "object") continue;
					if (Number.isFinite(entry.min)) limits[name].min = entry.min;
					if (Number.isFinite(entry.max)) limits[name].max = entry.max;
				}
			}
			if (limits.maxResults.max < limits.maxResults.min) limits.maxResults = { min: DEFAULT_LIMITS.maxResults.min, max: DEFAULT_LIMITS.maxResults.max };
			if (limits.timeoutMs.max < limits.timeoutMs.min) limits.timeoutMs = { min: DEFAULT_LIMITS.timeoutMs.min, max: DEFAULT_LIMITS.timeoutMs.max };
			return limits;
		}

		function timeoutSecondsOf(timeoutMs, limits) {
			const raw = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) ? timeoutMs : 30000;
			const seconds = Math.round(raw / 1000);
			return clamp(seconds, Math.ceil(limits.timeoutMs.min / 1000), Math.floor(limits.timeoutMs.max / 1000));
		}

		/* ================================================================ */
		/* polling hooks                                                     */
		/* ================================================================ */

		function useSearchState() {
			const [snapshot, setSnapshot] = useState({ status: "loading", data: null, error: null });
			const mountedRef = useRef(true);
			const requestRef = useRef(null);
			const apply = useCallback((data) => {
				if (!mountedRef.current || !data) return;
				setSnapshot({ status: "ready", data, error: null });
			}, []);
			const load = useCallback((options) => {
				const quiet = Boolean(options && options.quiet);
				if (!mountedRef.current) return Promise.resolve();
				if (requestRef.current) requestRef.current.abort();
				const controller = typeof AbortController === "function" ? new AbortController() : null;
				requestRef.current = controller;
				if (controller) liveRequests.add(controller);
				if (!quiet) {
					setSnapshot((previous) => ({ ...previous, status: previous.data ? "refreshing" : "loading", error: null }));
				}
				return apiFetch("/state", { signal: controller ? controller.signal : undefined })
					.then((payload) => {
						if (!mountedRef.current || (controller && controller.signal.aborted)) return;
						setSnapshot({ status: "ready", data: payload, error: null });
					})
					.catch((failure) => {
						if (!mountedRef.current || isAbortError(failure)) return;
						setSnapshot((previous) => ({
							status: previous.data ? "ready" : "error",
							data: previous.data,
							error: errorMessage(failure),
						}));
					})
					.finally(() => {
						if (controller) liveRequests.delete(controller);
						if (requestRef.current === controller) requestRef.current = null;
					});
			}, []);
			useEffect(() => {
				mountedRef.current = true;
				void load();
				const timer = setInterval(() => {
					if (isDocumentHidden()) return;
					void load({ quiet: true });
				}, POLL_MS);
				timers.add(timer);
				const doc = typeof document !== "undefined" ? document : null;
				const onVisibility = () => {
					if (!isDocumentHidden()) void load({ quiet: true });
				};
				if (doc && typeof doc.addEventListener === "function") doc.addEventListener("visibilitychange", onVisibility);
				return () => {
					mountedRef.current = false;
					clearInterval(timer);
					timers.delete(timer);
					if (doc && typeof doc.removeEventListener === "function") doc.removeEventListener("visibilitychange", onVisibility);
					if (requestRef.current) requestRef.current.abort();
				};
			}, [load]);
			return { status: snapshot.status, data: snapshot.data, error: snapshot.error, reload: load, apply };
		}

		function useCatalog() {
			const [snapshot, setSnapshot] = useState(() => (
				catalogCache
					? { status: "ready", providers: catalogCache.providers, supportedTypes: catalogCache.supportedTypes, common: catalogCache.common, error: null }
					: { status: "idle", providers: [], supportedTypes: null, common: null, error: null }
			));
			const mountedRef = useRef(true);
			const requestRef = useRef(null);
			const load = useCallback(() => {
				if (!mountedRef.current) return Promise.resolve();
				if (requestRef.current) requestRef.current.abort();
				const controller = typeof AbortController === "function" ? new AbortController() : null;
				requestRef.current = controller;
				if (controller) liveRequests.add(controller);
				setSnapshot((previous) => ({ ...previous, status: "loading", error: null }));
				return apiFetch("/catalog", { signal: controller ? controller.signal : undefined })
					.then((payload) => {
						if (!mountedRef.current || (controller && controller.signal.aborted)) return;
						const providers = Array.isArray(payload.providers) ? payload.providers : [];
						const supportedTypes = Array.isArray(payload.supportedTypes) ? payload.supportedTypes : null;
						const common = payload.common && typeof payload.common === "object" ? payload.common : null;
						catalogCache = { providers, supportedTypes, common };
						setSnapshot({ status: "ready", providers, supportedTypes, common, error: null });
					})
					.catch((failure) => {
						if (!mountedRef.current || isAbortError(failure)) return;
						setSnapshot((previous) => ({
							status: "error",
							providers: previous.providers,
							supportedTypes: previous.supportedTypes,
							common: previous.common,
							error: errorMessage(failure),
						}));
					})
					.finally(() => {
						if (controller) liveRequests.delete(controller);
						if (requestRef.current === controller) requestRef.current = null;
					});
			}, []);
			useEffect(() => {
				mountedRef.current = true;
				if (!catalogCache) void load();
				return () => {
					mountedRef.current = false;
					if (requestRef.current) requestRef.current.abort();
				};
			}, [load]);
			return {
				status: snapshot.status,
				providers: filterSupported(snapshot.providers, snapshot.supportedTypes),
				supportedTypes: snapshot.supportedTypes,
				common: snapshot.common,
				error: snapshot.error,
				reload: load,
			};
		}

		/* ================================================================ */
		/* service card                                                      */
		/* ================================================================ */

		function ServiceCard(props) {
			const service = props.service || {};
			const builtin = props.builtin === true;
			const selected = props.selected === true;
			const status = statusOf(service, props.testing === true);
			const cardProps = {
				className: "bs-card",
				"data-selected": selected ? "true" : "false",
				"data-builtin": builtin ? "true" : "false",
				"data-service-id": service.id === undefined ? "" : service.id,
				"data-testid": builtin ? "builtin-card" : "service-card",
				tabIndex: 0,
				role: "button",
				"aria-pressed": selected ? "true" : "false",
				"aria-label": displayName(service) + (builtin ? " · " + t("card.builtin") : ""),
				onClick: (event) => {
					if (event && event.target && typeof event.target.closest === "function" && event.target.closest("button")) return;
					if (props.suppressClick === true) {
						if (props.onSuppress) props.onSuppress();
						return;
					}
					if (props.onSelect) props.onSelect(service);
				},
				onKeyDown: (event) => {
					if (!event) return;
					if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
						event.preventDefault();
						if (props.onSelect) props.onSelect(service);
					}
				},
			};
			if (!builtin) {
				cardProps.draggable = true;
				cardProps.onDragStart = (event) => { if (props.onDragStart) props.onDragStart(service, event); };
				cardProps.onDragEnd = () => { if (props.onDragEnd) props.onDragEnd(); };
				cardProps.onDragOver = (event) => { if (props.onDragOver) props.onDragOver(service, event); };
				cardProps.onDragLeave = () => { if (props.onDragLeave) props.onDragLeave(service); };
				cardProps.onDrop = (event) => { if (props.onDrop) props.onDrop(service, event); };
				if (props.dragging === true) cardProps["data-dragging"] = "true";
				if (props.dropPosition === "before" || props.dropPosition === "after") cardProps["data-drop"] = props.dropPosition;
			}
			const actions = [];
			if (!builtin) {
				actions.push(h("button", {
					key: "edit",
					type: "button",
					className: "bs-iconBtn bs-iconBtnSm",
					"data-testid": "edit-service",
					title: t("searchServicesPageEditServiceTooltip"),
					"aria-label": t("searchServicesPageEditServiceTooltip"),
					onClick: (event) => {
						event.stopPropagation();
						if (props.onEdit) props.onEdit(service);
					},
				}, h(EditGlyph, { size: 17 })));
				actions.push(h("button", {
					key: "test",
					type: "button",
					className: "bs-iconBtn bs-iconBtnSm",
					"data-testid": "test-service",
					title: t("searchServicesPageTestConnectionTooltip"),
					"aria-label": t("searchServicesPageTestConnectionTooltip"),
					disabled: props.testing === true,
					onClick: (event) => {
						event.stopPropagation();
						if (props.onTest) props.onTest(service);
					},
				}, h(HeartPulseGlyph, { size: 17 })));
				actions.push(h("button", {
					key: "delete",
					type: "button",
					className: "bs-iconBtn bs-iconBtnSm bs-iconBtnDanger",
					"data-testid": "delete-service",
					title: t("searchServicesPageDeleteServiceTooltip"),
					"aria-label": t("searchServicesPageDeleteServiceTooltip"),
					onClick: (event) => {
						event.stopPropagation();
						if (props.onDelete) props.onDelete(service);
					},
				}, h(TrashGlyph, { size: 17 })));
			}
			return h("li", cardProps,
				h(BrandBadge, { brand: service.brand, name: service.name }),
				h("span", { className: "bs-name" },
					h("span", { className: "bs-nameText" }, displayName(service)),
					builtin ? h("em", { className: "bs-tag" }, t("card.builtin")) : null,
					service.fetchCapable === true
						? h("span", {
							className: "bs-fetchBadge",
							title: t("searchServicesPageWebFetchSupported"),
							"aria-label": t("searchServicesPageWebFetchSupported"),
						}, h(FileTextGlyph, { size: 14 }))
						: null),
				builtin ? null : h(StatusPill, { status }),
				actions.length > 0 ? h("span", { className: "bs-actions" }, actions) : null);
		}

		/* ================================================================ */
		/* type picker                                                       */
		/* ================================================================ */

		/* ================================================================ */
		/* anchored dropdown menu                                           */
		/* ================================================================ */

		function useAnchoredMenu(open, setOpen) {
			const rootRef = useRef(null);
			const triggerRef = useRef(null);
			const [menuRect, setMenuRect] = useState(null);
			const measure = useCallback(() => {
				const trigger = triggerRef.current;
				if (!trigger || typeof trigger.getBoundingClientRect !== "function") return;
				const rect = trigger.getBoundingClientRect();
				const viewportHeight = typeof window !== "undefined" && Number.isFinite(window.innerHeight) ? window.innerHeight : 800;
				const viewportWidth = typeof window !== "undefined" && Number.isFinite(window.innerWidth) ? window.innerWidth : 1024;
				const top = rect.bottom + 6;
				const width = Math.min(rect.width, viewportWidth - 16);
				const left = Math.max(8, Math.min(rect.left, viewportWidth - width - 8));
				const maxHeight = Math.max(140, Math.min(360, viewportHeight - top - 12));
				setMenuRect({ top, left, width, maxHeight });
			}, []);
			useEffect(() => {
				if (!open) return undefined;
				measure();
				const onDocDown = (event) => {
					const root = rootRef.current;
					if (root && event && event.target && typeof root.contains === "function" && root.contains(event.target)) return;
					setOpen(false);
				};
				const onKeyDown = (event) => {
					if (event && event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
						if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
						setOpen(false);
					}
				};
				const onScrollResize = () => measure();
				const win = typeof window !== "undefined" ? window : null;
				const doc = typeof document !== "undefined" ? document : null;
				if (doc && typeof doc.addEventListener === "function") doc.addEventListener("mousedown", onDocDown, true);
				if (win && typeof win.addEventListener === "function") {
					win.addEventListener("keydown", onKeyDown, true);
					win.addEventListener("resize", onScrollResize);
					win.addEventListener("scroll", onScrollResize, true);
				}
				return () => {
					if (doc && typeof doc.removeEventListener === "function") doc.removeEventListener("mousedown", onDocDown, true);
					if (win && typeof win.removeEventListener === "function") {
						win.removeEventListener("keydown", onKeyDown, true);
						win.removeEventListener("resize", onScrollResize);
						win.removeEventListener("scroll", onScrollResize, true);
					}
				};
			}, [open, measure, setOpen]);
			return { rootRef, triggerRef, menuRect, measure };
		}

		function TypePicker(props) {
			const [open, setOpen] = useState(false);
			const { rootRef, triggerRef, menuRect, measure } = useAnchoredMenu(open, setOpen);
			const providers = Array.isArray(props.providers) ? props.providers : [];
			const current = descriptorOf(providers, props.value);
			const groups = useMemo(() => groupProviders(providers), [providers]);
		const choose = (provider) => {
				setOpen(false);
				if (props.onChange) props.onChange(provider.type);
			};
			const toggle = () => {
				if (!open) measure();
				setOpen((value) => !value);
			};
			return h("div", { className: "bs-select", "data-open": open ? "true" : "false", ref: rootRef },
				h("button", {
					ref: triggerRef,
					type: "button",
					className: "bs-selectTrigger",
					"data-testid": "type-trigger",
					"aria-haspopup": "listbox",
					"aria-expanded": open ? "true" : "false",
					"aria-label": t("searchServicesAddDialogServiceType"),
					disabled: props.disabled === true || providers.length === 0,
					onClick: toggle,
				},
				current ? h(BrandBadge, { brand: current.brand, name: providerName(current) }) : null,
				h("span", { className: "bs-selectLabel" }, current ? providerName(current) : t("searchServicesAddDialogServiceType")),
				h("span", { className: "bs-chev" }, h(ChevronDownGlyph, { size: 16 }))),
				open && menuRect
					? h("div", {
						className: "bs-menu",
						role: "listbox",
						"aria-label": t("searchServicesAddDialogServiceType"),
						style: { top: menuRect.top + "px", left: menuRect.left + "px", width: menuRect.width + "px", maxHeight: menuRect.maxHeight + "px" },
					},
						groups.map((group) => h("div", { key: group.key, className: "bs-menuGroupWrap" },
							h("div", { className: "bs-menuGroup" }, group.label()),
							group.items.map((provider) => h("button", {
								key: provider.type,
								type: "button",
								role: "option",
								className: "bs-typeRow",
								"data-active": props.value === provider.type ? "true" : "false",
								"aria-selected": props.value === provider.type ? "true" : "false",
								"data-testid": "type-option-" + provider.type,
								onClick: () => choose(provider),
							},
							h(BrandBadge, { brand: provider.brand, name: providerName(provider) }),
							h("span", { className: "bs-typeName" }, providerName(provider)),
							h("span", { className: "bs-typeCheck" }, h(CheckGlyph, { size: 16 }))))))
					)
					: null);
		}

		/* ================================================================ */
		/* web fetch mode row                                                */
		/* ================================================================ */

		function fetchTargetService(services, providerId) {
			if (typeof providerId !== "string" || providerId === "") return null;
			const prefix = "better-search/";
			if (providerId.slice(0, prefix.length) !== prefix) return null;
			const id = providerId.slice(prefix.length);
			for (const service of services) {
				if (service && service.id === id) return service;
			}
			return null;
		}

		function fetchModeLabel(fetchState) {
			if (fetchState && fetchState.mode === "follow") return t("searchServicesPageWebFetchFollow");
			if (fetchState && fetchState.mode === "service") return t("searchServicesPageWebFetchOfficial");
			return t("searchServicesPageWebFetchOfficial");
		}

		function FetchModeSelect(props) {
			const [open, setOpen] = useState(false);
			const { rootRef, triggerRef, menuRect, measure } = useAnchoredMenu(open, setOpen);
			const fetchState = props.value && typeof props.value === "object" ? props.value : { mode: "official", serviceId: "", providerId: "" };
			const services = Array.isArray(props.services) ? props.services : [];
			const fetchable = services.filter((service) => service && service.fetchCapable === true);
			const followService = fetchTargetService(services, fetchState.providerId);
			const explicit = fetchState.mode === "service" ? fetchable.filter((service) => service.id === fetchState.serviceId)[0] : null;
			let currentValue = fetchState.mode === "follow" ? "follow" : "official";
			if (fetchState.mode === "service" && explicit) currentValue = "service:" + String(explicit.id);
			const options = [
				{
					value: "follow",
					label: t("searchServicesPageWebFetchFollow"),
					subtitle: followService ? t("searchServicesPageWebFetchFollowSubtitle", { name: displayName(followService) }) : null,
				},
				{
					value: "official",
					label: t("searchServicesPageWebFetchOfficial"),
					subtitle: t("searchServicesPageWebFetchOfficialSubtitle"),
				},
			].concat(fetchable.map((service) => ({
				value: "service:" + String(service.id),
				label: displayName(service),
				subtitle: t("searchServicesPageWebFetchProviderSubtitle"),
			})));
			let selectedOption = options[0];
			for (const option of options) {
				if (option.value === currentValue) selectedOption = option;
			}
			if (!explicit && fetchState.mode === "service") selectedOption = options[1];
			const choose = (option) => {
				setOpen(false);
				if (!props.onChange) return;
				if (option.value === "follow") props.onChange({ mode: "follow", serviceId: "" });
				else if (option.value === "official") props.onChange({ mode: "official", serviceId: "" });
				else props.onChange({ mode: "service", serviceId: option.value.slice("service:".length) });
			};
			const toggle = () => {
				if (!open) measure();
				setOpen((value) => !value);
			};
			return h("div", { className: "bs-fetchSelect", "data-open": open ? "true" : "false", ref: rootRef },
				h("button", {
					ref: triggerRef,
					type: "button",
					className: "bs-fetchTrigger",
					"data-testid": "fetch-mode-trigger",
					disabled: props.disabled === true,
					"aria-haspopup": "listbox",
					"aria-expanded": open ? "true" : "false",
					"aria-label": t("searchServicesPageWebFetchModeTitle"),
					onClick: toggle,
				},
				h("span", { className: "bs-fetchTriggerLabel" }, selectedOption.label),
				h("span", { className: "bs-chev" }, h(ChevronDownGlyph, { size: 16 }))),
				open && menuRect
					? h("div", {
						className: "bs-menu bs-modeMenu",
						role: "listbox",
						"aria-label": t("searchServicesPageWebFetchModeTitle"),
						style: { top: menuRect.top + "px", left: menuRect.left + "px", width: menuRect.width + "px", maxHeight: menuRect.maxHeight + "px" },
					},
						options.map((option) => h("button", {
							key: option.value,
							type: "button",
							role: "option",
							className: "bs-modeRow",
							"data-selected": option.value === currentValue ? "true" : "false",
							"aria-selected": option.value === currentValue ? "true" : "false",
							"data-testid": "fetch-option-" + option.value.replace(":", "-"),
							onClick: () => choose(option),
						},
						h("span", { className: "bs-modeMain" },
							h("span", { className: "bs-modeLabel" }, option.label),
							option.subtitle ? h("span", { className: "bs-modeSub" }, option.subtitle) : null),
						h("span", { className: "bs-modeCheck" }, h(CheckGlyph, { size: 14 })))))
					: null);
		}

		function FetchModeCard(props) {
			const fetchState = props.fetch && typeof props.fetch === "object"
				? props.fetch
				: { mode: "official", serviceId: "", providerId: "", pin: { ok: true, error: null } };
			const notes = [];
			const followUnresolved = fetchState.mode === "follow"
				&& (typeof fetchState.providerId !== "string" || fetchState.providerId === "");
			if (followUnresolved) {
				notes.push(h("p", {
					key: "follow-missing",
					className: "bs-fetchNote",
					"data-kind": "warn",
					"data-testid": "fetch-follow-warning",
				}, t("searchServicesPageWebFetchUnsupported")));
			}
			const pin = fetchState.pin && typeof fetchState.pin === "object" ? fetchState.pin : null;
			if (pin && pin.ok === false) {
				const message = pin.error === undefined || pin.error === null || pin.error === "" ? t("pin.unknown") : String(pin.error);
				notes.push(h("p", {
					key: "pin-error",
					className: "bs-fetchNote",
					"data-kind": "error",
					"data-testid": "fetch-pin-warning",
				}, t("fetch.pinFailed", { message })));
			}
			return h("section", { className: "bs-sectionCard", "data-testid": "fetch-section" },
				h("div", { className: "bs-row bs-fetchRow" },
					h("span", { className: "bs-rowIcon" }, h(FileTextGlyph, { size: 18 })),
					h("span", { className: "bs-rowLabel" }, t("searchServicesPageWebFetchModeTitle")),
					h(FetchModeSelect, {
						value: fetchState,
						services: props.services,
						disabled: props.disabled,
						onChange: props.onChange,
					})),
				notes.length > 0 ? h("div", { className: "bs-fetchNotes" }, notes) : null);
		}

		/* ================================================================ */
		/* account usage card                                                */
		/* ================================================================ */

		function usageNumber(value) {
			const number = typeof value === "number" ? value : Number(value);
			if (!Number.isFinite(number)) return value === undefined || value === null ? "" : String(value);
			try {
				return number.toLocaleString(currentLang() === "en" ? "en-US" : "zh-CN", { maximumFractionDigits: 2 });
			} catch (failure) {
				return String(number);
			}
		}

		function UsageValue(props) {
			const usage = props.usage || {};
			const service = props.service || {};
			if (service.type === "linkup") {
				return h("p", { className: "bs-usageBalance", "data-testid": "usage-balance" },
					t("searchServiceEditorUsageBalance", { balance: usageNumber(usage.remaining) }));
			}
			const used = typeof usage.used === "number" && Number.isFinite(usage.used) ? usage.used : null;
			const limit = typeof usage.limit === "number" && Number.isFinite(usage.limit) ? usage.limit : null;
			if (used === null || limit === null) {
				return h("p", { className: "bs-usageRemaining", "data-testid": "usage-remaining" },
					t("searchServiceEditorUsageRemaining", { remaining: usageNumber(usage.remaining) }));
			}
			const ratio = limit <= 0 ? 0 : Math.min(1, Math.max(0, used / limit));
			return h("div", { className: "bs-usageNumbers" },
				h("div", { className: "bs-usageNumberRow" },
					h("span", { className: "bs-usageRemaining", "data-testid": "usage-remaining" },
						t("searchServiceEditorUsageRemaining", { remaining: usageNumber(usage.remaining) })),
					h("span", { className: "bs-usageUsed", "data-testid": "usage-used" },
						t("searchServiceEditorUsageUsed", { used: usageNumber(used), limit: usageNumber(limit) }))),
				h("div", { className: "bs-usageBar", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(ratio * 100) },
					h("span", { className: "bs-usageBarFill", style: { width: (ratio * 100).toFixed(2) + "%" } })));
		}

		function UsageCard(props) {
			const service = props.service || {};
			const [usage, setUsage] = useState(null);
			const [error, setError] = useState("");
			const [loading, setLoading] = useState(false);
			const inFlight = useRef(false);
			const alive = useRef(true);
			useEffect(() => () => { alive.current = false; }, []);
			const query = async () => {
				if (inFlight.current) return;
				inFlight.current = true;
				setLoading(true);
				setError("");
				try {
					const payload = await apiMutate("POST", servicePath(service) + "/usage");
					if (!alive.current) return;
					if (payload && payload.ok === false) {
						setUsage(null);
						setError(payload.error === undefined || payload.error === null || payload.error === ""
							? t("pin.unknown")
							: String(payload.error));
					} else if (payload && payload.usage && typeof payload.usage === "object") {
						setUsage(payload.usage);
						setError("");
					} else {
						setError(t("pin.unknown"));
					}
					if (props.onState) props.onState(payload);
				} catch (failure) {
					if (alive.current && !isAbortError(failure)) setError(errorMessage(failure));
				} finally {
					inFlight.current = false;
					if (alive.current) setLoading(false);
				}
			};
			useEffect(() => {
				if (keyCountOf(service) > 0) void query();
			}, []);
			let body = null;
			if (loading && !usage) {
				body = h("p", { className: "bs-usageMuted" }, t("searchServiceEditorUsageQuerying"));
			} else if (error !== "" && !usage) {
				body = h("p", { className: "bs-usageError", "data-testid": "usage-error", role: "alert" },
					t("searchServiceEditorUsageFailed", { message: error }));
			} else if (!usage) {
				body = h("p", { className: "bs-usageMuted", "data-testid": "usage-empty" }, t("searchServiceEditorUsageNotQueried"));
			} else {
				body = h(UsageValue, { service, usage });
			}
			return h("section", { className: "bs-usage", "data-testid": "usage-card" },
				h("div", { className: "bs-usageHead" },
					h("span", { className: "bs-usageIcon" }, h(WalletGlyph, { size: 14 })),
					h("h3", { className: "bs-usageTitle" }, t("searchServiceEditorUsageTitle")),
					h("button", {
						type: "button",
						className: "bs-iconBtn bs-usageRefresh",
						"data-testid": "usage-refresh",
						title: t("searchServiceEditorUsageQuery"),
						"aria-label": t("searchServiceEditorUsageQuery"),
						disabled: loading,
						onClick: () => { void query(); },
					}, h(RefreshCwGlyph, { size: 18 }))),
				h("div", { className: "bs-usageBody" }, body),
				usage && error !== ""
					? h("p", { className: "bs-usageError", role: "alert" }, t("searchServiceEditorUsageFailed", { message: error }))
					: null);
		}

		/* ================================================================ */
		/* multi-key manage dialog                                           */
		/* ================================================================ */

		function MultiKeyManageDialog(props) {
			const service = props.service || {};
			const [status, setStatus] = useState("loading");
			const [keys, setKeys] = useState([]);
			const [loadError, setLoadError] = useState("");
			const [batch, setBatch] = useState("");
			const [feedback, setFeedback] = useState(null);
			const [actionError, setActionError] = useState("");
			const [revealed, setRevealed] = useState({});
			const [pendingReveal, setPendingReveal] = useState("");
			const [deletingId, setDeletingId] = useState("");
			const [adding, setAdding] = useState(false);
			const alive = useRef(true);
			useEffect(() => () => { alive.current = false; }, []);
			const load = useCallback(async (quiet) => {
				if (quiet !== true) setStatus("loading");
				try {
					const payload = await apiFetch(servicePath(service) + "/keys");
					if (!alive.current) return;
					if (payload && Array.isArray(payload.keys)) {
						setKeys(payload.keys);
						setStatus("ready");
						setLoadError("");
					} else {
						setKeys([]);
						setStatus("ready");
						setLoadError(t("pin.unknown"));
					}
				} catch (failure) {
					if (!alive.current || isAbortError(failure)) return;
					setStatus("error");
					setLoadError(errorMessage(failure));
				}
			}, [service.id]);
			useEffect(() => { void load(); }, [load]);
			const applyPayload = (payload) => {
				if (props.onState) props.onState(payload);
			};
			const toggleReveal = async (key) => {
				if (revealed[key.id] !== undefined) {
					setRevealed((previous) => {
						const next = { ...previous };
						delete next[key.id];
						return next;
					});
					return;
				}
				if (pendingReveal !== "") return;
				setPendingReveal(key.id);
				setActionError("");
				try {
					const payload = await apiMutate("POST", servicePath(service) + "/keys/" + encodeURIComponent(key.id) + "/reveal");
					if (!alive.current) return;
					const value = payload && typeof payload.value === "string" ? payload.value : "";
					if (value === "") {
						setActionError(t("searchApiKeysPageLoadFailed", { message: t("pin.unknown") }));
					} else {
						setRevealed((previous) => ({ ...previous, [key.id]: value }));
					}
				} catch (failure) {
					if (alive.current && !isAbortError(failure)) setActionError(errorMessage(failure));
				} finally {
					if (alive.current) setPendingReveal("");
				}
			};
			const remove = async (key) => {
				if (deletingId !== "") return;
				setDeletingId(key.id);
				setActionError("");
				try {
					const payload = await apiMutate("DELETE", servicePath(service) + "/keys/" + encodeURIComponent(key.id));
					if (!alive.current) return;
					applyPayload(payload);
					setRevealed((previous) => {
						const next = { ...previous };
						delete next[key.id];
						return next;
					});
					await load(true);
				} catch (failure) {
					if (alive.current && !isAbortError(failure)) setActionError(errorMessage(failure));
				} finally {
					if (alive.current) setDeletingId("");
				}
			};
			const add = async () => {
				const values = parseKeyList(batch);
				if (values.length === 0 || adding) return;
				setAdding(true);
				setActionError("");
				try {
					const payload = await apiMutate("POST", servicePath(service) + "/keys", { values });
					if (!alive.current) return;
					const added = payload && typeof payload.added === "number" ? payload.added : 0;
					const skipped = payload && typeof payload.skipped === "number" ? payload.skipped : 0;
					setFeedback({ added, skipped });
					setBatch("");
					applyPayload(payload);
					await load(true);
				} catch (failure) {
					if (alive.current && !isAbortError(failure)) setActionError(errorMessage(failure));
				} finally {
					if (alive.current) setAdding(false);
				}
			};
			const rows = [];
			for (const key of keys) {
				if (!key || key.id === undefined) continue;
				const value = revealed[key.id];
				const shown = value !== undefined ? value : (typeof key.masked === "string" ? key.masked : "");
				rows.push(h("li", {
					key: String(key.id),
					className: "bs-keyManageRow",
					"data-primary": key.primary === true ? "true" : "false",
					"data-testid": "multi-key-row",
				},
				h("span", { className: "bs-keyRound" }, h(KeyRoundGlyph, { size: 15 })),
				h("span", { className: "bs-keyMask", title: shown }, shown),
				key.primary === true ? h("span", { className: "bs-keyPrimary" }, t("searchApiKeysPagePrimaryBadge")) : null,
				h("button", {
					type: "button",
					className: "bs-iconBtn bs-iconBtnSm",
					"data-testid": "multi-key-reveal-" + String(key.id),
					title: value !== undefined ? t("keyDialog.hide") : t("keyDialog.reveal"),
					"aria-label": value !== undefined ? t("keyDialog.hide") : t("keyDialog.reveal"),
					disabled: pendingReveal === key.id || deletingId !== "",
					onClick: () => { void toggleReveal(key); },
				}, value !== undefined ? h(EyeOffGlyph, { size: 16 }) : h(EyeGlyph, { size: 16 })),
				h("button", {
					type: "button",
					className: "bs-iconBtn bs-iconBtnSm bs-iconBtnDanger",
					"data-testid": "multi-key-delete-" + String(key.id),
					title: t("keyDialog.delete"),
					"aria-label": t("keyDialog.delete"),
					disabled: deletingId === key.id || pendingReveal !== "",
					onClick: () => { void remove(key); },
				}, h(TrashGlyph, { size: 16 }))));
			}
			let list = null;
			if (status === "loading") {
				list = h("p", { className: "bs-usageMuted" }, t("searchApiKeysPageLoading"));
			} else if (status === "error") {
				list = h("div", { className: "bs-keyLoadError" },
					h("p", { className: "bs-usageError", role: "alert" }, t("searchApiKeysPageLoadFailed", { message: loadError })),
					h("button", { type: "button", className: "bs-btn bs-btnSm", onClick: () => { void load(); } }, t("common.retry")));
			} else if (keys.length === 0) {
				list = h("p", { className: "bs-keyEmpty", "data-testid": "multi-key-empty" }, t("searchApiKeysPageEmpty"));
			} else {
				list = h("ul", { className: "bs-keyList bs-keyManageList" }, rows);
			}
			const feedbackText = feedback
				? t("searchApiKeysPageBatchResult", { added: feedback.added, skipped: feedback.skipped })
				: (actionError !== "" ? actionError : "");
			return h(Modal, {
				title: t("searchServiceEditorMultiKeyTitle"),
				onClose: props.onClose,
				size: "keys",
				testId: "multi-key-dialog",
				closeTestId: "multi-key-close",
				footer: null,
			},
			h("div", { className: "bs-keyDialog" },
				h("p", { className: "bs-keyDialogDesc" }, t("searchApiKeysPageDescription")),
				h("div", { className: "bs-keyScroll" }, list),
				h(TextAreaField, {
					id: "bs-keys-batch",
					testId: "multi-key-batch",
					value: batch,
					placeholder: t("searchApiKeysPageBatchHint"),
					rows: 1,
					disabled: adding,
					onChange: (value) => { setBatch(value); setFeedback(null); setActionError(""); },
				}),
				h("div", { className: "bs-keyDialogFoot" },
					h("span", {
						className: "bs-keyFeedback",
						"data-error": actionError !== "" ? "true" : "false",
						"data-added": feedback && feedback.added > 0 ? "true" : "false",
					}, feedbackText),
					h("button", {
						type: "button",
						className: "bs-btn bs-btnFilled bs-btnSm",
						"data-testid": "multi-key-add",
						disabled: adding || parseKeyList(batch).length === 0,
						onClick: () => { void add(); },
					}, t("searchApiKeysPageAdd")))));
		}
		/* ================================================================ */
		/* add / edit dialog                                                 */
		/* ================================================================ */

		function EditDialog(props) {
			const editing = props.mode === "edit";
			const service = editing && props.service ? props.service : {};
			const providers = Array.isArray(props.providers) ? props.providers : [];
			const [type, setType] = useState(() => (editing ? (service.type || "") : defaultType(providers)));
			const descriptor = descriptorOf(providers, type);
			const [name, setName] = useState(editing ? (service.name || "") : "");
			const [nameTouched, setNameTouched] = useState(editing);
			const [apiKey, setApiKey] = useState("");
			const [clearKey, setClearKey] = useState(false);
			const [baseURL, setBaseURL] = useState(editing ? (service.baseURL || "") : "");
			const baseOptionsRef = useRef(editing && service.options && typeof service.options === "object" ? service.options : {});
			const [options, setOptions] = useState(() => initialOptions(descriptorOf(providers, editing ? service.type : defaultType(providers)), baseOptionsRef.current));
			const [keysOpen, setKeysOpen] = useState(false);
			const [formError, setFormError] = useState(null);
			const [busy, setBusy] = useState(false);
			useEffect(() => {
				if (editing || type !== "" || providers.length === 0) return;
				const nextType = defaultType(providers);
				const nextDescriptor = descriptorOf(providers, nextType);
				baseOptionsRef.current = {};
				setType(nextType);
				setOptions(initialOptions(nextDescriptor, {}));
			}, [editing, type, providers]);
			const close = () => {
				if (busy) return;
				props.onClose();
			};
			const changeType = (nextType) => {
				if (!nextType || nextType === type) return;
				const nextDescriptor = descriptorOf(providers, nextType);
				baseOptionsRef.current = {};
				setType(nextType);
				setOptions(initialOptions(nextDescriptor, {}));
				setFormError(null);
				if (!nameTouched) setName("");
			};
			const showKey = editing ? (descriptor ? descriptor.key !== "none" : true) : Boolean(descriptor && descriptor.key !== "none");
			const keyRequired = Boolean(descriptor && descriptor.key === "required");
			const showUrl = editing ? (descriptor ? descriptor.urlField === true : baseURL !== "") : Boolean(descriptor && descriptor.urlField === true);
			const urlRequired = Boolean(descriptor && descriptor.urlRequired === true);
			const urlLabel = urlRequired ? t("searchServicesAddDialogInstanceUrl") : t("searchServicesFieldCustomUrlOptional");
			const keyLabel = descriptor && descriptor.key === "optional" ? t("searchServicesDialogApiKeyOptional") : t("searchServicesDialogApiKey");
			const keySaved = editing && (service.keySet === true || (typeof service.keyCount === "number" && service.keyCount > 0));
			const errorFor = (fieldName) => {
				if (!formError || !formError.field) return null;
				const field = String(formError.field);
				if (fieldName === "key" && (field === "apiKey" || field === "keys" || field === "appendKeys")) return formError.message;
				if (fieldName === "url" && (field === "baseURL" || field === "url")) return formError.message;
				if (fieldName === "name" && field === "name") return formError.message;
				if (fieldName === "type" && field === "type") return formError.message;
				return null;
			};
			const knownFieldError = errorFor("key") || errorFor("url") || errorFor("name") || errorFor("type");
			const submit = async () => {
				if (busy) return;
				const trimmedName = name.trim();
				const trimmedKey = apiKey.trim();
				const trimmedUrl = baseURL.trim();
				if (!editing && !type) {
					setFormError({ message: t("searchServicesAddDialogServiceType"), field: "type" });
					return;
				}
				if (urlRequired && trimmedUrl === "") {
					setFormError({ message: t("searchServicesAddDialogUrlRequired"), field: "baseURL" });
					return;
				}
				if (!editing && keyRequired && trimmedKey === "") {
					setFormError({ message: t("searchServicesAddDialogApiKeyRequired"), field: "apiKey" });
					return;
				}
				const body = {};
				if (editing) {
					if (type && type !== service.type) body.type = type;
					if (trimmedName !== "" && trimmedName !== service.name) body.name = trimmedName;
					if (clearKey) body.keys = [];
					else if (trimmedKey !== "") body.appendKeys = [trimmedKey];
					if (trimmedUrl !== (service.baseURL || "")) body.baseURL = trimmedUrl;
					body.options = buildOptions(descriptor, options, baseOptionsRef.current);
				} else {
					body.type = type;
					const fallbackName = descriptor ? providerName(descriptor) : "";
					if (trimmedName !== "") body.name = trimmedName;
					else if (fallbackName !== "") body.name = fallbackName;
					if (trimmedKey !== "") body.keys = [trimmedKey];
					if (trimmedUrl !== "") body.baseURL = trimmedUrl;
					const builtOptions = buildOptions(descriptor, options, {});
					if (Object.keys(builtOptions).length > 0) body.options = builtOptions;
				}
				setBusy(true);
				setFormError(null);
				try {
					const payload = editing
						? await apiMutate("PUT", servicePath(service), body)
						: await apiMutate("POST", "/services", body);
					props.onSaved(payload, editing ? "edit" : "add");
				} catch (failure) {
					if (isAbortError(failure)) return;
					setFormError({ message: errorMessage(failure), field: failure.field || null });
					setBusy(false);
				}
			};
			const bodyChildren = [];
			if (!editing && props.catalogStatus === "error") {
				bodyChildren.push(h(Banner, {
					key: "catalog-error",
					kind: "error",
					text: t("dialog.catalogError", { message: props.catalogError || "" }),
					onRetry: props.onReloadCatalog,
				}));
			} else if (!editing && providers.length === 0) {
				const catalogWaiting = props.catalogStatus === "loading" || props.catalogStatus === "idle";
				bodyChildren.push(h("p", { key: "catalog-loading", className: "bs-fieldHint" },
					catalogWaiting ? t("dialog.catalogLoading") : t("dialog.catalogEmpty")));
			}
			if (!editing && errorFor("type")) {
				bodyChildren.push(h("p", { key: "type-error", className: "bs-fieldError", role: "alert" }, errorFor("type")));
			}
			if (!editing || providers.length > 0) {
				bodyChildren.push(h("div", { key: "type", className: "bs-field" },
					h("span", { className: "bs-fieldLabel" }, t("searchServicesAddDialogServiceType")),
					h(TypePicker, {
						providers,
						value: type,
						disabled: busy || (!editing && providers.length === 0),
						onChange: changeType,
					})));
			}
			if (descriptor && descriptor.hint) {
				bodyChildren.push(h("p", { key: "hint", className: "bs-fieldHint" }, currentLang() === "en" ? descriptor.hint.en : descriptor.hint.zh));
			}
			if (showKey) {
				bodyChildren.push(h(TextField, {
					key: "key",
					id: "bs-api-key",
					testId: "api-key-input",
					label: keyLabel,
					type: "password",
					value: apiKey,
					placeholder: keySaved && !clearKey ? t("dialog.keySavedPlaceholder") : t("dialog.keyPlaceholder"),
					error: errorFor("key"),
					disabled: busy,
					autoComplete: "new-password",
					onChange: (value) => { setApiKey(value); if (value !== "") setClearKey(false); },
				}));
				if (keySaved && descriptor && descriptor.key !== "none") {
					bodyChildren.push(h("p", { key: "key-clear", className: "bs-fieldHint" },
						h("button", {
							type: "button",
							className: "bs-btn bs-btnSm",
							disabled: busy,
							onClick: () => setClearKey((value) => !value),
						}, clearKey ? t("dialog.keyClearUndo") : t("dialog.keyClear"))));
				}
				if (editing && descriptor && descriptor.key !== "none") {
					const poolCount = keyCountOf(service);
					bodyChildren.push(h("button", {
						key: "multi-key-tile",
						type: "button",
						className: "bs-keyTile",
						"data-testid": "multi-key-tile",
						disabled: busy,
						onClick: () => setKeysOpen(true),
					},
					h("span", { className: "bs-keyTileIcon" }, h(KeyGlyph, { size: 16 })),
					h("span", { className: "bs-keyTileTitle" }, t("searchServiceEditorMultiKeyTitle")),
					h("span", { className: "bs-keyTileCount", "data-empty": poolCount === 0 ? "true" : "false" },
						poolCount === 0
							? t("searchServiceEditorMultiKeyNone")
							: t(poolCount === 1 ? "searchServiceEditorMultiKeyCountOne" : "searchServiceEditorMultiKeyCount", { count: poolCount })),
					h("span", { className: "bs-chev" }, h(ChevronRightGlyph, { size: 16 }))));
				}
			}
			if (showUrl) {
				bodyChildren.push(h(TextField, {
					key: "url",
					id: "bs-base-url",
					testId: "base-url-input",
					label: urlLabel,
					value: baseURL,
					placeholder: descriptor && typeof descriptor.url === "string" && descriptor.url !== ""
						? descriptor.url
						: (urlRequired ? "https://searxng.example.com" : "https://"),
					error: errorFor("url"),
					disabled: busy,
					autoComplete: "off",
					onChange: setBaseURL,
				}));
			}
			if (descriptor && Array.isArray(descriptor.extras)) {
				descriptor.extras.forEach((extra) => {
					if (!extra || typeof extra.key !== "string") return;
					const extraLabel = currentLang() === "en"
						? (typeof extra.en === "string" && extra.en !== "" ? extra.en : extra.key)
						: (typeof extra.zh === "string" && extra.zh !== "" ? extra.zh : extra.key);
					const savedSecret = extra.kind === "password"
						&& baseOptionsRef.current
						&& hasOwn(baseOptionsRef.current, extra.key)
						&& baseOptionsRef.current[extra.key] !== undefined
						&& baseOptionsRef.current[extra.key] !== null
						&& baseOptionsRef.current[extra.key] !== "";
					bodyChildren.push(h(TextField, {
						key: "extra-" + extra.key,
						id: "bs-extra-" + extra.key,
						testId: "extra-" + extra.key,
						label: extraLabel,
						type: extra.kind === "password" ? "password" : (extra.kind === "number" ? "number" : "text"),
						value: options[extra.key] === undefined ? "" : options[extra.key],
						placeholder: savedSecret ? t("dialog.keySavedPlaceholder") : (typeof extra.placeholder === "string" ? extra.placeholder : ""),
						disabled: busy,
						autoComplete: extra.kind === "password" ? "new-password" : "off",
						onChange: (value) => setOptions((previous) => ({ ...previous, [extra.key]: value })),
					}));
				});
			}
			bodyChildren.push(h(TextField, {
				key: "name",
				id: "bs-name",
				testId: "name-input",
				label: t("dialog.name"),
				value: name,
				placeholder: descriptor ? providerName(descriptor) : "",
				error: errorFor("name"),
				disabled: busy,
				autoComplete: "off",
				onChange: (value) => { setName(value); setNameTouched(true); },
			}));
			if (editing && service.usageSupported === true) {
				bodyChildren.push(h(UsageCard, {
					key: "usage",
					service,
					onState: props.onState,
				}));
			}
			if (formError && !knownFieldError) {
				bodyChildren.push(h("p", { key: "form-error", className: "bs-dialogError", role: "alert" }, formError.message));
			}
			const footer = [
				h("button", {
					key: "cancel",
					type: "button",
					className: "bs-btn",
					disabled: busy,
					onClick: close,
				}, t("common.cancel")),
				h("button", {
					key: "save",
					type: "button",
					className: "bs-btn bs-btnFilled",
					"data-testid": "dialog-save",
					disabled: busy || (!editing && providers.length === 0),
					onClick: () => { void submit(); },
				}, busy ? t("dialog.saving") : (editing ? t("searchServicesEditDialogSave") : t("searchServicesAddDialogAdd"))),
			];
			const modal = h(Modal, {
				title: editing ? t("dialog.editTitle") : t("searchServicesAddDialogTitle"),
				onClose: close,
				size: editing ? "edit" : "add",
				testId: editing ? "edit-dialog" : "add-dialog",
				closeTestId: "dialog-close",
				footer,
			}, bodyChildren);
			if (!editing || !keysOpen) return modal;
			return h(react.Fragment, null, modal,
				h(MultiKeyManageDialog, {
					key: "multi-key-dialog",
					service,
					onClose: () => setKeysOpen(false),
					onState: props.onState,
				}));
		}

		function keyCountOf(service) {
			if (!service) return 0;
			if (typeof service.keyCount === "number" && Number.isFinite(service.keyCount)) return service.keyCount;
			return service.keySet === true ? 1 : 0;
		}

		/* ================================================================ */
		/* delete confirmation                                               */
		/* ================================================================ */

		function ConfirmDelete(props) {
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState(null);
			const service = props.service || {};
			const close = () => { if (!busy) props.onClose(); };
			const run = async () => {
				if (busy) return;
				setBusy(true);
				setError(null);
				try {
					await props.onConfirm();
				} catch (failure) {
					if (isAbortError(failure)) return;
					setError(errorMessage(failure));
					setBusy(false);
				}
			};
			const footer = [
				h("button", {
					key: "cancel",
					type: "button",
					className: "bs-btn",
					disabled: busy,
					onClick: close,
				}, t("common.cancel")),
				h("button", {
					key: "delete",
					type: "button",
					className: "bs-btn bs-btnDanger",
					"data-testid": "confirm-delete",
					disabled: busy,
					onClick: () => { void run(); },
				}, busy ? t("delete.deleting") : t("delete.action")),
			];
			return h(Modal, {
				title: t("delete.title"),
				onClose: close,
				testId: "delete-dialog",
				footer,
			},
			h("p", { className: "bs-confirmText" },
				t("delete.body", { name: displayName(service) })),
			error ? h("p", { className: "bs-fieldError", role: "alert" }, error) : null);
		}

		/* ================================================================ */
		/* common options                                                    */
		/* ================================================================ */

		function CommonOptions(props) {
			const common = props.common || {};
			const limits = props.limits || DEFAULT_LIMITS;
			const maxResults = clamp(typeof common.maxResults === "number" ? common.maxResults : 8, limits.maxResults.min, limits.maxResults.max);
			const timeoutSeconds = timeoutSecondsOf(common.timeoutMs, limits);
			const minSeconds = Math.ceil(limits.timeoutMs.min / 1000);
			const maxSeconds = Math.floor(limits.timeoutMs.max / 1000);
			return h("section", { className: "bs-sectionCard", "data-testid": "common-section" },
				h("div", { className: "bs-row" },
					h("span", { className: "bs-rowIcon" }, h(ToggleGlyph, { size: 18 })),
					h("span", { className: "bs-rowLabel" }, t("searchServicesPageAutoTestTitle")),
					h(Switch, {
						testId: "auto-test",
						label: t("searchServicesPageAutoTestTitle"),
						checked: common.autoTestOnLaunch === true,
						disabled: props.disabled,
						onChange: (value) => props.onChange({ autoTestOnLaunch: value }),
					})),
				h("div", { className: "bs-row" },
					h("span", { className: "bs-rowIcon" }, h(ListGlyph, { size: 18 })),
					h("span", { className: "bs-rowLabel" }, t("searchServicesPageMaxResults")),
					h(Stepper, {
						testId: "max-results",
						value: maxResults,
						min: limits.maxResults.min,
						max: limits.maxResults.max,
						step: 1,
						disabled: props.disabled,
						onChange: (value) => props.onChange({ maxResults: clamp(value, limits.maxResults.min, limits.maxResults.max) }),
					})),
				h("div", { className: "bs-row" },
					h("span", { className: "bs-rowIcon" }, h(ClockGlyph, { size: 18 })),
					h("span", { className: "bs-rowLabel" }, t("searchServicesPageTimeoutSeconds")),
					h(Stepper, {
						testId: "timeout",
						value: timeoutSeconds,
						min: minSeconds,
						max: maxSeconds,
						step: 1,
						disabled: props.disabled,
						onChange: (value) => props.onChange({ timeoutMs: clamp(value, minSeconds, maxSeconds) * 1000 }),
					})));
		}

		/* ================================================================ */
		/* panel page                                                        */
		/* ================================================================ */

		function SearchServicesPanel() {
			const search = useSearchState();
			const catalog = useCatalog();
			const [notice, setNotice] = useState(null);
			const [dialog, setDialog] = useState(null);
			const [deleteTarget, setDeleteTarget] = useState(null);
			const [testingIds, setTestingIds] = useState({});
			const [busyId, setBusyId] = useState("");
			const [commonBusy, setCommonBusy] = useState(false);
			const [fetchBusy, setFetchBusy] = useState(false);
			const [dragId, setDragId] = useState(null);
			const [dropTarget, setDropTarget] = useState(null);
			const dragJustEnded = useRef(false);
			const suppressTimer = useRef(0);
			const data = search.data;
			const services = data && Array.isArray(data.services) ? data.services : [];
			const builtins = data && Array.isArray(data.builtins) ? data.builtins : [];
			const selectedId = data ? data.selectedId : null;
			const common = data && data.common && typeof data.common === "object"
				? data.common
				: { maxResults: 8, timeoutMs: 30000, autoTestOnLaunch: true };
			const pin = data && data.pin && typeof data.pin === "object" ? data.pin : null;
			const fetchState = data && data.fetch && typeof data.fetch === "object"
				? data.fetch
				: { mode: "official", serviceId: "", providerId: "", pin: { ok: true, error: null } };
			const limits = normalizedLimits(catalog.common);
			const loading = search.status === "loading" && !data;
			const applyPayload = useCallback((payload) => {
				if (!payload || typeof payload !== "object") return false;
				const next = payload.state && typeof payload.state === "object" ? payload.state : payload;
				if (!Array.isArray(next.services) && !Array.isArray(next.builtins)) return false;
				search.apply(next);
				return true;
			}, [search.apply]);
			const refreshSoon = useCallback(() => {
				void search.reload({ quiet: true });
			}, [search.reload]);
			const driftSignature = data && data.drift && (data.drift.search || data.drift.fetch)
				? String(data.drift.search ? data.drift.search.actual : "") + "|" + String(data.drift.fetch ? data.drift.fetch.actual : "")
				: "";
			const reconciledRef = useRef("");
			useEffect(() => {
				if (driftSignature === "" || reconciledRef.current === driftSignature) return undefined;
				reconciledRef.current = driftSignature;
				let cancelled = false;
				(async () => {
					try {
						const payload = await apiMutate("POST", "/reconcile");
						if (cancelled) return;
						if (!applyPayload(payload)) refreshSoon();
						const next = payload && payload.state && typeof payload.state === "object" ? payload.state : payload;
						const driftNotice = next && next.notice && typeof next.notice === "object" ? next.notice : null;
						if (!driftNotice) return;
						if (driftNotice.code === "search-external") {
							const english = typeof driftNotice.nameEn === "string" && driftNotice.nameEn !== "";
							setNotice({
								kind: "ok",
								message: t("notice.driftSearch", {
									name: currentLang() === "en" && english
										? driftNotice.nameEn
										: (driftNotice.name || driftNotice.providerId || ""),
								}),
							});
						} else if (driftNotice.code === "search-healed" || driftNotice.code === "fetch-healed") {
							setNotice({ kind: "ok", message: t("notice.driftHealed") });
						} else if (driftNotice.code === "search-foreign") {
							setNotice({ kind: "warn", message: t("notice.driftForeign", { providerId: driftNotice.providerId || "" }) });
						} else {
							setNotice({ kind: "ok", message: t("notice.driftFetch") });
						}
					} catch (failure) {
						if (!cancelled && !isAbortError(failure)) {
							setNotice({ kind: "warn", message: t("notice.driftSyncFailed", { message: errorMessage(failure) }) });
						}
					}
				})();
				return () => { cancelled = true; };
			}, [driftSignature, applyPayload, refreshSoon]);
			useEffect(() => () => {
				if (suppressTimer.current) clearTimeout(suppressTimer.current);
			}, []);
			const fail = (key, failure) => {
				if (isAbortError(failure)) return;
				setNotice({ kind: "error", message: t(key, { message: errorMessage(failure) }) });
			};
			const selectService = async (service) => {
				if (!service || service.id === selectedId || busyId !== "") return;
				setBusyId("select:" + service.id);
				try {
					const payload = await apiMutate("POST", "/select", { id: service.id });
					if (!applyPayload(payload)) refreshSoon();
					setNotice({ kind: "ok", message: t("notice.selected") });
				} catch (failure) {
					fail("notice.selectFailed", failure);
				} finally {
					setBusyId("");
				}
			};
			const editService = (service) => {
				if (!service || service.builtin === true) return;
				if (catalog.status === "error" || catalog.status === "idle") void catalog.reload();
				setDialog({ mode: "edit", service });
			};
			const openAdd = () => {
				if (catalog.status === "error" || catalog.status === "idle") void catalog.reload();
				setDialog({ mode: "create" });
			};
			const closeDialog = () => setDialog(null);
			const savedDialog = (payload, mode) => {
				setDialog(null);
				if (!applyPayload(payload)) refreshSoon();
				setNotice({ kind: "ok", message: mode === "add" ? t("notice.added") : t("notice.saved") });
			};
			const testService = async (service) => {
				if (!service || testingIds[service.id] === true) return;
				setTestingIds((previous) => ({ ...previous, [service.id]: true }));
				try {
					const payload = await apiMutate("POST", servicePath(service) + "/test");
					const result = payload && payload.result && typeof payload.result === "object" ? payload.result : null;
					const ms = result && typeof result.ms === "number" && Number.isFinite(result.ms) ? result.ms : null;
					if (result && result.ok === false) {
						setNotice({ kind: "error", message: t("notice.testFailed", { message: result.error === undefined || result.error === null ? "" : String(result.error) }) });
					} else {
						setNotice({ kind: "ok", message: ms === null ? t("notice.testOkNoMs") : t("notice.testOk", { ms }) });
					}
					if (!applyPayload(payload)) refreshSoon();
				} catch (failure) {
					fail("notice.testFailed", failure);
					refreshSoon();
				} finally {
					setTestingIds((previous) => {
						const next = { ...previous };
						delete next[service.id];
						return next;
					});
				}
			};
			const askDelete = (service) => {
				if (!service || service.builtin === true) return;
				setDeleteTarget(service);
			};
			const confirmDelete = async () => {
				if (!deleteTarget) return;
				await apiMutate("DELETE", servicePath(deleteTarget));
				setDeleteTarget(null);
				setNotice({ kind: "ok", message: t("notice.deleted") });
				refreshSoon();
			};
			const reorder = async (ids) => {
				try {
					const payload = await apiMutate("POST", "/reorder", { ids });
					if (!applyPayload(payload)) refreshSoon();
					setNotice({ kind: "ok", message: t("notice.reordered") });
				} catch (failure) {
					fail("notice.reorderFailed", failure);
					refreshSoon();
				}
			};
			const clearDrag = () => {
				setDragId(null);
				setDropTarget(null);
			};
			const startDrag = (service, event) => {
				if (!event || !event.dataTransfer) return;
				try {
					event.dataTransfer.effectAllowed = "move";
					event.dataTransfer.setData("text/plain", service.id);
				} catch {
					/* the drag still works through module state */
				}
				dragJustEnded.current = false;
				setDragId(service.id);
			};
			const overDrag = (service, event) => {
				if (!event || !dragId || dragId === service.id || service.id === undefined) return;
				event.preventDefault();
				if (event.dataTransfer) {
					try {
						event.dataTransfer.dropEffect = "move";
					} catch {
						/* older browsers refuse writes here */
					}
				}
				let position = "after";
				const target = event.currentTarget;
				if (target && typeof target.getBoundingClientRect === "function") {
					const rect = target.getBoundingClientRect();
					position = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
				}
				setDropTarget((previous) => (previous && previous.id === service.id && previous.position === position
					? previous
					: { id: service.id, position }));
			};
			const markDragEnded = () => {
				dragJustEnded.current = true;
				if (suppressTimer.current) clearTimeout(suppressTimer.current);
				suppressTimer.current = setTimeout(() => {
					dragJustEnded.current = false;
					suppressTimer.current = 0;
				}, 250);
			};
			const endDrag = () => {
				markDragEnded();
				clearDrag();
			};
			const dropOn = (target, event) => {
				if (!event) return;
				event.preventDefault();
				const sourceId = dragId;
				clearDrag();
				markDragEnded();
				if (!sourceId || !target || sourceId === target.id) return;
				const ids = services.map((service) => service.id);
				const from = ids.indexOf(sourceId);
				const to = ids.indexOf(target.id);
				if (from === -1 || to === -1) return;
				ids.splice(from, 1);
				ids.splice(to, 0, sourceId);
				const unchanged = ids.length === services.length && ids.every((id, index) => id === services[index].id);
				if (!unchanged) void reorder(ids);
			};
			const suppressClick = () => {
				if (suppressTimer.current) {
					clearTimeout(suppressTimer.current);
					suppressTimer.current = 0;
				}
				dragJustEnded.current = false;
			};
			const changeFetch = async (next) => {
				if (fetchBusy) return;
				setFetchBusy(true);
				const mode = next && typeof next.mode === "string" ? next.mode : "official";
				const serviceId = next && typeof next.serviceId === "string" ? next.serviceId : "";
				search.apply(data ? { ...data, fetch: { ...fetchState, mode, serviceId } } : null);
				try {
					const body = { mode };
					if (mode === "service" && serviceId !== "") body.serviceId = serviceId;
					const payload = await apiMutate("PUT", "/fetch", body);
					if (!applyPayload(payload)) refreshSoon();
					setNotice({ kind: "ok", message: t("notice.fetchSaved") });
				} catch (failure) {
					fail("notice.fetchFailed", failure);
					refreshSoon();
				} finally {
					setFetchBusy(false);
				}
			};
			const changeCommon = async (patch) => {
				if (commonBusy) return;
				setCommonBusy(true);
				search.apply(data ? { ...data, common: { ...common, ...patch } } : null);
				try {
					const payload = await apiMutate("PUT", "/common", patch);
					if (!applyPayload(payload)) refreshSoon();
					setNotice({ kind: "ok", message: t("notice.commonSaved") });
				} catch (failure) {
					fail("notice.commonFailed", failure);
					refreshSoon();
				} finally {
					setCommonBusy(false);
				}
			};
			const cards = [];
			for (const builtin of builtins) {
				if (!builtin || builtin.id === undefined) continue;
				cards.push(h(ServiceCard, {
					key: "builtin:" + String(builtin.id),
					service: builtin,
					builtin: true,
					selected: builtin.id === selectedId,
					onSelect: selectService,
					suppressClick: dragJustEnded.current,
					onSuppress: suppressClick,
				}));
			}
			for (const service of services) {
				if (!service || service.id === undefined) continue;
				const drop = dropTarget && dropTarget.id === service.id ? dropTarget : null;
				cards.push(h(ServiceCard, {
					key: "service:" + String(service.id),
					service,
					builtin: false,
					selected: service.id === selectedId,
					testing: testingIds[service.id] === true,
					dragging: dragId === service.id,
					dropPosition: drop ? drop.position : null,
					onSelect: selectService,
					onEdit: editService,
					onTest: testService,
					onDelete: askDelete,
					onDragStart: startDrag,
					onDragOver: overDrag,
					onDragLeave: () => undefined,
					onDrop: dropOn,
					onDragEnd: endDrag,
					suppressClick: dragJustEnded.current,
					onSuppress: suppressClick,
				}));
			}
			const sections = [];
			if (search.error) {
				sections.push(h(Banner, {
					key: "load-error",
					testId: "state-error",
					kind: "error",
					text: t("list.error", { message: search.error }) + (data ? " " + t("list.stale") : ""),
					onRetry: () => { void search.reload(); },
				}));
			}
			if (pin && pin.ok === false) {
				sections.push(h(Banner, {
					key: "pin-warning",
					testId: "pin-warning",
					kind: "warn",
					text: t("pin.warn", { error: pin.error === undefined || pin.error === null || pin.error === "" ? t("pin.unknown") : String(pin.error) }),
				}));
			}
			if (notice) {
				sections.push(h(Banner, {
					key: "notice",
					kind: notice.kind,
					text: notice.message,
					onDismiss: () => setNotice(null),
				}));
			}
			if (loading) {
				sections.push(h("div", { key: "loading", className: "bs-loading", "aria-busy": "true" },
					h("div", { className: "bs-skelCard" }),
					h("div", { className: "bs-skelCard" }),
					h("div", { className: "bs-skelCard" })));
			} else if (data) {
				sections.push(h("ul", { key: "cards", className: "bs-services", "data-testid": "service-list", role: "list" }, cards));
				if (services.length === 0) {
					sections.push(h("div", { key: "empty", className: "bs-empty", "data-testid": "empty-state" },
						h("div", { className: "bs-emptyGlyph" }, h(SearchGlyph, { size: 30 })),
						h("h2", { className: "bs-emptyTitle" }, t("list.emptyTitle")),
						h("p", { className: "bs-emptyHint" }, t("list.emptyHint")),
						h("button", {
							type: "button",
							className: "bs-btn bs-btnFilled",
							"data-testid": "empty-add",
							onClick: openAdd,
						}, h(PlusGlyph, { size: 15 }), t("list.emptyAction"))));
				}
				sections.push(h(FetchModeCard, {
					key: "fetch",
					fetch: fetchState,
					services,
					disabled: fetchBusy,
					onChange: (next) => { void changeFetch(next); },
				}));
				sections.push(h(CommonOptions, {
					key: "common",
					common,
					limits,
					disabled: commonBusy,
					onChange: (patch) => { void changeCommon(patch); },
				}));
				sections.push(h("p", { key: "hint", className: "bs-hint", "data-testid": "footer-hint" }, t("page.footerHint")));
			}
			const providers = catalog.providers;
			return h("div", { className: "bs-root", "data-testid": "better-search-page" },
				h("div", { className: "bs-scroll" },
					h("div", { className: "bs-pane" },
						h("header", { className: "bs-head" },
							h("h1", { className: "bs-title" }, t("searchServicesPageTitle")),
							h("button", {
								type: "button",
								className: "bs-iconBtn",
								"data-testid": "add-service",
								title: t("page.addTooltip"),
								"aria-label": t("page.addTooltip"),
								onClick: openAdd,
							}, h(PlusGlyph, { size: 18 }))),
						sections)),
				dialog
					? h(EditDialog, {
						key: dialog.mode === "edit" && dialog.service ? "edit:" + dialog.service.id : "create",
						mode: dialog.mode,
						service: dialog.service || null,
						providers,
						catalogStatus: catalog.status,
						catalogError: catalog.error,
						onReloadCatalog: () => { void catalog.reload(); },
						onClose: closeDialog,
						onSaved: savedDialog,
						onState: (payload) => { if (!applyPayload(payload)) refreshSoon(); },
					})
					: null,
				deleteTarget
					? h(ConfirmDelete, {
						key: "delete:" + (deleteTarget.id === undefined ? "" : deleteTarget.id),
						service: deleteTarget,
						onClose: () => setDeleteTarget(null),
						onConfirm: confirmDelete,
					})
					: null);
		}

		/* ================================================================ */
		/* plugin                                                            */
		/* ================================================================ */

		function apply(ctx) {
			appCtx = ctx;
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "better-search: dictionaries");
			if (ctx.locale && typeof ctx.locale.bind === "function") tt = ctx.locale.bind(NS);
			ctx.effect(() => mountCss(), "better-search: stylesheet");
			ctx.effect(() => disposeRuntime, "better-search: timers and requests");

			ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: PANEL_ID,
				locale: NS,
			}, SearchServicesPanel));

			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 5,
				locale: NS,
				label: () => t("panel"),
			}, PanelIcon));
		}

		exports.name = "better-search-client";
		exports.inject = ["slots", "locale"];
		exports.apply = apply;
		exports.__bsTest = {
			PanelIcon,
			SearchServicesPanel,
			ServiceCard,
			EditDialog,
			ConfirmDelete,
			CommonOptions,
			StatusPill,
			BrandBadge,
			TypePicker,
			FetchModeSelect,
			FetchModeCard,
			UsageCard,
			MultiKeyManageDialog,
			Banner,
			Modal,
			Switch,
			Stepper,
			TextField,
			TextAreaField,
			mountCss,
			disposeRuntime,
			setTestRuntime,
			CSS,
			zh,
			en,
			API_BASE,
			NS,
			PANEL_ID,
			POLL_MS,
			letterOf,
			maskKey,
			parseKeyList,
			groupProviders,
			filterSupported,
			providerName,
			statusOf,
			displayName,
			buildOptions,
			defaultOptions,
			initialOptions,
			normalizedLimits,
			timeoutSecondsOf,
			keyCountOf,
			formatUsageNumber: usageNumber,
			fetchTargetService,
			brandUrlOf,
			catalogCache: () => catalogCache,
		};
		return module.exports;
	}
});
