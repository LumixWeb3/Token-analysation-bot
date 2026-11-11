'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {compileImport,loadOwnerFilters}=require('./filter-config');
const sol=require('./filters/sol.json'),rh=require('./filters/robinhood.json');
const clone=x=>JSON.parse(JSON.stringify(x));
const compile=c=>compileImport(c,{platformScope:'ALL_CURRENT_GMGN'});
test('owner scope keeps 24h ranking and 2200-hour maximum age with the saved filters',()=>{
  for(const c of [sol,rh]){const p=compile(c);assert.equal(p.interval,'24h');assert.equal(p.chain,c.network);assert.equal(c.filterQuery.max_created,'2200');assert.equal(c.timeType.max,'h');assert.equal(p.filter.max_created,'132000m');assert.equal(p.filter.min_gas_fee,Number(c.filterQuery.min_gas_fee));assert.deepEqual(p.filter.launchpad_platform,[]);assert.deepEqual(p.filter.filters,c.network==='sol'?['renounced']:[]);assert(!('max_marketcap'in p.filter));assert.equal(p.filter.min_marketcap,100000);}
  // A new selected export key must not accidentally narrow the all-platform scope.
  const future=clone(sol);future.filterQuery.future_launchpad='1';assert.deepEqual(compile(future).filter,compile(sol).filter);
  assert.throws(()=>compileImport(sol),/EXPLICIT_PLATFORM_SCOPE/);
  const subset=clone(rh);subset.filterQuery.pool_uniswap_v4='0';assert.throws(()=>compile(subset),/PARTIAL_LAUNCHPAD/);
});
test('observed Solana NoMint is explicit; disabling it does not inherit it and foreign-chain audit remains rejected',()=>{
  const c=clone(sol);c.filterQuery.renounced='0';assert.deepEqual(compile(c).filter.filters,[]);
  delete c.filterQuery.renounced;assert.deepEqual(compile(c).filter.filters,[]);
  const foreign=clone(rh);foreign.filterQuery.renounced='1';assert.throws(()=>compile(foreign),/UNAPPROVED_SCREENING/);
});
test('MC export is already USD despite a K-unit display; no extra thousand-fold conversion is applied',()=>{
  const historical=clone(sol);delete historical.filterQuery.min_marketcap;assert(!('min_marketcap'in compile(historical).filter));
  for(const value of ['0','-1','NaN','Infinity','9'.repeat(307),true,null]){const c=clone(sol);c.filterQuery.min_marketcap=value;assert.throws(()=>compile(c));}
  const fractional=clone(sol);fractional.filterQuery.min_marketcap='100000.25';assert.equal(compile(fractional).filter.min_marketcap,100000.25);
  const genuineExport=clone(sol);genuineExport.filterQuery.min_marketcap='100000';assert.equal(compile(genuineExport).filter.min_marketcap,100000);
});
test('bad chain, period, units, numeric values and unexpected filters fail instead of defaults',()=>{
  for(const edit of [c=>c.network='eth',c=>c.tab='new',c=>c.timeType.max='w',c=>c.filterQuery.min_gas_fee=true,c=>c.filterQuery.max_created='Infinity',c=>c.filterQuery.frozen='1',c=>c.filterQuery.max_marketcap='1',c=>c.keywordSearch=['stealth'],c=>c.extra='ignored']){const c=clone(sol);edit(c);assert.throws(()=>compile(c));}
});

test('existing day-based exports retain their exact minute conversion',()=>{
  const old=clone(sol);old.filterQuery.max_created='7';old.timeType.max='d';
  assert.equal(compile(old).filter.max_created,'10080m');
});
test('loading is allowlisted and hashes exact files; no runtime/auth/V1 files enter config',()=>{
  const r=loadOwnerFilters();assert.equal(r.manifest.length,2);assert(r.manifest.every(m=>/^[a-f0-9]{64}$/.test(m.sha256)));assert.deepEqual(r.request.params.map(p=>p.chain),['sol','robinhood']);
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'v2-filter-test-'));try{fs.writeFileSync(path.join(d,'sol.json'),JSON.stringify(rh));fs.writeFileSync(path.join(d,'robinhood.json'),JSON.stringify(rh));assert.throws(()=>loadOwnerFilters(d),/CHAIN_MISMATCH/);}finally{for(const n of ['sol.json','robinhood.json'])fs.unlinkSync(path.join(d,n));fs.rmdirSync(d);}
});
