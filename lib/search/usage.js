/**
 * Usage adapters (v2) — balance/quota lookups for the panel.
 *
 * Only two providers expose a usage API (Kelivo's
 * `SearchServiceUsageService.supports`): `tavily` and `linkup`. Each adapter
 * takes `{ service, descriptor, signal?, timeoutMs? }` and resolves to
 * `{ remaining, used?, limit? }` with numbers.
 *
 * - Tavily: `GET <search endpoint with /search→/usage>` with Bearer auth.
 *   Kelivo replaces the last path segment when it is `search` and appends
 *   `usage` otherwise (so a custom gateway URL still works), then reads
 *   `account.plan_usage` / `account.plan_limit`, falling back to
 *   `key.usage` / `key.limit`. `remaining = max(0, limit - used)`.
 * - LinkUp: `GET https://api.linkup.so/v1/credits/balance` with Bearer auth;
 *   `balance` is the remaining credits.
 *
 * Both use a 10-second cap, as the reference does, and the shared HTTP helpers
 * so non-2xx responses throw an `HttpFailure` with the provider's body detail.
 *
 * @module @ds-hu/dsh-better-search/lib/search/usage
 */
import {
  authHeaders,
  requestJson,
  requestTimeout,
  resolveEndpoint,
} from './http.js';

/** Hard cap for a usage request, ported from Kelivo's 10 s timeout. */
const USAGE_TIMEOUT_MS = 10_000;

/**
 * Effective usage deadline: never longer than 10 s.
 *
 * @param {{timeoutMs?: number}} context - usage context.
 * @returns {number} milliseconds.
 */
function usageTimeout(context) {
  return Math.min(requestTimeout(context), USAGE_TIMEOUT_MS);
}

/**
 * Read a JSON number when the value really is one.
 *
 * Kelivo requires Dart `num` (JSON numbers); numeric strings are rejected so a
 * malformed envelope becomes an explicit "missing totals" failure instead of a
 * plausible-looking NaN.
 *
 * @param {unknown} value - candidate.
 * @returns {number|undefined} finite number.
 */
function numberOf(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Build Tavily's usage endpoint from the effective search endpoint.
 *
 * @param {{service: object, descriptor?: object}} context - usage context.
 * @returns {string} usage URL.
 */
function tavilyUsageEndpoint(context) {
  const searchUrl = resolveEndpoint({
    service: context.service,
    descriptor: context.descriptor,
    endpoint: 'https://api.tavily.com/search',
  });
  const url = new URL(searchUrl);
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    segments.push('usage');
  } else if (segments[segments.length - 1] === 'search') {
    segments[segments.length - 1] = 'usage';
  } else {
    segments.push('usage');
  }
  url.pathname = `/${segments.join('/')}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/**
 * Tavily plan usage: `account.plan_*` first, then `key.*`.
 *
 * @param {{service: object, descriptor?: object, signal?: AbortSignal, timeoutMs?: number}} context - usage context.
 * @returns {Promise<{remaining: number, used: number, limit: number}>} usage info.
 * @throws {Error} when the response has no usable totals.
 */
export async function tavilyUsage(context) {
  const data = await requestJson(tavilyUsageEndpoint(context), {
    method: 'GET',
    headers: authHeaders({ service: context.service, auth: 'bearer', name: 'Tavily' }),
    signal: context.signal,
    timeoutMs: usageTimeout(context),
    provider: 'Tavily',
  });

  const account = data?.account;
  let used;
  let limit;
  if (account !== null && typeof account === 'object') {
    const accountUsed = numberOf(account.plan_usage);
    const accountLimit = numberOf(account.plan_limit);
    if (accountUsed !== undefined && accountLimit !== undefined) {
      used = accountUsed;
      limit = accountLimit;
    }
  }
  if (used === undefined || limit === undefined) {
    const key = data?.key;
    if (key !== null && typeof key === 'object') {
      const keyUsed = numberOf(key.usage);
      const keyLimit = numberOf(key.limit);
      if (keyUsed !== undefined && keyLimit !== undefined) {
        used = keyUsed;
        limit = keyLimit;
      }
    }
  }
  if (used === undefined || limit === undefined) {
    throw new Error('Tavily usage response is missing usage totals');
  }
  return {
    remaining: Math.max(0, limit - used),
    used,
    limit,
  };
}

/**
 * LinkUp credit balance.
 *
 * @param {{service: object, signal?: AbortSignal, timeoutMs?: number}} context - usage context.
 * @returns {Promise<{remaining: number}>} usage info.
 * @throws {Error} when `balance` is missing or not a number.
 */
export async function linkupUsage(context) {
  const data = await requestJson('https://api.linkup.so/v1/credits/balance', {
    method: 'GET',
    headers: authHeaders({ service: context.service, auth: 'bearer', name: 'LinkUp' }),
    signal: context.signal,
    timeoutMs: usageTimeout(context),
    provider: 'LinkUp',
  });

  const balance = numberOf(data?.balance);
  if (balance === undefined) {
    throw new Error('LinkUp usage response is missing credit balance');
  }
  return { remaining: balance };
}

/** Usage adapters keyed by catalog type id. @type {Readonly<Record<string, (context: any) => Promise<{remaining: number, used?: number, limit?: number}>>>} */
export const USAGE_ADAPTERS = Object.freeze({
  tavily: tavilyUsage,
  linkup: linkupUsage,
});
