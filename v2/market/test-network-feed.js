'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {FeedBook,SCOPE,normalizeToken,hash}=require('./network-feed');
const fixture=require('./fixtures/gmgn-network-2026-10-27.json');
const clone=x=>JSON.parse(JSON.stringify(x));
const START=Date.parse('2026-10-27T12:40:00Z');
function setup(){let clock=START;const b=new FeedBook({now:()=>clock});for(const f of ['migrated','trending']){assert(b.snapshot(f,fixture[f],SCOPE[f]).accepted);b.connection(f,true);}return{b,tick:ms=>clock+=ms};}
function delta(b,feed='migrated',extra={}){const g=[...b.groups.values()].find(g=>g.feed===feed&&g.chain==='sol');const row=[...g.tokens.values()][0];return{channel:feed==='migrated'?'trenches_delta':'trending_multichain_update',data:{fid:g.filter_id,v:g.version,t:[feed==='migrated'?{c:'sol',a:row.address,f:{mc:12345}}:{c:'sol',a:row.address,mc:12345}],...extra}};}

test('four declared cohorts preserve exact identities, native units, receipt versus source time',()=>{const{b}=setup();const v=b.view();assert(v.research_ready);assert.equal(v.execution_ready,false);assert.equal(v.groups.length,4);for(const g of v.groups){assert.equal(g.rows.length,2);assert.equal(g.upstream_updated_at,null);assert(g.rows.every(r=>r.chain===g.chain));assert.equal(g.rows[0].native_fees.unit,g.chain==='solana'?'SOL':'ETH');}});
test('explicit Trending request rejects hidden criteria, wrong period, fee or age',()=>{for(const change of [r=>r.params[0].filter.filters=['frozen'],r=>r.params[0].interval='1h',r=>r.params[1].filter.min_gas_fee=0,r=>r.params[0].filter.max_created='500m']){const r=clone(SCOPE.trending);change(r);const b=new FeedBook({now:()=>START});assert(!b.snapshot('trending',fixture.trending,r).accepted);}});
test('both feeds are discovery scopes and Trending age remains distinct from its ranking window',()=>{
  const {b}=setup();for(const g of b.view().groups){assert.equal(g.purpose,'DISCOVERY_AND_RESEARCH');
    if(g.feed==='trending'){assert.equal(g.ranking_window,'24h');assert.equal(g.age_filter.max_age_days,720/24);assert.equal(g.age_filter.max_created,'43200m');}
    else{assert.equal(g.ranking_window,null);assert.equal(g.age_filter,null);}}
});
test('nonempty metadata is not fabricated; zero and missing numeric fields remain distinct',()=>{const raw=clone(fixture.migrated.data[0].completed.tokens[0]);delete raw.nm;delete raw.s;raw.mc=0;delete raw.lq;const r=normalizeToken(raw,'sol','migrated',new Date(START).toISOString(),{});assert.equal(r.name,null);assert.equal(r.symbol,null);assert.equal(r.metrics.market_cap_usd.value,0);assert.equal(r.metrics.liquidity_usd.value,null);assert(r.missing.includes('name'));for(const value of [true,'0',NaN,-1]){raw.mc=value;assert.throws(()=>normalizeToken(raw,'sol','migrated',new Date(START).toISOString(),{}));}});
test('partial updates preserve unchanged values; repeated cursor fragments apply in order',()=>{const{b}=setup(),d=delta(b);const g=b.groups.get('migrated:sol'),a=d.data.t[0].a,before=g.tokens.get(a).native_fees.value;assert(b.delta('migrated',d).accepted);d.data.t[0].f={hd:0};assert(b.delta('migrated',d).accepted);const row=b.groups.get('migrated:sol').tokens.get(a);assert.equal(row.metrics.market_cap_usd.value,12345);assert.equal(row.metrics.holders.value,0);assert.equal(row.native_fees.value,before);});
test('older cursor cannot overwrite new data; versions retain 64-bit precision',()=>{const{b}=setup(),d=delta(b);d.data.v='FFFFFFFFFFFFFFF0';assert(b.delta('migrated',d).accepted);d.data.v='FFFFFFFFFFFFFFEF';d.data.t[0].f.mc=1;assert.equal(b.delta('migrated',d).applied,0);assert.equal(b.groups.get('migrated:sol').tokens.get(d.data.t[0].a).metrics.market_cap_usd.value,12345);});

test('cached HTTP snapshots are rebuilt through captured updates instead of rolling back a newer stream cursor',()=>{
  for(const feed of ['migrated','trending']){
    const{b,tick}=setup(),d=delta(b,feed);d.data.v='FFFFFFFFFFFFFFF0';assert(b.delta(feed,d).accepted);tick(1000);
    const old=clone(fixture[feed]),result=b.snapshot(feed,old,SCOPE[feed]);
    assert(result.accepted);assert(result.cached_snapshot_reconciled);assert(result.replayed>0);
    const g=b.groups.get(feed+':sol'),row=g.tokens.get(d.data.t[0].a);
    assert.equal(g.version,'FFFFFFFFFFFFFFF0');assert.equal(row.metrics.market_cap_usd.value,12345);
    const proof=row.field_provenance.observations[row.field_provenance.fields.mc];
    assert.equal(Date.parse(proof.received_at),START);assert.equal(proof.sha256,hash(d));
    assert.equal(Date.parse(g.snapshot_at),START+1000);assert(b.view().research_ready);
  }
});

test('reconstruction retains full additions, removals and zero across repeated cached snapshots',()=>{
  const{b,tick}=setup(),g=b.groups.get('migrated:sol'),old=[...g.tokens.values()][0],other=[...b.groups.get('trending:sol').tokens.values()][0];
  const raw={...other.raw,n:'sol'};delete raw.c;
  const d=delta(b,'migrated',{v:'FFFFFFFFFFFFFFF0',a:[other.address],r:[old.address],t:[{c:'sol',a:other.address,f:raw}]});
  assert(b.delta('migrated',d).accepted);d.data={...d.data,v:'FFFFFFFFFFFFFFF1',a:[],r:[],t:[{c:'sol',a:other.address,f:{hd:0}}]};assert(b.delta('migrated',d).accepted);
  for(let i=0;i<2;i++){tick(1000);assert(b.snapshot('migrated',fixture.migrated,SCOPE.migrated).accepted);const now=b.groups.get('migrated:sol');assert(!now.tokens.has(old.address));assert.equal(now.tokens.get(other.address).metrics.holders.value,0);assert.equal(now.version,'FFFFFFFFFFFFFFF1');}
});

test('unbridged cursor, interrupted stream or bounded replay overflow cannot claim successful reconstruction',()=>{
  for(const mode of ['too-old','disconnect','frame-bound','byte-bound']){
    let clock=START;const opts=mode==='frame-bound'?{maxReplayFrames:1}:mode==='byte-bound'?{maxReplayBytes:1}:{};
    const b=new FeedBook({now:()=>clock,...opts});assert(b.snapshot('migrated',fixture.migrated,SCOPE.migrated).accepted);b.connection('migrated',true);
    const d=delta(b);d.data.v='FFFFFFFFFFFFFFF0';assert(b.delta('migrated',d).accepted);
    if(mode==='frame-bound'){d.data.v='FFFFFFFFFFFFFFF1';assert(b.delta('migrated',d).accepted);}
    if(mode==='disconnect')b.connection('migrated',false);
    const incoming=clone(fixture.migrated);if(mode==='too-old')incoming.data[0].completed.version='0';
    const unchanged=()=>hash([...b.groups].map(([key,g])=>[key,[...g.tokens.values()]]));
    const before=unchanged();clock+=1000;
    assert.equal(b.snapshot('migrated',incoming,SCOPE.migrated).reason,'SNAPSHOT_VERSION_REGRESSION_UNBRIDGED');
    assert.equal(unchanged(),before);
    const row=b.groups.get('migrated:sol').tokens.get(d.data.t[0].a);assert.equal(row.metrics.market_cap_usd.value,12345);assert(b.faults.migrated);
  }
});

test('partial changes preserve the collection proof of unchanged fields, including explicit zero and null',()=>{
  for(const feed of ['migrated','trending']){
    const{b,tick}=setup(),d=delta(b,feed),key=feed+':sol',a=d.data.t[0].a;
    const before=b.groups.get(key).tokens.get(a),proof=(r,k)=>r.field_provenance.observations[r.field_provenance.fields[k]];
    const originalHolders=clone(proof(before,'hd'));tick(1000);assert(b.delta(feed,d).accepted);
    let row=b.groups.get(key).tokens.get(a);assert.equal(row.observation_kind,'PARTIAL_PATCH');
    assert.deepEqual(proof(row,'hd'),originalHolders);assert.equal(Date.parse(proof(row,'mc').received_at),START+1000);
    tick(1000);if(feed==='migrated')d.data.t[0].f={hd:0,m_x:null};else d.data.t[0]={a,c:'sol',hd:0,m_x:null};
    assert(b.delta(feed,d).accepted);row=b.groups.get(key).tokens.get(a);
    assert.equal(row.metrics.holders.value,0);assert.deepEqual(row.source_links,[]);
    assert.equal(Date.parse(proof(row,'mc').received_at),START+1000);
    assert.equal(Date.parse(proof(row,'hd').received_at),START+2000);
    assert.equal(Date.parse(proof(row,'m_x').received_at),START+2000);
    assert(row.field_provenance.observations.length<=3);
  }
});

test('fractional or unsafe counts fail, while missing counts and genuine zero remain distinct',()=>{
  const raw=clone(fixture.trending.data[0].tokens[0]);
  for(const hd of [.5,Number.MAX_SAFE_INTEGER+1]){raw.hd=hd;assert.throws(()=>normalizeToken(raw,'sol','trending',new Date(START).toISOString(),{}),/INVALID:holders/);}
  raw.hd=0;assert.equal(normalizeToken(raw,'sol','trending',new Date(START).toISOString(),{}).metrics.holders.value,0);
  delete raw.hd;assert.equal(normalizeToken(raw,'sol','trending',new Date(START).toISOString(),{}).metrics.holders.state,'MISSING');
});
test('new full token additions and explicit removals do not rely on ticker or list absence',()=>{const{b}=setup(),g=b.groups.get('migrated:sol'),old=[...g.tokens.values()][0],other=[...b.groups.get('trending:sol').tokens.values()][0];const raw={...other.raw,n:'sol'};delete raw.c;const d=delta(b,'migrated',{a:[other.address],r:[old.address],t:[{c:'sol',a:other.address,f:Object.fromEntries(Object.entries(raw).filter(([k])=>!['a','n','c'].includes(k)))}]});assert(b.delta('migrated',d).accepted);const after=b.groups.get('migrated:sol');assert(!after.tokens.has(old.address));assert(after.tokens.has(other.address));});
test('unknown partial addition requires a fresh baseline, never a fabricated full token',()=>{const{b}=setup(),d=delta(b);d.data.t[0].a=fixture.trending.data[0].tokens[0].a;const before=hash(b.view().groups);assert(!b.delta('migrated',d).accepted);assert.equal(hash(b.view().groups),before);assert(!b.view().research_ready);});
test('malformed later frame message rolls back all earlier patches in that frame',()=>{const{b}=setup(),d=delta(b),bad=clone(d.data);bad.t[0].c='robinhood';d.data=[d.data,bad];const before=hash(b.view().groups);assert(!b.delta('migrated',d).accepted);assert.equal(hash(b.view().groups),before);});
test('multiple same-cohort messages in one frame are folded without dropping earlier fields',()=>{const{b}=setup(),d=delta(b),next=clone(d.data);next.t[0].f={hd:777};d.data=[d.data,next];assert(b.delta('migrated',d).accepted);const row=b.groups.get('migrated:sol').tokens.get(next.t[0].a);assert.equal(row.metrics.market_cap_usd.value,12345);assert.equal(row.metrics.holders.value,777);});
test('wrong lane/fid cannot contaminate the cohort; unknown operations and identity mutations fail',()=>{const{b}=setup(),d=delta(b);d.data.fid='sol_nc_other';assert.equal(b.delta('migrated',d).ignored,1);const wrong=delta(b);wrong.data.z=[];assert(!b.delta('migrated',wrong).accepted);const mutation=delta(b);mutation.data.t[0].f.a='different';assert(!b.delta('migrated',mutation).accepted);});
test('disconnect, stale source, future receipt, missing chain and version_too_old block readiness',()=>{let{b,tick}=setup();tick(61000);assert(!b.view().research_ready);({b}=setup());b.connection('trending',false);assert(!b.view().research_ready);({b}=setup());assert(!b.snapshot('trending',fixture.trending,SCOPE.trending,new Date(START+5000).toISOString()).accepted);({b}=setup());const body=clone(fixture.trending);body.data.pop();assert(!b.snapshot('trending',body,SCOPE.trending).accepted);({b}=setup());assert(!b.delta('trending',{type:'error',code:'version_too_old'}).accepted);assert(!b.view().research_ready);});
test('old snapshot or duplicate/mismatched identity never replaces a sound cohort',()=>{const{b}=setup(),before=hash(b.view().groups),body=clone(fixture.migrated);body.data[0].completed.tokens.push(body.data[0].completed.tokens[0]);assert(!b.snapshot('migrated',body,SCOPE.migrated).accepted);assert.equal(hash(b.view().groups),before);assert(!b.snapshot('migrated',fixture.migrated,SCOPE.migrated,new Date(START-1000).toISOString()).accepted);});

test('observed calibration frames accept matching repeated identities and reject mutation atomically',()=>{
  const{b}=setup(),d=delta(b),a=d.data.t[0].a;
  d.data.src='calibration';d.data.t[0].f={a,n:'sol',mc:800};
  assert(b.delta('migrated',d).accepted);assert.equal(b.groups.get('migrated:sol').tokens.get(a).metrics.market_cap_usd.value,800);
  const before=hash(b.view().groups);d.data.t[0].f.n='robinhood';
  assert(!b.delta('migrated',d).accepted);assert.equal(hash(b.view().groups),before);
});
test('Trending membership uses exact chain-qualified IDs; a foreign chain never removes a same-address token',()=>{
  const{b}=setup(),d=delta(b,'trending'),a=d.data.t[0].a;
  d.data.r=['sol:'+a];d.data.t=[];assert(b.delta('trending',d).accepted);assert(!b.groups.get('trending:sol').tokens.has(a));
  const other=setup().b,bad=delta(other,'trending');bad.data.r=['robinhood:'+bad.data.t[0].a];bad.data.t=[];
  const before=hash(other.view().groups);assert(!other.delta('trending',bad).accepted);assert.equal(hash(other.view().groups),before);
});
test('owner acceptance admits research scope without pretending exact UI equality or executable prices',()=>{
  const{b}=setup(),view=b.view();assert(view.research_ready);assert.equal(view.ui_equivalence,'OWNER_ACCEPTED_BOUNDED_DIFFERENCE');assert.equal(view.strategy_ready,true);
  assert.equal(view.ui_exact_match_verified,false);assert.equal(view.execution_ready,false);
});

test('a disconnected replay queue cannot overwrite a replacement baseline on later refresh',()=>{
  for(const feed of ['migrated','trending']){
    const{b}=setup(),d=delta(b,feed),a=d.data.t[0].a;
    assert(b.delta(feed,d).accepted);b.connection(feed,false);
    const fresh=clone(fixture[feed]),group=fresh.data.find(g=>g.chain==='sol');
    (feed==='migrated'?group.completed:group).tokens.find(r=>r.a===a).mc=54321;
    assert(b.snapshot(feed,fresh,SCOPE[feed]).accepted);b.connection(feed,true);
    assert.equal(b.snapshot(feed,fresh,SCOPE[feed]).replayed,0);
    assert.equal(b.groups.get(feed+':sol').tokens.get(a).metrics.market_cap_usd.value,54321);
  }
});

test('a rejected source frame invalidates replay until a baseline reaches its observed cursor',()=>{
  for(const feed of ['migrated','trending']){
    const{b}=setup(),d=delta(b,feed),a=d.data.t[0].a;
    assert(b.delta(feed,d).accepted);
    const bad=delta(b,feed,{v:'FFFFFFFFFFFFFFF0',unexpected:[]});
    assert(!b.delta(feed,bad).accepted);
    assert.equal(b.snapshot(feed,fixture[feed],SCOPE[feed]).reason,'SNAPSHOT_BEFORE_FAILED_DELTA');
    assert(!b.view().research_ready);
    const fresh=clone(fixture[feed]);
    for(const g of fresh.data){const value=feed==='migrated'?g.completed:g;value.version=bad.data.v;}
    const group=fresh.data.find(g=>g.chain==='sol');
    (feed==='migrated'?group.completed:group).tokens.find(r=>r.a===a).mc=54321;
    assert(b.snapshot(feed,fresh,SCOPE[feed]).accepted);
    assert.equal(b.snapshot(feed,fresh,SCOPE[feed]).replayed,0);
    assert.equal(b.groups.get(feed+':sol').tokens.get(a).metrics.market_cap_usd.value,54321);
  }
});
test('fee provenance preserves the provider field and leaves aggregation methodology unverified',()=>{
  const{b}=setup();for(const g of b.view().groups)for(const r of g.rows){assert.equal(r.native_fees.source_field,g.feed==='migrated'?'f_tt':'gf');assert.equal(r.native_fees.provider_label,'Total Fees');assert.equal(r.native_fees.coverage,'PROVIDER_AGGREGATE_METHOD_UNVERIFIED');assert.match(r.native_fees.note,/not trading volume or invested capital/);}
});
