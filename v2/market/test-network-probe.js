'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { route, containsPrivateKeys, shape, probe } = require('./network-probe');

(async () => {
  const r = route('https://gmgn.ai/api/v1/major_coin_prices?device_id=PRIVATE&tab_id=PRIVATE&chain=sol&access_token=PRIVATE');
  assert.deepEqual(r.query, [['chain', 'sol']]);
  assert(!JSON.stringify(r).includes('PRIVATE'));
  for (const url of ['https://gmgn.ai.evil.test/api/v1/major_coin_prices', 'http://gmgn.ai/feed',
    'https://user:password@example.com/feed', 'https://gmgn.ai/account/user_info', 'https://gmgn.ai/tapi/v1/wallet/list',
    'https://gmgn.ai/trading_bot/strategy_order/list']) assert.equal(route(url), null);
  assert.equal(route('wss://or1-edge.gmgn.ai/ws').host, 'or1-edge.gmgn.ai');
  assert.equal(containsPrivateKeys({ data: { access_token: 'PRIVATE' } }), true);
  assert.equal(containsPrivateKeys({ data: { user_id: 1 } }), true);
  assert.equal(containsPrivateKeys({ data: [{ token_address: 'mint', symbol: 'coin' }] }), false);
  assert(!JSON.stringify(shape({ data: [{ token_address: 'actual-address', mc: 123 }] })).includes('actual-address'));
  assert.equal(shape({ data: [{ mc: 123 }] }).data.length, 1);
  const inert = spawnSync(process.execPath, [path.join(__dirname, 'network-probe.js')], { encoding: 'utf8' });
  assert.equal(inert.status, 2);
  assert(inert.stderr.includes('Inert by default'));
  await assert.rejects(() => probe({ seconds: 0 }), /OUT_OF_BOUNDS/);
  await assert.rejects(() => probe({ seconds: 31 }), /OUT_OF_BOUNDS/);
  console.log('Network probe offline checks passed: route/privacy filtering, safe shape summaries, inert CLI and duration bounds. No browser launched.');
})().catch(error => { console.error(error); process.exitCode = 1; });
