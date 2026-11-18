#!/usr/bin/env node
/**
 * Evaluate the dsh-better-search browser bundle against a mock Cordis context.
 *
 * The browser half is a hand-written classic script that registers a lazy
 * factory with `window.__ModuleLoader__`; no bundler or type-checker ever looks
 * at it, so this script is its compiler. It runs the real file in a `vm` with a
 * fake browser, calls the real factory with a fake `require`, calls the real
 * `apply` with a mock Cordis context, and asserts the registrations the Web
 * shell depends on were actually made: the Settings section (the default
 * management entry), its navigation icon, the optional sidebar module (`main`
 * page + `sidebar.panellist` row), the locale dictionaries, and the stylesheet.
 *
 * Some checks are static (no import/export statements, `require("react")` only,
 * API base string, DSH-only CSS variables): the client may never require
 * anything but `react`, it must stay in module-loader format, and its CSS must
 * use DSH theme tokens instead of hard-coded colors.
 *
 * Offline: nothing here touches the network, the Host or a browser.
 *
 * Run: node test/client-smoke.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clientPath = join(root, 'lib/client.js');
const cssPath = join(root, 'lib/client.css');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const packageName = packageJson.name;

const failures = [];

/**
 * Run one labelled assertion without aborting the audit.
 * @param {string} label - What is being checked.
 * @param {() => void} fn - The check.
 * @returns {void}
 */
async function check(label, fn) {
	try {
		await fn();
		process.stdout.write(`ok   ${label}\n`);
	} catch (error) {
		failures.push(`${label}: ${error.message}`);
		process.stdout.write(`FAIL ${label}\n     ${String(error.message).split('\n').join('\n     ')}\n`);
	}
}

/** Convert a value that may come from another vm realm into plain host data. */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

/** Let the microtask queue drain so `apply()`'s one `/state` read settles. */
function flush() {
	return new Promise((resolve) => setImmediate(resolve));
}

/* ================================================================ */
/* static checks: the shipped files                                  */
/* ================================================================ */

const source = existsSync(clientPath) ? readFileSync(clientPath, 'utf8') : '';
const cssSource = existsSync(cssPath) ? readFileSync(cssPath, 'utf8') : '';
let loadError = null;

await check('lib/client.js exists and is not empty', () => {
	assert.ok(existsSync(clientPath), 'lib/client.js is missing — the Web shell has no browser half to load');
	assert.ok(source.trim().length > 0, 'lib/client.js is empty');
});

await check('lib/client.js parses as a classic script', () => {
	assert.doesNotThrow(() => new vm.Script(source, { filename: 'lib/client.js' }), 'lib/client.js has a syntax error');
});

await check('the browser half is in module-loader format', () => {
	assert.ok(source.includes('window.__ModuleLoader__.load('), 'lib/client.js does not call window.__ModuleLoader__.load(...)');
	assert.ok(source.includes('id: "@ds-hu/dsh-better-search"'), 'the registration id must be "@ds-hu/dsh-better-search"');
	assert.ok(source.includes('factory: (require) =>'), 'the registration needs a factory taking require');
	assert.ok(source.trimEnd().endsWith('});'), 'the module-loader wrapper is not closed at end of file');
});

await check('lib/client.js contains no import/export statements', () => {
	const statements = [...source.matchAll(/^[ \t]*(?:import|export)\b/gu)].map((match) => match[0]);
	assert.deepEqual(statements, [], `module-loader format forbids ESM statements, found: ${JSON.stringify(statements)}`);
});

await check('the browser half never references a bare React global', () => {
	const bare = [...source.matchAll(/\bReact\./gu)].map((match) => match[0]);
	assert.deepEqual(bare, [], `the factory only binds "react"; bare React.* references would crash: ${bare.join(', ')}`);
});

await check('the browser half requires nothing except react', () => {
	const required = [...source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/gu)].map((match) => match[1]);
	const unexpected = required.filter((specifier) => specifier !== 'react');
	assert.deepEqual(unexpected, [], `lib/client.js requires ${unexpected.join(', ')}; only "react" exists in the shell's client module table`);
	assert.ok(required.includes('react'), 'lib/client.js must obtain React through require("react")');
	const calls = [...source.matchAll(/\brequire\s*\(/gu)].length;
	assert.equal(calls, required.length, 'every require() call must be a string literal; the shell cannot resolve a dynamic specifier');
});

await check('the browser half talks only to /better-search/api', () => {
	assert.ok(source.includes('/better-search/api'), 'lib/client.js does not contain the API base "/better-search/api"');
	const literals = [...source.matchAll(/["'`](\/[^"'`\s]{1,})["'`]/gu)].map((match) => match[1]);
	const foreign = literals.filter((path) => /^\/[a-z-]+\/api/u.test(path) && !path.startsWith('/better-search/api'));
	assert.deepEqual(foreign, [], `unexpected API path literal(s): ${foreign.join(', ')}`);
});

await check('the browser half only renders UI (no model-facing tools or Loader rows)', () => {
	assert.ok(!/\bctx\.tools\b/u.test(source), 'the browser half must not touch ctx.tools');
	assert.ok(!/\btools\.register\(/u.test(source), 'the browser half must not register a model-facing tool');
	assert.ok(!/cordis\.patch\.yml/u.test(source), 'the browser half must not edit Loader rows');
});

await check('the browser half never reads stored credentials from the state payload', () => {
	assert.ok(source.includes('keySet'), 'the panel should use keySet to show the saved-key placeholder');
	assert.ok(source.includes('keyCount'), 'the panel should use keyCount for the multi-key count');
	assert.ok(!/service\.apiKey\b/u.test(source), 'the browser half must not render service.apiKey');
	assert.ok(!/service\.apiKeys\b/u.test(source), 'the browser half must not render service.apiKeys');
	assert.ok(!/\.apiKey\b/u.test(source.replace(/body\.apiKey\b/gu, '')), 'the browser half must not read a stored apiKey');
});

await check('key-pool writes use the v2 keys/appendKeys contract', () => {
	assert.ok(source.includes('body.appendKeys'), 'the edit dialog must append a newly typed key with appendKeys');
	assert.ok(/body\.keys = \[\]/u.test(source), 'the explicit clear-all action must send keys: []');
	assert.ok(!source.includes('appendApiKeys'), 'the v1 appendApiKeys payload must be gone');
	assert.ok(!/body\.apiKeys\b/u.test(source), 'the v1 apiKeys payload must be gone');
	assert.ok(!/body\.apiKey\b/u.test(source), 'the v1 apiKey payload must be gone');
});

await check('fetch, usage and key management are wired to the v2 endpoints', () => {
	for (const literal of ['"/keys"', '"/usage"', '"/fetch"', '"/reveal"']) {
		assert.ok(source.includes(literal), `the browser half never calls ${literal}`);
	}
});

await check('lib/client.css exists and mirrors the stylesheet injected by mountCss()', () => {
	assert.ok(existsSync(cssPath), 'lib/client.css is missing');
	assert.ok(cssSource.trim().length > 0, 'lib/client.css is empty');
	const inline = source.match(/const CSS = `\n([\s\S]*?)`;\n/u);
	assert.ok(inline, 'lib/client.js contains no `const CSS = ` template literal');
	assert.equal(inline[1].trim(), cssSource.trim(), 'lib/client.css has drifted from the inline stylesheet');
});

await check('the stylesheet uses only DSH theme variables and no hard-coded colors', () => {
	const colorLiterals = [...cssSource.matchAll(/#[0-9a-fA-F]{3,8}\b|\b(?:rgb|hsl)a?\(/gu)].map((match) => match[0]);
	assert.deepEqual(colorLiterals, [], `hard-coded colors are forbidden, found: ${colorLiterals.join(', ')}`);
	const customVars = [...cssSource.matchAll(/var\((--[a-z0-9-]+)/gu)]
		.map((match) => match[1])
		.filter((name) => !name.startsWith('--dsw-'));
	assert.deepEqual(customVars, [], `CSS may only read DSH theme variables, found: ${[...new Set(customVars)].join(', ')}`);
	assert.ok(cssSource.includes('var(--dsw-font-family)'), 'the stylesheet must inherit the DSH font family');
});

await check('the stylesheet matches the approved geometry', () => {
	assert.ok(/\.bs-title\{[^}]*font-size:14px;font-weight:400/u.test(cssSource), 'panel title must be 14px/400');
	assert.ok(/\.bs-card\{[^}]*border-radius:calc\(var\(--dsw-radius-md\) \+ 2px\)/u.test(cssSource), 'service card radius must be 14px (12 + 2)');
	assert.ok(/\.bs-card\{[^}]*min-height:64px/u.test(cssSource), 'service card min-height must be 64px');
	assert.ok(/\.bs-sectionCard\{[^}]*border-radius:var\(--dsw-radius-md\)/u.test(cssSource), 'section card radius must be 12px');
	assert.ok(/\.bs-iconBtn\{[^}]*width:28px;height:28px/u.test(cssSource), 'icon buttons must be 28×28');
	assert.ok(/\.bs-iconBtn\{[^}]*border-radius:var\(--dsw-radius-sm\)/u.test(cssSource), 'icon buttons must have radius 8px');
	assert.ok(/\.bs-pill\{[^}]*font-size:11px;font-weight:600/u.test(cssSource), 'status pill must be 11px/600');
	assert.ok(/\.bs-hint\{[^}]*font-size:12px;line-height:1\.4/u.test(cssSource), 'footer hint must be 12px/1.4');
	assert.ok(/\.bs-hint\{[^}]*55%/u.test(cssSource), 'footer hint must sit at 55% opacity');
	assert.ok(/\.bs-dialog\{[^}]*width:min\(420px,100%\)/u.test(cssSource), 'dialog must be 420px wide');
	assert.ok(/\.bs-dialog\{[^}]*border-radius:var\(--dsw-radius-lg\)/u.test(cssSource), 'dialog radius must be 16px');
	assert.ok(/\.bs-dialog\[data-size="edit"\]\{[^}]*width:min\(480px,calc\(100% - 32px\)\)/u.test(cssSource), 'the edit dialog must be 480px wide (add stays 420)');
	assert.ok(/\.bs-tag\{[^}]*45%/u.test(cssSource), 'the built-in tag must be plain 45% text');
	assert.ok(!/\.bs-tag\{[^}]*background:/u.test(cssSource), 'the built-in tag must not have a fill');
	assert.ok(/\.bs-fetchRow\{[^}]*padding:8px 12px/u.test(cssSource), 'the fetch row must use h12/v8 padding');
	assert.ok(/\.bs-fetchTrigger\{[^}]*min-width:168px/u.test(cssSource), 'the fetch select must be at least 168px wide');
	assert.ok(/\.bs-fetchBadge\{[^}]*45%/u.test(cssSource), 'the card fetch badge must be a 45% glyph');
	assert.ok(/\.bs-dialog\[data-size="keys"\]\{[^}]*width:min\(440px,calc\(100% - 32px\)\)/u.test(cssSource), 'the multi-key dialog must be 440px wide');
	assert.ok(/\.bs-dialog\[data-size="keys"\]\{[^}]*height:min\(520px,calc\(100% - 32px\)\)/u.test(cssSource), 'the multi-key dialog must be 520px tall');
	assert.ok(/\.bs-usageIcon\{[^}]*width:24px;height:24px/u.test(cssSource), 'the usage wallet must sit in a 24px circle');
	assert.ok(/\.bs-usageRemaining\{[^}]*font-size:17px;font-weight:600/u.test(cssSource), 'usage remaining must be 17px/600');
	assert.ok(/\.bs-usageUsed\{[^}]*font-size:12\.5px/u.test(cssSource), 'usage used/limit must be 12.5px');
	assert.ok(/\.bs-usageBar\{[^}]*height:7px/u.test(cssSource), 'the usage progress bar must be 7px tall');
});

/* ================================================================ */
/* fake browser + Cordis context                                     */
/* ================================================================ */

/**
 * A DOM with exactly one <head>, style-tag creation and the attribute query the
 * CSS-injection idiom uses to stay idempotent.
 * @param {object[]} appended - receives nodes appended to <head>.
 * @returns {object} the fake document.
 */
function createDocument(appended) {
	const makeNode = (tagName) => ({
		tagName,
		dataset: {},
		style: {},
		attrs: {},
		textContent: '',
		children: [],
		parentNode: null,
		setAttribute(name, value) {
			this.attrs[name] = String(value);
		},
		getAttribute(name) {
			return this.attrs[name] ?? null;
		},
		appendChild(child) {
			child.parentNode = this;
			this.children.push(child);
			return child;
		},
		removeChild(child) {
			const index = this.children.indexOf(child);
			if (index >= 0) this.children.splice(index, 1);
			child.parentNode = null;
			return child;
		},
		remove() {
			if (this.parentNode) this.parentNode.removeChild(this);
		},
	});
	const head = makeNode('head');
	head.appendChild = (child) => {
		child.parentNode = head;
		appended.push(child);
		return child;
	};
	head.removeChild = (child) => {
		const index = appended.indexOf(child);
		if (index >= 0) appended.splice(index, 1);
		child.parentNode = null;
		return child;
	};
	head.children = appended;
	const body = makeNode('body');
	return {
		head,
		body,
		documentElement: makeNode('html'),
		activeElement: null,
		visibilityState: 'visible',
		querySelector(selector) {
			const match = /^style\[data-plugin="(.+)"\]$/u.exec(selector);
			if (!match) return null;
			return appended.find((node) => node.tagName === 'style' && node.dataset.plugin === match[1]) ?? null;
		},
		querySelectorAll: () => [],
		createElement: (tagName) => makeNode(tagName),
		createTextNode: (text) => ({ nodeType: 3, textContent: text }),
		addEventListener: () => {},
		removeEventListener: () => {},
	};
}

/** A React stand-in: enough for a module to build element trees, never enough to render them. */
function createReact() {
	const createElement = (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } });
	return {
		createElement,
		Fragment: 'Fragment',
		useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
		useEffect: () => {},
		useLayoutEffect: () => {},
		useRef: (value) => ({ current: value }),
		useCallback: (fn) => fn,
		useMemo: (factory) => factory(),
	};
}

/** Fake timers that record every interval and whether it was cleared. */
function createTimers() {
	const created = [];
	const record = (kind) => {
		const id = created.length + 1;
		created.push({ id, kind, cleared: false });
		return id;
	};
	const clear = (id) => {
		const timer = created.find((candidate) => candidate.id === id);
		if (timer !== undefined) timer.cleared = true;
	};
	return { created, setTimeout: () => record('timeout'), clearTimeout: (id) => clear(id), setInterval: () => record('interval'), clearInterval: (id) => clear(id) };
}

/**
 * Load the browser bundle exactly the way the shell does and apply it.
 * @param {{state?: any}} [options] - payload `GET /state` answers with.
 * @returns {Promise<object>} the loaded plugin plus everything it registered.
 */
async function loadBundle(options = {}) {
	const appended = [];
	const timers = createTimers();
	const document = createDocument(appended);
	const fetchCalls = [];
	const fetch = async (url, init) => {
		const target = String(url);
		fetchCalls.push({ url: target, init });
		const payload = target.endsWith('/state') ? (options.state ?? { ok: true }) : { ok: true };
		return { ok: true, status: 200, json: async () => payload };
	};
	const sandbox = {
		console,
		document,
		fetch,
		navigator: { language: 'zh-CN', userAgent: 'client-smoke' },
		location: { href: 'http://127.0.0.1:3080/', origin: 'http://127.0.0.1:3080', pathname: '/' },
		setTimeout: timers.setTimeout,
		clearTimeout: timers.clearTimeout,
		setInterval: timers.setInterval,
		clearInterval: timers.clearInterval,
		queueMicrotask: (fn) => fn(),
		URL,
		URLSearchParams,
		AbortController,
		AbortSignal,
		TextEncoder,
		TextDecoder,
		structuredClone,
		performance,
		crypto: globalThis.crypto,
	};
	sandbox.window = {};
	Object.assign(sandbox.window, {
		document,
		fetch,
		location: sandbox.location,
		navigator: sandbox.navigator,
		setTimeout: timers.setTimeout,
		clearTimeout: timers.clearTimeout,
		setInterval: timers.setInterval,
		clearInterval: timers.clearInterval,
	});
	sandbox.self = sandbox.window;
	sandbox.globalThis = sandbox;
	let registration;
	sandbox.window.__ModuleLoader__ = {
		load(entry) {
			registration = entry;
		},
	};
	const context = vm.createContext(sandbox);
	vm.runInContext(source, context, { filename: 'lib/client.js' });
	if (!registration) throw new Error('the bundle never called window.__ModuleLoader__.load({ id, factory })');
	if (typeof registration.factory !== 'function') throw new Error('the registration has no factory function');

	const requires = [];
	const loaded = registration.factory((specifier) => {
		requires.push(specifier);
		if (specifier === 'react') return createReact();
		throw new Error(`the client bundle must not require ${specifier}`);
	});
	if (loaded === undefined || loaded === null || typeof loaded !== 'object') throw new Error('the factory returned no exports object');

	const log = { locale: [], slots: [], injected: [], home: [], requires, fetchCalls };
	const dictionaries = {};
	const ctx = {
		locale: {
			register(namespace, dictionary) {
				log.locale.push({ namespace, dictionary });
				dictionaries[namespace] = dictionary;
				return () => {
					delete dictionaries[namespace];
				};
			},
			bind(namespace) {
				return (key) => dictionaries[namespace]?.zh?.[key] ?? key;
			},
		},
		effect(fn, label) {
			const dispose = fn();
			log.home.push({ label, dispose });
			return dispose;
		},
		slots: {
			inject(name, callback) {
				log.injected.push(name);
				const effect = callback();
				const disposers = typeof effect === 'function' ? [effect] : Array.isArray(effect) ? effect : [];
				return () => {
					for (const dispose of disposers) dispose();
				};
			},
			register(definition, component) {
				log.slots.push({ definition, component });
				return () => {
					log.slots = log.slots.filter((entry) => entry.definition !== definition);
				};
			},
		},
	};
	loaded.apply(ctx);
	await flush();
	return { registration, exports: loaded, log, timers, appended, dictionaries, requires, fetchCalls };
}

let bundle = null;
try {
	bundle = source === '' ? null : await loadBundle();
} catch (error) {
	loadError = error;
	process.stdout.write(`FAIL lib/client.js could not be loaded\n     ${String(error.stack ?? error.message).split('\n').slice(0, 8).join('\n     ')}\n`);
}

function bundleOrFail() {
	if (loadError) throw new Error(`lib/client.js did not load: ${loadError.message}`);
	assert.ok(bundle, 'lib/client.js did not load');
	return bundle;
}

/* ================================================================ */
/* runtime checks                                                    */
/* ================================================================ */

await check('the factory registers under the package name', () => {
	const loaded = bundleOrFail();
	assert.equal(loaded.registration.id, packageName, `__ModuleLoader__.load id must equal package.json name (${packageName})`);
});

await check('the module exports a plugin shape', () => {
	const loaded = bundleOrFail();
	assert.equal(typeof loaded.exports.name, 'string', 'the module must export a `name` string');
	assert.ok(loaded.exports.name.length > 0, 'the exported name is empty');
	assert.ok(Array.isArray(loaded.exports.inject), 'the module must export an `inject` array');
	assert.notEqual(loaded.exports.inject.indexOf('slots'), -1, 'inject must include "slots"');
	assert.notEqual(loaded.exports.inject.indexOf('locale'), -1, 'inject must include "locale"');
	assert.equal(typeof loaded.exports.apply, 'function', 'the module must export `apply`');
});

await check('the settings section and its icon are registered', () => {
	const loaded = bundleOrFail();
	const section = loaded.log.slots.find((entry) => entry.definition.name === 'settings.section');
	assert.ok(section, 'settings.section was not registered; Settings would have no management entry');
	assert.equal(section.definition.id, 'better-search', 'settings.section id must be "better-search"');
	assert.equal(section.definition.order, 12, 'settings.section order must place it between Models (10) and Built-in plugins (15)');
	assert.equal(section.definition.locale, 'betterSearch', 'the settings section locale namespace must be "betterSearch"');
	assert.equal(typeof section.definition.label, 'function', 'the settings section needs a navigation label function');
	assert.equal(section.definition.label(), '搜索服务', 'the settings navigation label must resolve to 搜索服务');
	const icon = loaded.log.slots.find((entry) => entry.definition.name === 'settings.section.icon');
	assert.ok(icon, 'settings.section.icon was not registered');
	assert.equal(icon.definition.id, 'better-search', 'settings.section.icon id must match the section id');
	assert.equal(typeof icon.component, 'function', 'the settings icon needs a component');
	assert.deepEqual(
		loaded.log.injected.slice().sort(),
		['main', 'settings.section', 'settings.section.icon', 'sidebar.panellist'],
		'the client registers the Settings entry and the optional sidebar module, nothing else',
	);
	assert.equal(loaded.log.slots.length, 4, `expected four slot registrations, got ${loaded.log.slots.length}`);
});

await check('the sidebar panellist entry is registered as agreed', () => {
	const loaded = bundleOrFail();
	const slot = loaded.log.slots.find((entry) => entry.definition.name === 'sidebar.panellist');
	assert.ok(slot, 'sidebar.panellist was not registered');
	const { definition, component } = slot;
	assert.equal(definition.id, 'better-search', 'sidebar.panellist id must be "better-search"');
	assert.equal(definition.order, 5, 'sidebar.panellist order must be 5');
	assert.equal(definition.locale, 'betterSearch', 'the panel locale namespace must be "betterSearch"');
	assert.equal(typeof definition.label, 'function', 'the panel needs a label function for the sidebar');
	assert.equal(typeof component, 'function', 'the sidebar entry needs an icon component');
	const label = definition.label();
	assert.equal(typeof label, 'string', 'label() must return a translated string');
	assert.ok(label.trim().length > 0, 'label() returned an empty string');
	assert.notEqual(label, 'panel', 'label() returned the raw key; the locale dictionary is not wired up');
	assert.equal(label, '搜索服务', 'zh is the primary locale, label() should resolve to 搜索服务');
});

await check('the main page is registered under key better-search', () => {
	const loaded = bundleOrFail();
	const slot = loaded.log.slots.find((entry) => entry.definition.name === 'main');
	assert.ok(slot, 'the main slot was not registered');
	assert.equal(slot.definition.key, 'better-search', 'the main page key must be "better-search"');
	assert.equal(slot.definition.locale, 'betterSearch', 'the page locale namespace must be "betterSearch"');
	assert.equal(typeof slot.component, 'function', 'the main slot needs a page component');
});

await check('one locale namespace carries zh and en dictionaries', () => {
	const loaded = bundleOrFail();
	assert.equal(loaded.log.locale.length, 1, 'expected exactly one locale.register() call');
	const registration = loaded.log.locale[0];
	assert.equal(registration.namespace, 'betterSearch', 'the locale namespace must be "betterSearch"');
	const dictionary = registration.dictionary;
	assert.ok(dictionary && typeof dictionary === 'object', 'locale.register() got no dictionary');
	assert.ok(dictionary.zh && typeof dictionary.zh === 'object', 'the dictionary is missing the zh half');
	assert.ok(dictionary.en && typeof dictionary.en === 'object', 'the dictionary is missing the en half');
	const zhKeys = Object.keys(dictionary.zh).sort();
	const enKeys = Object.keys(dictionary.en).sort();
	assert.deepEqual(zhKeys, enKeys, 'zh and en dictionaries must carry the same keys');
	assert.ok(zhKeys.length >= 60, `the dictionary looks incomplete (${zhKeys.length} keys)`);
	for (const key of zhKeys) {
		assert.equal(typeof dictionary.zh[key], 'string', `zh.${key} must be a string`);
		assert.equal(typeof dictionary.en[key], 'string', `en.${key} must be a string`);
		assert.ok(dictionary.zh[key].trim().length > 0, `zh.${key} is empty`);
		assert.ok(dictionary.en[key].trim().length > 0, `en.${key} is empty`);
	}
});

await check('the copy comes from the Kelivo UI spec where it exists', () => {
	const dictionary = bundleOrFail().dictionaries.betterSearch;
	assert.ok(dictionary, 'the betterSearch dictionary was not registered');
	const specKeys = [
		'searchServicesPageTitle',
		'searchServicesPageAddProvider',
		'searchServicesPageTestingStatus',
		'searchServicesPageConnectedStatus',
		'searchServicesPageFailedStatus',
		'searchServicesPageNotTestedStatus',
		'searchServicesPageEditServiceTooltip',
		'searchServicesPageTestConnectionTooltip',
		'searchServicesPageDeleteServiceTooltip',
		'searchServicesPageAutoTestTitle',
		'searchServicesPageMaxResults',
		'searchServicesPageTimeoutSeconds',
		'searchServicesAddDialogTitle',
		'searchServicesAddDialogAdd',
		'searchServicesAddDialogInstanceUrl',
		'searchServicesAddDialogServiceType',
		'searchServicesEditDialogSave',
		'searchServicesDialogApiKey',
		'searchServicesDialogApiKeyOptional',
		'searchServicesFieldCustomUrlOptional',
		'searchServiceEditorMultiKeyTitle',
		'searchServiceEditorMultiKeyNone',
		'searchApiKeysPageDescription',
		'searchApiKeysPagePrimaryBadge',
		'searchApiKeysPageBatchHint',
		'searchApiKeysPageBatchResult',
		'searchApiKeysPageAdd',
		'searchApiKeysPageEmpty',
		'searchServicesPageWebFetchModeTitle',
		'searchServicesPageWebFetchFollow',
		'searchServicesPageWebFetchProviderSubtitle',
		'searchServicesPageWebFetchSupported',
		'searchServiceEditorUsageTitle',
		'searchServiceEditorUsageNotQueried',
		'searchServiceEditorUsageQuery',
		'searchServiceEditorUsageQuerying',
		'searchServiceEditorUsageRemaining',
		'searchServiceEditorUsageUsed',
		'searchServiceEditorUsageBalance',
		'searchServiceEditorUsageFailed',
	];
	for (const key of specKeys) {
		assert.equal(typeof dictionary.zh[key], 'string', `zh is missing the spec key "${key}"`);
		assert.equal(typeof dictionary.en[key], 'string', `en is missing the spec key "${key}"`);
	}
	assert.equal(dictionary.zh.searchServicesPageTitle, '搜索服务', 'zh must be the primary title');
	assert.equal(dictionary.zh.searchServicesPageAutoTestTitle, '启动时自动测试连接', 'auto-test copy drifted');
	assert.equal(dictionary.zh.searchServicesPageConnectedStatus, '已连接', 'connected copy drifted');
	assert.equal(dictionary.zh.searchServicesPageTestingStatus, '测试中…', 'testing copy drifted');
	assert.equal(dictionary.zh.searchServicesPageFailedStatus, '连接失败', 'failed copy drifted');
	assert.equal(dictionary.zh.searchServicesPageNotTestedStatus, '未测试', 'not-tested copy drifted');
	assert.equal(dictionary.zh['dialog.keySavedPlaceholder'], '已保存，留空则不修改', 'saved-key placeholder copy drifted');
	assert.equal(dictionary.zh['card.builtin'], '内置', 'built-in tag copy drifted');
	assert.ok(dictionary.zh['page.footerHint'].includes('web_search'), 'footer hint must mention web_search');
	assert.ok(dictionary.en['page.footerHint'].includes('web_search'), 'footer hint must mention web_search');
	assert.equal(dictionary.en.searchServiceEditorMultiKeyCountOne, '{count} key', 'en singular key count drifted');
	assert.equal(dictionary.en.searchServiceEditorMultiKeyCount, '{count} keys', 'en plural key count drifted');
	assert.ok(dictionary.zh.searchServiceEditorMultiKeyCountOne.includes('个 Key'), 'zh key count must stay 个 Key');
	assert.ok(dictionary.zh.searchServiceEditorMultiKeyCount.includes('个 Key'), 'zh key count must stay 个 Key');
	assert.ok(!dictionary.en.searchApiKeysPageBatchResult.includes('(s)'), 'en batch result must not use the (s) plural hack');
	assert.equal(dictionary.zh.searchServicesPageWebFetchModeTitle, '抓取方式', 'fetch row label drifted');
	assert.equal(dictionary.zh.searchServicesPageWebFetchFollow, '跟随搜索服务', 'follow option copy drifted');
	assert.equal(dictionary.zh.searchServicesPageWebFetchFollowOfficial, '当前：官方内置抓取', 'follow + built-in subtitle drifted');
	assert.equal(dictionary.zh['notice.driftFetchKept'], '抓取方式保持「{name}」不变。', 'kept-fetch notice drifted');
	assert.equal(dictionary.en.searchServicesPageWebFetchFollowOfficial, 'Currently: official built-in fetch', 'en follow + built-in subtitle drifted');
	assert.equal(dictionary.en['notice.driftFetchKept'], 'Fetch mode stays “{name}”.', 'en kept-fetch notice drifted');
	assert.equal(dictionary.zh.searchServicesPageWebFetchProviderSubtitle, '使用该服务商的 API Key 和额度', 'provider subtitle drifted');
	assert.equal(dictionary.zh.searchServiceEditorUsageTitle, '账户用量', 'usage title drifted');
	assert.equal(dictionary.zh.searchServiceEditorUsageNotQueried, '尚未查询用量。', 'usage empty copy drifted');
	assert.equal(dictionary.zh.searchServiceEditorUsageQuerying, '查询中…', 'usage loading copy drifted');
	assert.equal(dictionary.zh.searchServiceEditorUsageRemaining, '剩余 {remaining} 额度', 'usage remaining copy drifted');
	assert.equal(dictionary.zh.searchServiceEditorUsageUsed, '已使用 {used} / {limit} 额度', 'usage used copy drifted');
	assert.equal(dictionary.zh.searchServiceEditorUsageBalance, '余额 {balance}', 'usage balance copy drifted');
	assert.equal(dictionary.zh.searchServiceEditorUsageFailed, '用量查询失败：{message}', 'usage failure copy drifted');
	assert.equal(dictionary.zh.searchServicesPageWebFetchUnsupported, '当前搜索服务不支持网页抓取', 'fetch follow warning drifted');
});

await check('the stylesheet is mounted once and removed on dispose', () => {
	const loaded = bundleOrFail();
	const styles = loaded.appended.filter((node) => node.tagName === 'style');
	assert.equal(styles.length, 1, `apply() should mount exactly one <style>, found ${styles.length}`);
	assert.equal(styles[0].dataset.plugin, '@ds-hu/dsh-better-search', 'the style tag must carry data-plugin="@ds-hu/dsh-better-search"');
	assert.ok(styles[0].textContent.trim().length > 0, 'the mounted style tag is empty');
});

await check('CSS mounting is idempotent', () => {
	const loaded = bundleOrFail();
	const api = loaded.exports.__bsTest;
	assert.equal(typeof api.mountCss, 'function', '__bsTest.mountCss is not exported');
	const disposers = [api.mountCss(), api.mountCss()];
	const styles = () => loaded.appended.filter((node) => node.tagName === 'style');
	assert.equal(styles().length, 1, `mountCss() must be idempotent, found ${styles().length} style tags`);
	disposers[0]();
	assert.equal(styles().length, 0, 'the stylesheet was not removed by its release function');
	disposers[1]();
	assert.equal(styles().length, 0, 'a second release must not throw or remove anything else');
	const remount = api.mountCss();
	assert.equal(styles().length, 1, 'mountCss() must mount again after disposal');
	remount();
	assert.equal(styles().length, 0, 'the remounted stylesheet was not removed');
});

await check('apply() reads /state once to decide the sidebar module and starts no timer', () => {
	const loaded = bundleOrFail();
	assert.equal(loaded.log.fetchCalls.length, 1, `apply() should make exactly one request, got ${loaded.log.fetchCalls.length}`);
	assert.ok(loaded.log.fetchCalls[0].url.endsWith('/state'), 'the single request must be GET /state for the persisted UI preference');
	assert.deepEqual(loaded.log.requires, ['react'], 'the factory must require react exactly once');
	const intervals = loaded.timers.created.filter((timer) => timer.kind === 'interval');
	assert.deepEqual(intervals, [], 'apply() must not start an interval; the page effect owns polling');
});

await check('the sidebar module is independent and switchable', async () => {
	const disabled = await loadBundle({ state: { ok: true, ui: { sidebarPanel: false } } });
	assert.equal(disabled.exports.__bsTest.isSidebarModuleMounted(), false, 'a host preference of false must not mount the sidebar module');
	assert.equal(disabled.log.slots.length, 2, 'the sidebar page and row must be unregistered when the module is off');
	assert.deepEqual(
		disabled.log.slots.map((entry) => entry.definition.name).sort(),
		['settings.section', 'settings.section.icon'],
		'only the Settings entry survives when the sidebar module is off',
	);

	const api = disabled.exports.__bsTest;
	api.applySidebarPreference(true);
	assert.equal(api.isSidebarModuleMounted(), true, 'switching the module on must mount it live');
	assert.equal(disabled.log.slots.length, 4, 'switching the module on must register the page and the row');
	const row = disabled.log.slots.find((entry) => entry.definition.name === 'sidebar.panellist');
	assert.equal(row.definition.id, 'better-search', 'the live-mounted sidebar row must keep its id');

	api.applySidebarPreference(false);
	assert.equal(api.isSidebarModuleMounted(), false, 'switching the module off must unmount it live');
	assert.equal(disabled.log.slots.length, 2, 'switching the module off must remove the page and the row');
});

await check('the Settings section renders the sidebar-module switch', () => {
	const api = bundleOrFail().exports.__bsTest;
	const section = api.SearchServicesSettings();
	assert.equal(section.type, api.SearchServicesManager, 'the Settings entry must render the shared manager');
	assert.equal(section.props.variant, 'settings', 'the Settings entry must use the settings variant');
	const card = api.SidebarModuleCard({ enabled: false, disabled: false, onChange: () => {} });
	const serialized = JSON.stringify(card);
	assert.ok(serialized.includes('sidebar-module'), 'the switch is missing its test id');
	assert.ok(serialized.includes('sidebar-module-section'), 'the switch is missing its section card');
	assert.ok(serialized.includes('"checked":false'), 'the switch must reflect the disabled preference');
});

await check('helpers behave as the panel expects', () => {
	const api = bundleOrFail().exports.__bsTest;
	assert.equal(typeof api, 'object', '__bsTest was not exported');

	assert.equal(api.letterOf('Tavily'), 'T', 'letterOf should upper-case the first latin letter');
	assert.equal(api.letterOf('  智谱  '), '智', 'letterOf should keep the first CJK character');
	assert.equal(api.letterOf(''), '?', 'letterOf should fall back to ?');
	assert.equal(api.brandUrlOf('tavily-color.svg'), '/better-search/api/brand/tavily-color.svg', 'brand URLs must be encoded below the API base');
	assert.equal(api.brandUrlOf(null), '', 'a missing brand must not render an image URL');

	assert.equal(api.maskKey('sk-1234567890'), 'sk-1••••7890', 'maskKey should keep 4 + 4 characters');
	assert.equal(api.maskKey('short'), '••••••••', 'maskKey must not reveal short keys');
	assert.equal(Array.from(api.parseKeyList('a b,c;d\n a')).join(','), 'a,b,c,d', 'parseKeyList should split and dedupe');

	const groups = api.groupProviders([
		{ type: 'bing_local', key: 'none' },
		{ type: 'tavily', key: 'required' },
		{ type: 'searxng', key: 'optional', urlRequired: true },
	]);
	assert.deepEqual(Array.from(groups).map((group) => group.key), ['noKey', 'key', 'self'], 'provider groups must be no-key, key, self-hosted');
	assert.deepEqual(Array.from(groups[0].items).map((item) => item.type), ['bing_local'], 'no-key group must hold keyless providers');
	assert.deepEqual(Array.from(groups[2].items).map((item) => item.type), ['searxng'], 'self-hosted group must hold instance providers');

	const filtered = api.filterSupported([{ type: 'a' }, { type: 'b' }], ['b']);
	assert.equal(Array.from(filtered).map((provider) => provider.type).join(','), 'b', 'supportedTypes must filter the type menu');

	assert.equal(api.statusOf({ connected: true }), 'ok', 'connected true is the ok pill');
	assert.equal(api.statusOf({ connected: false }), 'fail', 'connected false is the fail pill');
	assert.equal(api.statusOf({ connected: null }), 'idle', 'connected null is the idle pill');
	assert.equal(api.statusOf({ connected: null }, true), 'test', 'an in-flight test is the testing pill');

	const options = plain(api.buildOptions(
		{ extras: [{ key: 'region' }, { key: 'password', kind: 'password' }] },
		{ region: 'cn-zh', password: '' },
		{ password: 'stored-secret', keep: 'value' },
	));
	assert.deepEqual(options, { password: 'stored-secret', keep: 'value', region: 'cn-zh' }, 'buildOptions must preserve stored secrets and unknown keys');
	const hydrated = plain(api.initialOptions({ extras: [{ key: 'password', kind: 'password' }] }, { password: 'stored-secret' }));
	assert.deepEqual(hydrated, { password: '' }, 'password-kind extras must never be hydrated into an input');

	const limits = plain(api.normalizedLimits({ limits: { maxResults: { min: 2, max: 10 }, timeoutMs: { min: 2000, max: 60000 } } }));
	assert.deepEqual(limits, { maxResults: { min: 2, max: 10 }, timeoutMs: { min: 2000, max: 60000 } }, 'catalog limits must drive the steppers');
	assert.deepEqual(plain(api.normalizedLimits(null)), { maxResults: { min: 1, max: 50 }, timeoutMs: { min: 1000, max: 300000 } }, 'contract limits are the fallback');
	assert.equal(api.timeoutSecondsOf(30000, limits), 30, 'timeout must display in seconds');
	assert.equal(api.timeoutSecondsOf(undefined, limits), 30, 'a missing timeout should display 30 s');
	assert.equal(api.keyCountOf({ keyCount: 2 }), 2, 'keyCountOf should read keyCount');
	assert.equal(api.keyCountOf({ keySet: true }), 1, 'keyCountOf should fall back to keySet');
	assert.equal(api.keyCountOf({}), 0, 'keyCountOf should be 0 for a keyless service');

	assert.equal(api.formatUsageNumber(1234.5), '1,234.5', 'usage numbers use a grouped decimal format');
	assert.equal(api.formatUsageNumber(undefined), '', 'missing usage numbers must not print "undefined"');
	const services = [
		{ id: 'svc_tav001', name: 'Tavily' },
		{ id: 'svc_bra002', name: 'Brave' },
	];
	assert.equal(api.fetchTargetService(services, 'better-search/svc_tav001').name, 'Tavily', 'fetch targets resolve the effective provider id');
	assert.equal(api.fetchTargetService(services, ''), null, 'an unpinned fetch target is null');
	assert.equal(api.fetchTargetService(services, 'better-search/svc_missing'), null, 'unknown fetch targets are null');
});

await check('the panel icon renders a magnifier + spark SVG', () => {
	const api = bundleOrFail().exports.__bsTest;
	const tree = api.PanelIcon({ size: 18, active: true });
	assert.equal(tree.type, 'svg', 'PanelIcon must render an inline <svg>');
	assert.equal(tree.props.width, 18, 'PanelIcon must honour the size prop');
	assert.ok(Array.isArray(tree.props.children) && tree.props.children.length >= 3, 'PanelIcon should draw a magnifier and a spark');
});

/* ================================================================ */

if (failures.length > 0) {
	process.stderr.write(`\n${failures.length} client check(s) failed\n`);
	process.exitCode = 1;
} else {
	process.stdout.write('\nclient-smoke: all checks passed\n');
}
