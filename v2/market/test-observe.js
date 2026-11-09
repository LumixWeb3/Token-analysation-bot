'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { amount, identity, sourceLink, normalizeFrame, captureFrame } = require('./gmgn');
const { qualifySweep, qualifyCycle, compareSweeps, collectSweep } = require('./observe');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/gmgn-dom-2026-10-26.json'), 'utf8'));
const clone = value => structuredClone(value);
const TIME = '2026-10-26T14:30:00.000Z';
const NOW = '2026-10-26T14:30:10.000Z';
const norm = raw => normalizeFrame(raw, { captureStartedAt: TIME, observedAt: TIME });
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`ok ${passed} - ${name}`); }

function sample(feed) { return clone(fixture.samples.find(s => s.raw.feed === feed).raw); }
function sweepFrames() {
  const source = sample('migrated');
  const base = source.rows.find(r => r.chain_attr === 'sol');
  const rows = [0, 1, 2].map(i => {
    const row = clone(base);
    const address = '1'.repeat(31) + String(i + 2);
    Object.assign(row, { href: `/sol/token/${address}`, address_attr: address,
      key_attr: `${address}-sol`, render_index: i, row_height: 124 });
    return row;
  });
  const frame = (selected, top, seconds) => {
    const raw = { ...clone(source), rows: selected.map(i => clone(rows[i])), scroll: { top, height: 372, client: 124 }, visible_indexes: selected };
    return normalizeFrame(raw, { captureStartedAt: TIME.replace('00.000', `0${seconds}.000`), observedAt: TIME.replace('00.000', `0${seconds}.000`) });
  };
  return [frame([0, 1], 0, 0), frame([1, 2], 248, 1), frame([0, 1], 0, 2)];
}

(async () => {
  await test('live public fixture preserves both chains in each feed', () => {
    for (const { raw, captured_at, capture_started_at } of fixture.samples) {
      const result = normalizeFrame(raw, { observedAt: captured_at, captureStartedAt: capture_started_at });
      assert.deepEqual(result.errors, []);
      assert.deepEqual(result.rows.map(r => r.chain).sort(), ['robinhood', 'solana']);
      assert.equal(result.raw.rows.length, 2);
      assert.equal(result.scope.network_status, 'UNVERIFIED');
      assert.equal(result.scope.filter_hash, null);
      for (const row of result.rows) {
        assert.equal(row.metrics.market_cap_usd.unit, 'USD');
        assert.equal(row.native_fees.unit, row.chain === 'solana' ? 'SOL' : 'ETH');
        assert.equal(row.upstream_updated_at, null);
      }
    }
  });
  await test('native fee unit is independent of quote asset and logo', () => {
    const raw = sample('migrated');
    raw.rows[0].quote_asset = 'PUMP';
    assert.equal(norm(raw).rows[0].native_fees.unit, 'SOL');
    raw.rows[0].fee_icons = ['IconRobinhoodeth16pxS'];
    assert.equal(norm(raw).rows[0].native_fees.value, null);
    assert(norm(raw).errors.some(e => e.startsWith('NATIVE_FEE_UNIT_UNVERIFIED')));
  });
  await test('zero, missing, malformed and boolean values remain distinct', () => {
    assert.equal(amount('$0').value, 0);
    assert.equal(amount('0', 'SOL').value, 0);
    for (const value of [null, undefined, '', '-', '—']) assert.equal(amount(value).state, 'MISSING');
    for (const value of [true, false, 0, '$1,23', '$1M junk', '$-3', '$NaN', '$1e9']) assert.equal(amount(value).state, 'INVALID');
    assert.equal(amount('+$1.25M', 'USD', true).value, 1250000);
    assert.equal(amount('-$1K', 'USD', true).value, -1000);
  });
  await test('labelled MC never falls back to volume', () => {
    const raw = sample('migrated'); raw.rows[0].metrics.mc = [];
    const row = norm(raw).rows[0];
    assert.equal(row.metrics.market_cap_usd.value, null);
    assert(row.metrics.volume_usd.value > 0);
    assert(row.problems.includes('MARKET_CAP_UNAVAILABLE'));
    assert.equal(row.metrics.volume_usd.window, null);
  });
  await test('duplicate metric label is an error rather than first-value selection', () => {
    const raw = sample('migrated'); raw.rows[0].metrics.mc = ['$1K', '$2K'];
    assert(norm(raw).rows[0].problems.includes('AMBIGUOUS_METRIC'));
    assert.equal(norm(raw).rows[0].metrics.market_cap_usd.value, null);
  });
  await test('table column reordering preserves named field semantics', () => {
    const raw = sample('trending'); const before = norm(raw);
    raw.headers.reverse(); raw.rows.forEach(r => r.cells.reverse());
    const after = norm(raw);
    assert.deepEqual(after.errors, []);
    assert.deepEqual(after.rows.map(r => r.metrics), before.rows.map(r => r.metrics));
  });
  await test('duplicate or absent table headers invalidate the frame', () => {
    const raw = sample('trending'); raw.headers[1] = raw.headers[2];
    assert(norm(raw).errors.some(e => e.startsWith('HEADER_NOT_UNIQUE')));
  });
  await test('1h display values retain their actual labelled period', () => {
    const raw = sample('trending');
    raw.headers = raw.headers.map(h => h.replace('24h', '1h')); raw.scope.window = '1h';
    const parsed = norm(raw);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.rows[0].metrics.volume_usd.window, '1h');
    assert(parsed.rows[0].metrics.volume_usd.value > 0);
  });
  await test('exact URL, card attributes and lane must agree', () => {
    for (const change of [r => { r.address_attr = '1'.repeat(32); }, r => { r.chain_attr = 'robinhood'; }, r => { r.lane_attr = 'New'; }]) {
      const raw = sample('migrated'); change(raw.rows[0]);
      assert(norm(raw).errors.some(e => e.startsWith('CARD_IDENTITY_OR_LANE_MISMATCH')));
      assert.equal(norm(raw).rows.length, 1);
    }
  });
  await test('every table cell must carry the exact same row identity', () => {
    const raw = sample('trending'); raw.rows[0].row_keys[3] = raw.rows[1].row_keys[3];
    assert(norm(raw).errors.some(e => e.startsWith('TABLE_IDENTITY_MISMATCH')));
  });
  await test('foreign hosts, malformed addresses and non-token paths fail', () => {
    for (const url of ['https://gmgn.ai.evil.test/sol/token/' + '1'.repeat(32), '/sol/token/' + '2'.repeat(32),
      '/sol/token/notamint', '/sol/token/' + '1'.repeat(32) + '?mint=other', null]) assert.throws(() => identity(url));
    const evm = '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD';
    assert.equal(identity(`/robinhood/token/${evm}`).address, evm.toLowerCase());
  });
  await test('repeated X records and raw URL parameters survive normalization', () => {
    const raw = sample('migrated'); const url = 'https://twitter.com/ExactAuthor/status/1234567890?s=20';
    raw.rows[0].social_urls = [url, url]; const links = norm(raw).rows[0].social_links;
    assert.equal(links.length, 2); assert.equal(links[0].raw, url);
    assert.equal(links[0].canonical_url, 'https://x.com/ExactAuthor/status/1234567890');
    assert.equal(links[0].author, 'ExactAuthor'); assert.equal(links[0].post_id, '1234567890');
    assert.equal(sourceLink('https://x.com.evil.test/user').type, 'INVALID');
    assert.equal(sourceLink('https://x.com/search?q=token').type, 'UNSUPPORTED');
    assert.equal(sourceLink('https://x.com/i/status/1234567890').author, null);
    assert.equal(sourceLink('https://x.com/i/status/1234567890').post_id, '1234567890');
  });
  await test('complete rendered sweep still blocks full-feed and strategy readiness', () => {
    const result = qualifySweep(sweepFrames(), { now: NOW });
    assert.deepEqual(result.coverage_errors, []);
    assert.equal(result.complete_rendered_list, true); assert.equal(result.unique_coins, 3);
    assert.equal(result.complete_feed, false); assert.equal(result.strategy_ready, false);
    assert(result.readiness_blockers.includes('UPSTREAM_FEED_TERMINAL_UNVERIFIED'));
    assert(result.readiness_blockers.includes('CANONICAL_FILTERS_UNVERIFIED'));
  });
  await test('viewport sample, skipped index, missing bottom or missing top cannot be complete', () => {
    const f = sweepFrames();
    assert.equal(qualifySweep([f[0]], { now: NOW }).complete_rendered_list, false);
    const gap = clone(f); gap.forEach(frame => { frame.rows = frame.rows.filter(r => r.render_index !== 1); });
    assert(qualifySweep(gap, { now: NOW }).coverage_errors.includes('RENDER_INDEX_GAP'));
    const missingTop = clone(f); missingTop[2].scroll.top = 1; missingTop[2].rows = [missingTop[2].rows[1]];
    assert(qualifySweep(missingTop, { now: NOW }).coverage_errors.includes('FINAL_TOP_NOT_VERIFIED'));
  });
  await test('dynamic coin reordering fails instead of silently relabelling ranks', () => {
    const f = sweepFrames(); f[1].rows[0].coin_id = f[1].rows[1].coin_id;
    assert(qualifySweep(f, { now: NOW }).coverage_errors.includes('ORDER_CHANGED'));
    const height = sweepFrames(); height[2].scroll.height += 124;
    assert(qualifySweep(height, { now: NOW }).coverage_errors.includes('LIST_HEIGHT_CHANGED'));
  });
  await test('time and scope errors cannot be refreshed through cached success flags', () => {
    const f = sweepFrames();
    assert(qualifySweep(f, { now: '2026-10-26T15:00:00Z' }).coverage_errors.includes('STALE_CAPTURE'));
    assert(qualifySweep(f, { now: '2026-10-25T14:30:00Z' }).coverage_errors.includes('INVALID_OR_FUTURE_TIME'));
    const changed = clone(f); changed[1].scope.window = 'other';
    assert(qualifySweep(changed, { now: NOW }).coverage_errors.includes('SCOPE_CHANGED'));
    const slow = clone(f); slow[0].capture_started_at = '2026-10-26T14:29:00Z';
    assert(qualifySweep(slow, { now: NOW }).coverage_errors.includes('CAPTURE_TOO_SLOW'));
  });
  await test('duplicate identity/index and missing selected chains remain visible errors', () => {
    const raw = sample('migrated'); raw.rows.push(clone(raw.rows[0]));
    assert(norm(raw).errors.some(e => e.startsWith('DUPLICATE_ID_OR_INDEX')));
    raw.scope.selected_chains = []; raw.scope.selection_observed = false;
    assert(norm(raw).errors.includes('SELECTED_CHAINS_UNVERIFIED'));
  });
  await test('comparison retains new observations without claiming delists or freshness', () => {
    const before = qualifySweep(sweepFrames(), { now: NOW });
    const f = sweepFrames(); f.forEach(frame => frame.rows.forEach(r => { r.metrics.market_cap_usd.value *= 2; }));
    const after = qualifySweep(f, { now: NOW }); const diff = compareSweeps(before, after);
    assert.equal(diff.changed.length, 3); assert.equal(diff.disappearance_proven, false);
    assert.notEqual(before.evidence_sha256, after.evidence_sha256);
    after.scope.window = 'other'; assert.throws(() => compareSweeps(before, after), /INCOMPARABLE/);
  });
  await test('cycle requires both exact feed scopes and requalifies source frames', () => {
    const sweep = qualifySweep(sweepFrames(), { now: NOW });
    const cycle = qualifyCycle([sweep], { now: NOW });
    assert.equal(cycle.strategy_ready, false); assert(cycle.blockers.includes('FEED_NOT_UNIQUE:trending'));
    sweep.complete_feed = true; sweep.strategy_ready = true;
    assert.equal(qualifyCycle([sweep], { now: NOW }).strategy_ready, false);
    assert.throws(() => qualifyCycle([], { expectedChains: ['solana', 'solana'] }));
  });
  await test('capture only delegates to the injected read-only browser evaluator', async () => {
    let count = 0;
    const tab = { playwright: { evaluate: async (fn, arg) => {
      assert.equal(typeof fn, 'function'); assert.deepEqual(arg, { feed: 'migrated' }); count++; return sample('migrated');
    } } };
    assert.equal((await captureFrame(tab, 'migrated')).rows.length, 2); assert.equal(count, 1);
    await assert.rejects(() => collectSweep({ capture: null, move: null }), /INVALID_COLLECTION_BOUND/);
  });
  await test('bounded collector uses only Home/PageDown and preserves complete evidence', async () => {
    const actualNow = Date.now;
    let clock = actualNow();
    Date.now = () => { clock += 600; return clock; };
    try {
      let bottom = false; const moves = [];
      const result = await collectSweep({
        capture: async () => {
          const frame = sweepFrames()[bottom ? 1 : 0];
          const time = new Date().toISOString();
          return normalizeFrame(frame.raw, { captureStartedAt: time, observedAt: time });
        },
        move: async key => { moves.push(key); bottom = key === 'PageDown'; }
      });
      assert.deepEqual(moves, ['Home', 'PageDown', 'Home']);
      assert.equal(result.complete_rendered_list, true);
      assert.equal(result.unique_coins, 3); assert.equal(result.strategy_ready, false);
    } finally { Date.now = actualNow; }
  });
  await test('normalized fields cannot silently disagree with immutable raw evidence', () => {
    const f = sweepFrames(); f[0].rows[0].metrics.market_cap_usd.value = 123;
    assert(qualifySweep(f, { now: NOW }).coverage_errors.includes('RAW_NORMALIZED_MISMATCH'));
    assert.equal(qualifySweep(f, { now: NOW }).complete_rendered_list, false);
  });
  await test('serialized synthetic proof preserves coverage and source hashes', () => {
    const frames = JSON.parse(JSON.stringify(sweepFrames()));
    const saved = qualifySweep(frames, { now: NOW });
    const replay = qualifySweep(JSON.parse(JSON.stringify(frames)), { now: NOW });
    assert.equal(replay.evidence_sha256, saved.evidence_sha256);
    assert.deepEqual(replay.coverage_errors, saved.coverage_errors);
    assert.equal(replay.unique_coins, 3);
    assert.equal(replay.complete_rendered_list, true);
  });
  console.log(`${passed} offline market-observation tests passed. No browser, model, service or ledger started.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
