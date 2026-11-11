'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareModelInput, restoreModelInput } = require('./lossless-input');

test('repeated source records retain every field, occurrence, null, zero and literal reference object', () => {
  const record = { source_id: 'a'.repeat(64), text: 'Original public text. '.repeat(80), missing: null,
    zero: 0, empty: '', flag: false, nested: { $ref: '#/values/real-source-content' }, literal: { $object: [] } };
  const packet = { evidence: Array.from({ length: 100 }, () => JSON.parse(JSON.stringify(record))) };
  const result = prepareModelInput(packet);
  assert.equal(result.manifest.mode, 'alphahands.lossless-json.v1');
  assert(result.manifest.delivered_bytes < result.manifest.original_bytes / 10);
  assert.deepEqual(restoreModelInput(JSON.parse(result.text)), packet);
  assert.equal(packet.evidence.length, 100);
});

test('unique small packets stay ordinary JSON and integrity or cyclic references fail visibly', () => {
  const packet = { coin_id: 'solana:fixture', value: 0, missing: null };
  assert.equal(prepareModelInput(packet).text, JSON.stringify(packet));
  const encoded = JSON.parse(prepareModelInput({ rows: Array(20).fill({ text: 'Long original value '.repeat(40) }) }).text);
  const modified = JSON.parse(JSON.stringify(encoded));
  modified.original_packet_sha256 = 'f'.repeat(64);
  assert.throws(() => restoreModelInput(modified), /INTEGRITY/);
  const identifier = Object.keys(encoded.values)[0];
  encoded.values[identifier] = { $ref: '#/values/' + identifier };
  assert.throws(() => restoreModelInput(encoded), /REFERENCE_INVALID/);
});

test('MCP preserves the same complete repeated values through its text and structured representations',()=>{
  const {modelContent}=require('./research-mcp');
  const result={sources:[],rows:Array(100).fill({text:'Repeated public observation '.repeat(50),zero:0,missing:null})};
  const content=modelContent(result);
  assert.equal(content.structuredContent.schema,'alphahands.lossless-json.v1');
  assert.deepEqual(JSON.parse(content.content[0].text),content.structuredContent);
  assert.deepEqual(restoreModelInput(content.structuredContent),result);
});

test('uniform source rows share field names while varied rows and literal table-shaped data remain exact',()=>{
  const packet={wallets:Array.from({length:100},(_,index)=>({wallet_address:'address-'+index,
    current_market_value_usd:index,remaining_token_quantity:index+0.5,missing_value:null,explicit_zero:0})),
    varied:[{value:0},{value:null,extra:'present'},{value:3}],literal:{$table:{columns:['original'],rows:[[0]]}}};
  const result=prepareModelInput(packet),encoded=JSON.parse(result.text);
  assert.equal(encoded.schema,'alphahands.lossless-json.v1');assert(result.text.includes('$table'));
  assert.deepEqual(restoreModelInput(encoded),packet);
});

test('shared parent arrays still use column tables for their distinct source rows',()=>{
  const rows=Array.from({length:100},(_,index)=>({exact_wallet_address:'wallet-'+index,
    current_market_value_usd:index,remaining_token_quantity:index+0.5,missing_value:null,explicit_zero:0}));
  const packet={original:rows,second_capture:structuredClone(rows),top20:rows.slice(0,20)};
  const result=prepareModelInput(packet);
  assert(result.text.includes('$table'));
  assert(result.manifest.delivered_bytes<result.manifest.original_bytes/3);
  assert.deepEqual(restoreModelInput(JSON.parse(result.text)),packet);
});
