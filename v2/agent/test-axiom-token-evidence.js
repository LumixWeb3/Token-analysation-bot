'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { publicTokenRoute, projectTokenResponse, observeAxiomTokenResponses } = require('./axiom-token-evidence');
const mint = '8rHoAfpdE89bi1SRRKaYUWfng3YpntoxZQyEQy9GPmZV';
const base = { mint, url: 'https://sol-api2.axiom.trade/token-info-v2?tokenAddress=' + mint, status: 200,
  requestStartedAt: '2026-11-09T10:00:00.000Z', receivedAt: '2026-11-09T10:00:01.000Z' };

test('aggregate evidence preserves zero, exposes missing fields and carries request-only identity', () => {
  const result = projectTokenResponse({ ...base, body: { holderStats: { numHolders: 0, devHoldsPercent: 0 } } });
  assert.equal(result.raw_public.holderStats.numHolders, 0);
  assert.equal(result.raw_public.holderStats.devHoldsPercent, 0);
  assert.equal(result.raw_public.holderStats.top10HoldersPercent, null);
  assert.equal(result.coverage.top20, 'UNVERIFIED');
  assert.equal(result.coverage.percentage_scale, 'UNVERIFIED');
  assert.equal(result.identity_basis, 'EXACT_REQUEST_ONLY_RESPONSE_HAS_NO_MINT');
});

test('only the exact approved public GET request may bind a response', () => {
  for (const url of [base.url + '&tokenAddress=' + mint, base.url + '&access_token=synthetic',
    base.url.replace(mint, '11111111111111111111111111111111'), base.url.replace('sol-api2', 'api2'),
    base.url.replace('/token-info-v2', '/get-settings'), base.url.replace('https:', 'http:')]) {
    assert.throws(() => publicTokenRoute(url, mint), /AXIOM_/);
  }
  assert.throws(() => publicTokenRoute(base.url, mint, 'POST'), /AXIOM_/);
});

test('token body identity is independently checked and unknown data is excluded', () => {
  const input = { ...base, url: base.url.replace('token-info-v2', 'token-and-best-pair-info'),
    body: { token: { tokenAddress: mint, tokenTicker: 'FIXTURE', extra: 'omit' }, private: 'omit' } };
  const result = projectTokenResponse(input);
  assert.equal(result.raw_public.token.tokenTicker, 'FIXTURE');
  assert(!JSON.stringify(result).includes('omit'));
  assert.throws(() => projectTokenResponse({ ...input, body: { token: { tokenAddress: '11111111111111111111111111111111' } } }), /IDENTITY_MISMATCH/);
  assert.throws(() => projectTokenResponse({ ...input, body: { token: { tokenAddress: mint, bestPairAddress: 'one' }, bestPairInfo: { bestPairAddress: 'two' } } }), /PAIR_IDENTITY/);
});

test('failed HTTP, malformed fields, fractional counts and reversed chronology fail visibly', () => {
  const body = { holderStats: { numHolders: 0 } };
  assert.throws(() => projectTokenResponse({ ...base, status: 403, body }), /HTTP_UNAVAILABLE/);
  assert.throws(() => projectTokenResponse({ ...base, body: { holderStats: { numHolders: 1.5 } } }), /COUNT_INVALID/);
  assert.throws(() => projectTokenResponse({ ...base, body: { holderStats: { devHoldsPercent: NaN } } }), /FIELD_INVALID/);
  assert.throws(() => projectTokenResponse({ ...base, receivedAt: base.requestStartedAt, requestStartedAt: base.receivedAt, body }), /TIME_INVALID/);
});

test('passive capture observes only exact token responses and removes both listeners', async () => {
  const page = new EventEmitter();
  const capture = observeAxiomTokenResponses(page, mint);
  const request = { method: () => 'GET' };
  page.emit('request', request);
  page.emit('response', { request: () => request, url: () => base.url, status: () => 200,
    body: async () => Buffer.from(JSON.stringify({ holderStats: { numHolders: 2 } })) });
  page.emit('response', { request: () => request, url: () => 'https://api.axiom.trade/get-settings', body: () => { throw Error('MUST_NOT_READ'); } });
  const result = await capture.finish();
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].raw_public.holderStats.numHolders, 2);
  assert.equal(page.listenerCount('request'), 0);
  assert.equal(page.listenerCount('response'), 0);
  assert.equal(result.failures.length, 0);
});
