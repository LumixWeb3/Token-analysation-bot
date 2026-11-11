'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {TrendingController,validateTrendingRequest}=require('./trending-controller');
const {FeedBook,SCOPE,hash}=require('./network-feed');
const fixture=require('./fixtures/gmgn-network-2026-10-27.json');
const NOW=Date.parse('2026-11-08T12:00:00Z'),clone=x=>JSON.parse(JSON.stringify(x));
function directory(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'v2-trending-'));t.after(()=>{for(const f of fs.readdirSync(d))fs.unlinkSync(path.join(d,f));fs.rmdirSync(d);});return d;}
const receipt=x=>({qualified:true,chain:x.chain,verified_at:new Date(NOW).toISOString(),ui_verified:true,query_verified:true,
  request_sha256:x.request_sha256,config_sha256:x.config_sha256,evidence_refs:['fixture-ui-query-proof']});
const change=(extra={})=>({feed:'trending',expected_version:0,chain:'sol',patch:{filterQuery:{max_created:'6'}},reason:'Fixture-only adaptive scope',source_ids:['PUBLIC_SOURCE_FIXTURE'],...extra});
test('no verifier means explicit unavailable with unchanged canonical exports and no runtime commit',async t=>{
  const d=directory(t),c=new TrendingController({stateDir:d,now:()=>NOW}),before=c.read();
  const files=['sol','robinhood'].map(n=>fs.readFileSync(path.join(__dirname,'filters',n+'.json')));
  const result=await c.update(change());assert.equal(result.status,'UNAVAILABLE');assert.equal(result.changed,false);assert.equal(result.scope_changed,false);
  assert.deepEqual(c.read(),before);assert.deepEqual(fs.readdirSync(d),[]);
  ['sol','robinhood'].forEach((n,i)=>assert.deepEqual(fs.readFileSync(path.join(__dirname,'filters',n+'.json')),files[i]));
  assert.throws(()=>new TrendingController({stateDir:__dirname}),/RUNTIME_DIRECTORY/);
});
test('verified change invalidates frozen authority before verification, commits complete audit and survives restart',async t=>{
  const d=directory(t),events=[];
  const c=new TrendingController({stateDir:d,now:()=>NOW,onScopeChange:()=>events.push('invalidate'),verifyChange:async x=>{events.push('verify');
    assert.equal(x.before_configs[0].filterQuery.max_created,'2200');assert.equal(x.before_configs[0].timeType.max,'h');
    assert.equal(x.after_configs[0].filterQuery.max_created,'6');return receipt(x);}});
  const before=c.read(),result=await c.update(change());assert(result.changed);assert(result.scope_changed);assert.deepEqual(events,['invalidate','verify']);
  assert.equal(result.status,'VERIFIED_AND_COMMITTED');assert.equal(result.version,1);
  const after=new TrendingController({stateDir:d,now:()=>NOW}).read();assert.equal(after.version,1);assert.equal(after.request.params[0].filter.max_created,'360m');
  assert.equal(after.request.params[0].interval,'24h');assert.deepEqual(after.configs[1],before.configs[1]);
  const preserved=clone(after.configs[0]);preserved.filterQuery.max_created='2200';assert.deepEqual(preserved,before.configs[0]);
  const state=JSON.parse(fs.readFileSync(path.join(d,'trending-state.json'),'utf8'));assert.equal(state.audit.length,1);
  assert.deepEqual(state.audit[0].before_configs,before.configs);assert.deepEqual(state.audit[0].after_configs,after.configs);
  assert.equal(state.audit[0].before_config_sha256,before.config_sha256);assert.equal(state.audit[0].after_request_sha256,after.request_sha256);
  assert.equal((await c.update(change())).status,'VERSION_CONFLICT');
  assert.equal((await c.update(change({expected_version:1}))).status,'UNCHANGED');
});
test('missing, stale, future, mismatched or incomplete UI/query proof never commits after a possible source mutation',async t=>{
  const edits=[r=>r.qualified=false,r=>r.ui_verified=false,r=>r.query_verified=false,r=>r.request_sha256='WRONG',r=>r.config_sha256='WRONG',
    r=>r.chain='robinhood',r=>r.verified_at=new Date(NOW-60001).toISOString(),r=>r.verified_at=new Date(NOW+1).toISOString(),r=>r.evidence_refs=[]];
  for(const edit of edits){const d=directory(t),c=new TrendingController({stateDir:d,now:()=>NOW,verifyChange:async x=>{const r=receipt(x);edit(r);return r;}});
    const result=await c.update(change());assert.equal(result.changed,false);assert.equal(result.scope_changed,true);assert.equal(result.status,'INDETERMINATE_SCOPE_CHANGE');
    assert.equal(c.read().version,0);assert.deepEqual(fs.readdirSync(d),[]);}
});
test('one writer retains its lease across awaited verification and stale versions never overwrite later state',async t=>{
  const d=directory(t);let release,started;
  const ready=new Promise(resolve=>{started=resolve;});
  const a=new TrendingController({stateDir:d,now:()=>NOW,verifyChange:x=>{started();return new Promise(resolve=>{release=()=>resolve(receipt(x));});}});
  const b=new TrendingController({stateDir:d,now:()=>NOW,verifyChange:async x=>receipt(x)}),pending=a.update(change());await ready;
  assert.equal((await a.update(change())).status,'BUSY');assert.equal((await b.update(change())).status,'BUSY');
  release();assert((await pending).changed);assert.equal((await b.update(change())).status,'VERSION_CONFLICT');assert.equal(b.read().version,1);
});
test('unknown fields, scopes and unsafe numeric patches are rejected before verifier invocation',async t=>{
  let calls=0;const c=new TrendingController({stateDir:directory(t),now:()=>NOW,verifyChange:async x=>{calls++;return receipt(x);}});
  for(const request of [change({feed:'migrated'}),change({chain:'eth'}),change({patch:{filterQuery:{min_marketcap:true}}}),
    change({patch:{filterQuery:{min_marketcap:'9007199254740992'}}}),change({patch:{filterQuery:{max_created:'9007199254740991'}}}),
    change({patch:{filterQuery:{min_gas_fee:'Infinity'}}}),change({patch:{interval:'1h'}}),change({patch:{filterQuery:{new_filter:'1'}}}),
    change({patch:{filterQuery:{'Pump.fun':'0'}}}),change({source_ids:[]})]){
    const r=await c.update(request);assert.equal(r.changed,false);assert.equal(r.scope_changed,false);assert.equal(r.status,'REJECTED');}
  assert.equal(calls,0);assert.equal(c.read().version,0);
});
test('state corruption is visible and cannot be overwritten as a new clean authority',async t=>{
  const d=directory(t),c=new TrendingController({stateDir:d,now:()=>NOW,verifyChange:async x=>receipt(x)});assert((await c.update(change())).changed);
  const file=path.join(d,'trending-state.json'),raw=JSON.parse(fs.readFileSync(file,'utf8'));raw.configs[0].filterQuery.max_created='50';fs.writeFileSync(file,JSON.stringify(raw));
  assert.throws(()=>c.read(),/STATE_INVALID/);const r=await c.update(change({expected_version:1}));assert.equal(r.status,'REJECTED');assert.equal(r.scope_changed,false);
});
test('durable-write failure after verification is indeterminate and never reports a committed change',async t=>{
  const d=directory(t),c=new TrendingController({stateDir:d,now:()=>NOW,verifyChange:async x=>receipt(x)});
  const rename=fs.renameSync;fs.renameSync=()=>{throw Error('FIXTURE_IO_FAILURE');};let result;
  try{result=await c.update(change());}finally{fs.renameSync=rename;}
  assert.equal(result.changed,false);assert.equal(result.scope_changed,true);assert.equal(result.status,'INDETERMINATE_SCOPE_CHANGE');assert.equal(c.read().version,0);assert.deepEqual(fs.readdirSync(d),[]);
});
test('lease cleanup failure preserves the original outcome and disables further updates',async t=>{
  const d=directory(t),c=new TrendingController({stateDir:d,now:()=>NOW,verifyChange:async()=>{throw Error('FIXTURE_VERIFICATION_FAILED');}});
  const unlink=fs.unlinkSync;fs.unlinkSync=file=>{if(file===path.join(d,'trending-state.lock'))throw Error('FIXTURE_CLEANUP_FAILED');return unlink(file);};let result;
  try{result=await c.update(change());}finally{fs.unlinkSync=unlink;}
  assert.equal(result.status,'INDETERMINATE_SCOPE_CHANGE');assert.equal(result.scope_changed,true);assert.equal(c.read().update_available,false);
  assert.equal(c.read().update_blocker,'LOCK_CLEANUP_FAILED');assert.equal((await c.update(change())).reason,'LOCK_CLEANUP_FAILED');
});
test('a rehashed audit cannot turn an unqualified receipt into verified persisted authority',async t=>{
  const d=directory(t),c=new TrendingController({stateDir:d,now:()=>NOW,verifyChange:async x=>receipt(x)});assert((await c.update(change())).changed);
  const file=path.join(d,'trending-state.json'),state=JSON.parse(fs.readFileSync(file,'utf8'));state.audit[0].receipt.ui_verified=false;
  const {id:recordId,...record}=state.audit[0];state.audit[0]={id:hash(record),...record};const {id:stateId,...body}=state;
  fs.writeFileSync(file,JSON.stringify({id:hash(body),...body}));assert.throws(()=>c.read(),/VERIFICATION_FAILED/);
});
test('instance scope override is explicit isolated authority and collector metadata cannot replace it',()=>{
  const custom=clone(SCOPE.trending);custom.params[0].filter.max_created='8640m';validateTrendingRequest(custom);
  const b=new FeedBook({now:()=>NOW,expectedScopes:{trending:custom}});custom.params[0].filter.max_created='72000m';
  assert.equal(b.snapshot('trending',fixture.trending,SCOPE.trending).accepted,false);
  const request=clone(SCOPE.trending);request.params[0].filter.max_created='8640m';assert(b.snapshot('trending',fixture.trending,request).accepted);
  assert.equal(b.view().groups.find(g=>g.feed==='trending'&&g.chain==='solana').age_filter.max_age_days,6);
  assert.equal(b.view().groups.find(g=>g.feed==='trending'&&g.chain==='solana').age_filter.source,'HOST_RUNTIME_SCOPE_OVERRIDE');
  const bad=clone(SCOPE);bad.migrated.params[0].completed.limit=500;assert.throws(()=>new FeedBook({expectedScopes:bad}),/MIGRATED_SCOPE_OVERRIDE/);
  const unknown=clone(SCOPE.trending);unknown.params[0].filter.unqualified=true;assert.throws(()=>validateTrendingRequest(unknown),/EXPECTED_FILTER/);
  assert.equal(hash(request),b.view().groups.find(g=>g.feed==='trending').request_sha256);
});
