'use strict';

const crypto = require('node:crypto');
const { normalizeFrame } = require('./gmgn');

function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function scopeKey(frame) {
  const s = frame.scope;
  return JSON.stringify([frame.feed, frame.page_url, s.selected_chains, s.window, s.filter_status, s.filter_hash]);
}
function atTop(frame) { return frame.scroll && frame.scroll.top <= 2; }
function atBottom(frame) {
  const s = frame.scroll;
  return s && s.height > 0 && s.client > 0 && s.top >= Math.max(0, s.height - s.client) - 2;
}

// The browser host supplies capture() and move(key, lastFrame). Only ordinary
// Home/PageDown keyboard navigation is needed; this module controls no desktop.
// Re-read until React's virtual rows AND smooth scrolling have settled.
async function collectSweep({ capture, move, maxSteps = 24, maxDurationMs = 90000 }) {
  if (typeof capture !== 'function' || typeof move !== 'function' || !Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 120 ||
      !Number.isFinite(maxDurationMs) || maxDurationMs <= 0 || maxDurationMs > 120000) throw new Error('INVALID_COLLECTION_BOUND');
  const began = Date.now();
  const frames = [];
  const settled = async (key = null, previousTop = null) => {
    const start = Date.now();
    let stableSince = start;
    let prior = null;
    let latest;
    for (let reads = 0; reads < 250 && Date.now() - start < 6000; reads++) {
      latest = await capture();
      const signature = JSON.stringify([latest.scroll, latest.visible_indexes, latest.rows.map(r => [r.render_index, r.coin_id])]);
      if (signature !== prior) stableSince = Date.now();
      prior = signature;
      const moved = key === 'Home' ? atTop(latest) && latest.visible_indexes.includes(0) : key === 'PageDown' ?
        latest.scroll?.top > previousTop : true;
      // Background Chrome can render at 1 FPS. An unchanged early frame can be
      // the pre-scroll state, so require observed progress and a full paint cycle.
      if (moved && Date.now() - start >= 1100 && Date.now() - stableSince >= 500) return latest;
    }
    const error = new Error('SCROLL_OR_VIRTUAL_ROWS_NOT_SETTLED');
    error.detail = { key, previousTop, scroll: latest?.scroll, visible_indexes: latest?.visible_indexes };
    error.partial_frames = latest ? [...frames, latest] : [...frames];
    throw error;
  };
  try {
    let frame = await capture();
    await move('Home', frame);
    frame = await settled('Home'); frames.push(frame);
    let bound = null;
    for (let step = 0; !atBottom(frame); step++) {
      if (step >= maxSteps || Date.now() - began >= maxDurationMs) { bound = 'COLLECTION_BOUND_REACHED'; break; }
      const priorTop = frame.scroll?.top;
      await move('PageDown', frame);
      frame = await settled('PageDown', priorTop); frames.push(frame);
      if (frame.scroll?.top <= priorTop && !atBottom(frame)) { bound = 'SCROLL_DID_NOT_ADVANCE'; break; }
    }
    // A second bottom observation detects a growing/infinite list, not a server
    // terminal signal. The final top comparison independently checks order drift.
    if (!bound) frames.push(await settled());
    await move('Home', frame);
    frames.push(await settled('Home'));
    if (bound) frames.at(-1).errors.push(bound);
    return qualifySweep(frames);
  } catch (error) {
    if (!error.partial_frames) error.partial_frames = [...frames];
    throw error;
  }
}

// Frames are retained, not flattened into a pretend atomic snapshot. Financial
// fields can change during a sweep; rank/identity changes invalidate its coverage.
function qualifySweep(frames, { now = new Date().toISOString(), maxAgeMs = 120000, maxCaptureMs = 5000 } = {}) {
  if (!Array.isArray(frames) || !frames.length) throw new Error('EMPTY_SWEEP');
  if (!Number.isFinite(Date.parse(now)) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0 ||
      !Number.isFinite(maxCaptureMs) || maxCaptureMs <= 0) throw new Error('INVALID_TIME_POLICY');
  const first = frames[0];
  const final = frames[frames.length - 1];
  const errors = [];
  const byIndex = new Map();
  const idToIndex = new Map();
  const observations = new Map();
  let bottom = null;
  let previousTime = -Infinity;
  for (const frame of frames) {
    if (frame.version !== 1 || !frame.scope || !Array.isArray(frame.rows)) throw new Error('INVALID_FRAME');
    errors.push(...frame.errors.map(e => `FRAME:${e}`));
    try {
      const rebuilt = normalizeFrame(frame.raw, { observedAt: frame.observed_at, captureStartedAt: frame.capture_started_at });
      const fields = ['feed', 'page_url', 'scope', 'rows', 'scroll', 'visible_indexes', 'explicit_empty', 'terminal_evidence'];
      if (hash(fields.map(k => frame[k])) !== hash(fields.map(k => rebuilt[k])) ||
          rebuilt.errors.some(e => !frame.errors.includes(e))) errors.push('RAW_NORMALIZED_MISMATCH');
    } catch { errors.push('RAW_NORMALIZED_MISMATCH'); }
    if (scopeKey(frame) !== scopeKey(first)) errors.push('SCOPE_CHANGED');
    const start = Date.parse(frame.capture_started_at);
    const end = Date.parse(frame.observed_at);
    const current = Date.parse(now);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || start < previousTime ||
        end > current + 5000 || start > current + 5000) errors.push('INVALID_OR_FUTURE_TIME');
    if (current - start > maxAgeMs) errors.push('STALE_CAPTURE');
    if (end - start > maxCaptureMs) errors.push('CAPTURE_TOO_SLOW');
    previousTime = end;
    const s = frame.scroll;
    if (!s || ![s.top, s.height, s.client].every(Number.isFinite) || s.top < 0 || s.client <= 0 || s.height < s.client - 2) errors.push('INVALID_SCROLL_GEOMETRY');
    if (atBottom(frame) && !bottom) bottom = frame;
    for (const row of frame.rows) {
      if (byIndex.has(row.render_index) && byIndex.get(row.render_index) !== row.coin_id) errors.push('ORDER_CHANGED');
      if (idToIndex.has(row.coin_id) && idToIndex.get(row.coin_id) !== row.render_index) errors.push('ORDER_CHANGED');
      byIndex.set(row.render_index, row.coin_id); idToIndex.set(row.coin_id, row.render_index);
      if (!observations.has(row.coin_id)) observations.set(row.coin_id, []);
      observations.get(row.coin_id).push(row);
    }
  }
  if (!atTop(first) || !first.rows.some(r => r.render_index === 0)) errors.push('INITIAL_TOP_NOT_VERIFIED');
  if (!bottom) errors.push('BOTTOM_NOT_REACHED');
  if (frames.length < 3 || !atTop(final) || !final.rows.some(r => r.render_index === 0)) errors.push('FINAL_TOP_NOT_VERIFIED');
  const initialTop = first.rows.map(r => [r.render_index, r.coin_id]);
  const finalTop = new Map(final.rows.map(r => [r.render_index, r.coin_id]));
  if (initialTop.some(([i, id]) => finalTop.get(i) !== id)) errors.push('TOP_REVALIDATION_CHANGED');
  const indexes = [...byIndex.keys()].sort((a, b) => a - b);
  if (!indexes.length || indexes.some((n, i) => n !== i)) errors.push('RENDER_INDEX_GAP');
  if (bottom && first.feed === 'migrated') {
    const heights = new Set(frames.flatMap(f => f.raw.rows.map(r => r.row_height)));
    const height = [...heights][0];
    if (heights.size !== 1 || !(height > 0) || !Number.isInteger(bottom.scroll.height / height) ||
        bottom.scroll.height / height !== indexes.length) errors.push('MIGRATED_GEOMETRY_COUNT_MISMATCH');
  }
  if (bottom && final.scroll?.height !== bottom.scroll.height) errors.push('LIST_HEIGHT_CHANGED');
  const gaps = [...new Set(errors)];
  const completeRendered = gaps.length === 0;
  // No current source adapter proves the upstream result count/pagination or
  // canonical saved filters. Never let a complete DOM sweep imply feed readiness.
  const readinessBlockers = [
    ...gaps,
    'UPSTREAM_FEED_TERMINAL_UNVERIFIED',
    'CANONICAL_FILTERS_UNVERIFIED',
    'UPSTREAM_FRESHNESS_UNVERIFIED'
  ];
  const counts = {};
  for (const list of observations.values()) counts[list[0].chain] = (counts[list[0].chain] || 0) + 1;
  return {
    version: 1, feed: first.feed, scope: first.scope,
    started_at: first.capture_started_at, ended_at: final.observed_at, qualified_at: now,
    complete_rendered_list: completeRendered, complete_feed: false, strategy_ready: false,
    unique_coins: observations.size, chain_counts: counts,
    capture_count: frames.length, coverage_errors: gaps, readiness_blockers: [...new Set(readinessBlockers)],
    observations: [...observations].map(([coin_id, versions]) => ({ coin_id, versions })),
    // Hash the exact public source frames so changing normalized data cannot hide.
    evidence_sha256: hash(frames), frames
  };
}

function compareSweeps(before, after) {
  if (scopeKey({ feed: before.feed, page_url: before.frames[0].page_url, scope: before.scope }) !==
      scopeKey({ feed: after.feed, page_url: after.frames[0].page_url, scope: after.scope })) throw new Error('INCOMPARABLE_SCOPES');
  const prior = new Map(before.observations.map(o => [o.coin_id, o.versions.at(-1)]));
  const current = new Map(after.observations.map(o => [o.coin_id, o.versions.at(-1)]));
  const comparableCoverage = before.complete_rendered_list && after.complete_rendered_list;
  return {
    before_sha256: before.evidence_sha256, after_sha256: after.evidence_sha256,
    comparable_rendered_coverage: comparableCoverage,
    // On partial captures these are newly seen, not necessarily newly listed.
    newly_observed: [...current.keys()].filter(id => !prior.has(id)),
    not_observed_again: [...prior.keys()].filter(id => !current.has(id)),
    disappearance_proven: false, // Ranking/filter movement does not prove a delist.
    changed: [...current].filter(([id, r]) => prior.has(id) && hash([r.metrics, r.native_fees, r.social_links, r.render_index]) !==
      hash([prior.get(id).metrics, prior.get(id).native_fees, prior.get(id).social_links, prior.get(id).render_index])).map(([coin_id]) => coin_id)
  };
}

function qualifyCycle(sweeps, { expectedChains = ['solana', 'robinhood'], now = new Date().toISOString(), maxAgeMs = 120000 } = {}) {
  if (!Array.isArray(sweeps) || !Array.isArray(expectedChains) || !expectedChains.length ||
      new Set(expectedChains).size !== expectedChains.length || expectedChains.some(c => !['solana', 'robinhood'].includes(c))) throw new Error('INVALID_CYCLE_SCOPE');
  const errors = [];
  for (const feed of ['migrated', 'trending']) {
    const matching = sweeps.filter(s => s.feed === feed);
    if (matching.length !== 1) { errors.push(`FEED_NOT_UNIQUE:${feed}`); continue; }
    const sweep = matching[0];
    // Re-qualify evidence at consumption; a cached success flag is insufficient.
    const checked = qualifySweep(sweep.frames, { now, maxAgeMs });
    if (JSON.stringify(checked.scope.selected_chains.slice().sort()) !== JSON.stringify(expectedChains.slice().sort())) errors.push(`CHAIN_SCOPE_MISMATCH:${feed}`);
    errors.push(...checked.readiness_blockers.map(e => `${feed}:${e}`));
  }
  return { version: 1, qualified_at: now, strategy_ready: errors.length === 0,
    blockers: [...new Set(errors)], sweep_hashes: sweeps.map(s => s.evidence_sha256) };
}

module.exports = { collectSweep, qualifySweep, compareSweeps, qualifyCycle };
