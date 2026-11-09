/**
 * twscrape-client.js
 *
 * Node HTTP client for the local X data service on port 4010. NOTE: the live
 * service behind this port is now `x-data-server.js` (logged-in Playwright +
 * X GraphQL), which exposes the SAME routes; the original `twscrape-service/`
 * (app.py) is kept only as a degrade fallback because X started enforcing
 * x-client-transaction-id (twscrape timelines 401). This client talks to
 * the matching browser service on TWSCRAPE_PORT. Data routes now require a
 * versioned request-cleanup acknowledgement; the historical Python service
 * cannot satisfy that contract and is not an automatic safe fallback.
 *
 * Replaces paid xAI x_search with ~$0 self-hosted search + the login-gated
 * community timeline.
 *
 * Resilience: a small cooldown state machine (mirrors the xAI↔OpenRouter
 * pattern in ai-pipeline.js). If the service is down / errors repeatedly, we
 * trip a cooldown and return { ok:false, degraded:true } so the caller can
 * route that one lookup to the paid xAI fallback instead of going blind.
 *
 * Public API:
 *   xSearch(query, {limit, product})      → { ok, query, count, tweets[], sample_activity, velocity:null }
 *   xCommunity(idOrUrl, {limit})          → { ok, community_id, info, posts[], sample_activity, velocity:null }
 *   xUser(handle)                         → { ok, handle, name, followers, ... }
 *   xUserTweets(handle, {limit})          → { ok, handle, tweets[] }
 *   xTweet(idOrUrl)                       → { ok, id, tweet{} }
 *   health()                              → { ok, accounts_active, ... }
 *   communityIdFromUrl(url)               → "1888..." | null
 *   isDegraded()                          → bool (currently in cooldown)
 */

const axios = require('axios');
const { withSampleActivity } = require('./x-sample-activity');

const PORT = process.env.TWSCRAPE_PORT || 4010;
const BASE = process.env.TWSCRAPE_URL || `http://127.0.0.1:${PORT}`;
// Ordinary local requests share an absolute 60s total deadline with the service;
// work ends at 58s with 2s reserved for owned-page cleanup/transport. This is not
// the whole coin/bundle budget. Keep the existing configurable HTTP timeout.
const TIMEOUT_MS = parseInt(process.env.TWSCRAPE_TIMEOUT_MS || '60000', 10);
const COOLDOWN_MS = parseInt(process.env.TWSCRAPE_COOLDOWN_MS || String(5 * 60 * 1000), 10);
const FAIL_THRESHOLD = 2; // consecutive fails before we trip the cooldown

const state = {
  available: null,        // null = unknown, true/false after first call
  cooldownUntil: 0,
  consecutiveFails: 0,
  lastError: null,
  optional_cleanup_blocked: false,
  request_cleanup_blocked: false,
  cleanup_error_code: null,
};

function blockUnverifiedRequestCleanup(code = 'X_REQUEST_CLEANUP_UNVERIFIED') {
  state.request_cleanup_blocked = true;
  state.optional_cleanup_blocked = true; // Compatibility: existing scanner gates block BOTH request types.
  state.cleanup_error_code = code;
}
function blockUnverifiedOptionalCleanup() { blockUnverifiedRequestCleanup('OPTIONAL_SEARCH_CLEANUP_UNVERIFIED'); }

function isDegraded() {
  return Date.now() < state.cooldownUntil;
}

function noteOk() {
  state.available = true;
  state.cooldownUntil = 0;
  state.consecutiveFails = 0;
  state.lastError = null;
}

function noteFail(err) {
  state.available = false;
  state.consecutiveFails += 1;
  state.lastError = err;
  if (state.consecutiveFails >= FAIL_THRESHOLD) {
    state.cooldownUntil = Date.now() + COOLDOWN_MS;
  }
}

/**
 * Core GET. Returns the service JSON on success. On transport failure or a
 * service-level {ok:false}, returns a degraded marker so the caller falls back.
 */
async function call(path, params, { bypassCooldown = false, signal = null, optionalDeadlineMs = null } = {}) {
  const optional = optionalDeadlineMs !== null;
  const deadlineMs = optional ? optionalDeadlineMs : Date.now() + 60000;
  const controlKey = optional ? 'optional_search_control' : 'request_control';
  const cleanupCode = optional ? 'OPTIONAL_SEARCH_CLEANUP_UNVERIFIED' : 'X_REQUEST_CLEANUP_UNVERIFIED';
  const controlFailure = (code, message, cleanupConfirmed) => {
    if (!cleanupConfirmed) blockUnverifiedRequestCleanup(code);
    return { ok: false, degraded: true, error_code: code, error: message, [controlKey]: {
      version: 1, deadline_at_ms: deadlineMs, cleanup_confirmed: cleanupConfirmed,
    } };
  };
  if (state.request_cleanup_blocked) return controlFailure(state.cleanup_error_code, 'Unconfirmed X request cleanup; local requests blocked', false);
  if (optional && (!Number.isSafeInteger(optionalDeadlineMs) || optionalDeadlineMs > Date.now() + 30000)) {
    return controlFailure('OPTIONAL_SEARCH_INVALID_BUDGET', 'Invalid optional search deadline', true);
  }
  if (signal?.aborted || (optional && Date.now() >= optionalDeadlineMs)) {
    return optional ? controlFailure('OPTIONAL_SEARCH_BUDGET_EXPIRED', 'Optional search not started after cancellation/deadline', true)
      : controlFailure('REQUEST_CANCELLED', 'Request cancelled before dispatch', true);
  }
  if (!bypassCooldown && isDegraded()) {
    if (optional) return controlFailure('OPTIONAL_SEARCH_SKIPPED_COOLDOWN', 'Optional search skipped during existing X cooldown', true);
    return { ...controlFailure('X_REQUEST_SKIPPED_COOLDOWN', 'X request skipped during cooldown', true), reason: 'cooldown', cooldown_until: state.cooldownUntil };
  }
  try {
    const res = await axios.get(`${BASE}${path}`, {
      params: { ...params, [optional ? 'optional_deadline_ms' : 'request_deadline_ms']: deadlineMs },
      timeout: TIMEOUT_MS, signal,
    });
    const data = res.data;
    if (data?.[controlKey]?.version !== 1 || data[controlKey].deadline_at_ms !== deadlineMs ||
        data[controlKey].cleanup_confirmed !== true) {
      return controlFailure(cleanupCode, 'X service did not confirm request cleanup', false);
    }
    if (['OPTIONAL_SEARCH_BUDGET_EXPIRED', 'X_REQUEST_BUDGET_EXPIRED', 'REQUEST_CANCELLED'].includes(data?.error_code)) {
      return data; // Deliberate cancellation is not an X/account failure or cooldown event.
    }
    if (signal?.aborted) return controlFailure('REQUEST_CANCELLED', 'Request cancelled after confirmed cleanup', true);
    if (!data || typeof data !== 'object' || data.ok !== true) {
      // Service reached an account but the query failed (e.g. rate-limited).
      // Treat as a soft fail — surface degraded so caller can fall back, but
      // don't necessarily trip the long cooldown on a single empty result.
      const reason = data?.error || 'service returned malformed success payload';
      noteFail(reason);
      return {
        ok: false,
        degraded: true,
        error_code: data?.error_code || 'MALFORMED_SERVICE_RESPONSE',
        error: reason,
        [controlKey]: data[controlKey],
        ...(data?.source_diagnostics ? { source_diagnostics: data.source_diagnostics } : {})
      };
    }
    noteOk();
    return data;
  } catch (e) {
    if (signal?.aborted || e.code === 'ERR_CANCELED') {
      return controlFailure(cleanupCode, 'HTTP cancelled without a service cleanup acknowledgement', false);
    }
    if (!['ECONNABORTED', 'ETIMEDOUT'].includes(e.code)) noteFail(e.message);
    return controlFailure(cleanupCode, 'X transport failed without a cleanup acknowledgement', false);
  }
}

// ---- Public wrappers -------------------------------------------------------

async function xSearch(query, { limit = 10, product = 'Top', bypassCooldown = false, signal = null, optionalDeadlineMs = null } = {}) {
  // Default Top (relevance/engagement-ranked) so keyword/narrative searches
  // provide a qualitative sample, not a population/rate measurement. Pass product:'Latest'
  // for chronological. (The live x-data-server honors this; app.py too.)
  if (!query) return { ok: false, error: 'query required' };
  const response = await call('/search', { q: query, limit, product }, { bypassCooldown, signal, optionalDeadlineMs });
  return withSampleActivity(response, { kind: 'search', requestedProduct: product, limit });
}

async function xCommunity(idOrUrl, { limit = 15, bypassCooldown = false, signal = null } = {}) {
  const id = communityIdFromUrl(idOrUrl) || String(idOrUrl || '').trim();
  if (!/^\d+$/.test(id)) return { ok: false, error: `invalid community id/url: ${idOrUrl}` };
  const response = await call(`/community/${id}`, { limit }, { bypassCooldown, signal });
  return withSampleActivity(response, { kind: 'community', limit });
}

async function xUser(handle, { bypassCooldown = false, signal = null } = {}) {
  const h = String(handle || '').replace(/^@/, '').trim();
  if (!h) return { ok: false, error: 'handle required' };
  return call(`/user/${encodeURIComponent(h)}`, undefined, { bypassCooldown, signal });
}

async function xUserTweets(handle, { limit = 15, bypassCooldown = false, signal = null } = {}) {
  const h = String(handle || '').replace(/^@/, '').trim();
  if (!h) return { ok: false, error: 'handle required' };
  return call(`/user/${encodeURIComponent(h)}/tweets`, { limit }, { bypassCooldown, signal });
}

// Single tweet / status link → { ok, id, tweet:{...} }. Accepts a full status
// URL (preserves the author handle path) or a bare numeric tweet id.
async function xTweet(idOrUrl, { bypassCooldown = false, signal = null } = {}) {
  const s = String(idOrUrl || '').trim();
  if (!s) return { ok: false, error: 'id/url required' };
  const params = /^\d+$/.test(s) ? { id: s } : { url: s };
  const result = await call('/tweet', params, { bypassCooldown, signal });
  if (!result.ok) return result;
  const expectedId = /^\d+$/.test(s) ? s : ((s.match(/status\/(\d+)/) || [])[1] || null);
  if (!expectedId || String(result.id || result.tweet?.id || '') !== expectedId) {
    noteFail('tweet identity mismatch');
    return {
      ok: false,
      degraded: true,
      error_code: 'FOCAL_TWEET_IDENTITY_MISMATCH',
      error: 'X service returned a different tweet than the linked status',
      requested_id: expectedId,
      observed_id: result.id || result.tweet?.id || null
    };
  }
  return result;
}

async function health() {
  try {
    const res = await axios.get(`${BASE}/health`, { timeout: 5000 });
    return res.data;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---- Helpers ---------------------------------------------------------------

/** Pull the numeric community id out of an /i/communities/{id} URL. */
function communityIdFromUrl(url) {
  const m = String(url || '').match(/communities\/(\d+)/);
  return m ? m[1] : null;
}

/** Classify a token.twitter URL so callers know which fetch to use. */
function classifyXUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return { type: 'none' };
  let parsed;
  try { parsed = new URL(raw); } catch (_) { return { type: 'unknown', reason: 'invalid X URL' }; }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (!['x.com', 'twitter.com'].includes(host) || !['https:', 'http:'].includes(parsed.protocol)) {
    return { type: 'unknown', reason: 'linked source is not on X' };
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  const lower = parts.map(part => part.toLowerCase());
  if ((lower[0] === 'i' && lower[1] === 'communities' && /^\d+$/.test(parts[2] || '') && parts.length === 3)
      || (lower[0] === 'communities' && /^\d+$/.test(parts[1] || '') && parts.length === 2)) {
    return { type: 'community', id: parts[lower[0] === 'i' ? 2 : 1] };
  }
  if (/^[a-z0-9_]{1,15}$/i.test(parts[0] || '') && lower[1] === 'status'
      && /^\d+$/.test(parts[2] || '') && parts.length === 3) {
    return { type: 'status', id: parts[2] };
  }
  const reserved = new Set(['i', 'home', 'search', 'explore', 'intent', 'settings', 'notifications', 'messages']);
  if (parts.length === 1 && /^[a-z0-9_]{1,15}$/i.test(parts[0]) && !reserved.has(lower[0])) {
    return { type: 'profile', handle: parts[0] };
  }
  return {
    type: 'unknown',
    reason: lower[0] === 'search'
      ? 'X search pages are optional search inputs, not linked coin evidence'
      : 'unsupported X URL shape'
  };
}

function isSupportedLinkedXUrl(url) {
  const classification = classifyXUrl(url);
  return {
    supported: ['community', 'profile', 'status'].includes(classification.type),
    ...classification
  };
}

module.exports = {
  xSearch,
  xCommunity,
  xUser,
  xUserTweets,
  xTweet,
  health,
  communityIdFromUrl,
  classifyXUrl,
  isSupportedLinkedXUrl,
  isDegraded,
  blockUnverifiedOptionalCleanup,
  blockUnverifiedRequestCleanup,
  _config: { timeout_ms: TIMEOUT_MS },
  _state: () => ({ ...state }),
};
