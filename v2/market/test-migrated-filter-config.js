'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {compileMigratedImport,loadOwnerMigratedFilters}=require('./migrated-filter-config');
const sol=require('./filters/migrated-sol.json'),rh=require('./filters/migrated-robinhood.json');
const clone=x=>JSON.parse(JSON.stringify(x));

test('exact owner exports compile to the current reference without UI/storage changes',()=>{
  const r=loadOwnerMigratedFilters();assert.deepEqual(r.request,require('./scope.json').migrated);
  assert.equal(r.manifest.length,2);assert(r.manifest.every(m=>/^[a-f0-9]{64}$/.test(m.sha256)));
  const a=r.request.params[0].completed,b=r.request.params[1].completed;
  assert.deepEqual(a.launchpad_platform,['Pump.fun','bags_v2','stonkfun_cc','hookedpad','hookd','virtuals']);
  assert.deepEqual(a.quote_address_type,[4,5,3,1,13,26,0]);assert.deepEqual(b.quote_address_type,[11,20,24,12,26,0]);
  assert.equal(a.min_marketcap,25000);assert.equal(a.min_total_fee,4);assert.equal(b.min_total_fee,.14);
  assert.equal(a.max_bundler_rate,.65);assert.equal(a.max_entrapment_ratio,.45);assert.equal(a.max_fresh_wallet_rate,.25);
  assert.deepEqual(b.filters,['not_honeypot','open_source','owner_renounced','is_burnt']);
  assert.equal(a.limit,60);assert(!r.request.params.some(p=>p.new_creation||p.near_completion));
});
test('selected aliases expand exactly; explicitly excluded platforms stay excluded',()=>{
  const r=compileMigratedImport(rh).completed.launchpad_platform;
  for(const key of ['trench_tax','trench_v3_tax','trench','trench_v3','pair_fund_v2','bags_v3','sushi_v2','lunch_pair_v4'])assert(r.includes(key));
  for(const key of ['basedbid','launchhood','memecoinfun','pool_uniswap_v4'])assert(!r.includes(key));
  const c=clone(sol);c.dex.virtuals=false;c.dex.bags_v2=false;
  assert.deepEqual(compileMigratedImport(c).completed.launchpad_platform,['Pump.fun','stonkfun_cc','hookedpad','hookd']);
});
test('RWA selection preserves quote type 26 and can be removed without conflating OTHERS',()=>{
  const c=clone(sol);c.quote.sol_rwa=false;assert.deepEqual(compileMigratedImport(c).completed.quote_address_type,[4,5,3,1,13,0]);
  for(const key of Object.keys(c.quote))c.quote[key]=key==='sol_rwa';assert.deepEqual(compileMigratedImport(c).completed.quote_address_type,[26]);
  delete c.quote.sol_rwa;assert.throws(()=>compileMigratedImport(c),/QUOTES_INCOMPLETE/);
});
test('facet owner and selected branches follow the public builder rather than a hardcoded all-filter default',()=>{
  const c=clone(sol);c.facets.offchain=false;c.facets.holder_reward=false;
  assert.deepEqual(compileMigratedImport(c).completed.filters,['onchain','notHR']);
  c.dex['Pump.fun']=false;c.facets.offchain=true;
  const out=compileMigratedImport(c).completed;assert.deepEqual(out.filters,['offchain']);assert(out.launchpad_platform.includes('Pump.fun'));
  delete c.facets.holder_reward;assert.throws(()=>compileMigratedImport(c),/FACETS_INCOMPLETE/);
});
test('unsupported enabled filters and malformed/inverted bounds fail; explicit zero is retained',()=>{
  const edits=[c=>c.metricsRange.created.max='1',c=>c.social.has_social=true,c=>c.metricsSelect.creator_hold=true,
    c=>c.inputKeywords={search:'test'},c=>c.quote.sol_custom=true,c=>c.dex.unknown=true,
    c=>c.metricsRange.total_fee.min='Infinity',c=>c.metricsRange.total_fee.min=4,
    c=>c.metricsRange.bundler_rate.max='101',c=>c.metricsRange.usd_market_cap.max='1',
    c=>Object.defineProperty(c.metricsRange,'__proto__',{value:{min:'1',max:''},enumerable:true})];
  for(const edit of edits){const c=clone(sol);edit(c);assert.throws(()=>compileMigratedImport(c));}
  const c=clone(sol);c.metricsRange.usd_market_cap.min='0';assert.equal(compileMigratedImport(c).completed.min_marketcap,0);
});
test('wrong lane/chain, non-boolean switches, unknown sections and empty scopes cannot import',()=>{
  for(const edit of [c=>c.currentPage='NewCreations',c=>c.network='eth',c=>c.dex['Pump.fun']='true',
    c=>c.additional='data',c=>{for(const key of Object.keys(c.dex))c.dex[key]=false;},
    c=>{for(const key of Object.keys(c.quote))c.quote[key]=false;}]){
    const c=clone(sol);edit(c);assert.throws(()=>compileMigratedImport(c));
  }
  for(const limit of [0,501,1.5])assert.throws(()=>compileMigratedImport(sol,{limit}));
});
test('only the two named JSON files load and their chain identities must match',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v2-migrated-config-'));
  try{fs.writeFileSync(path.join(dir,'migrated-sol.json'),JSON.stringify(sol));fs.writeFileSync(path.join(dir,'migrated-robinhood.json'),JSON.stringify(rh));fs.writeFileSync(path.join(dir,'unrelated.json'),'not json');
    assert.equal(loadOwnerMigratedFilters(dir).manifest.length,2);
    fs.writeFileSync(path.join(dir,'migrated-sol.json'),JSON.stringify(rh));assert.throws(()=>loadOwnerMigratedFilters(dir),/CHAIN_MISMATCH/);
  }finally{for(const name of ['migrated-sol.json','migrated-robinhood.json','unrelated.json'])fs.unlinkSync(path.join(dir,name));fs.rmdirSync(dir);}
});
