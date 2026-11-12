'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {FeedBook,SCOPE}=require('../market/network-feed');
const fixture=require('../market/fixtures/gmgn-network-2026-10-27.json');
const {packetFor,validateReview,researchSource,readState,commitReview,runResearch,sourceCatalogue}=require('./research-host');
const {quotaFromResult,runCodex}=require('./codex-runner');
const clone=x=>JSON.parse(JSON.stringify(x));
function directory(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'alphahands-v2-unit-'));t.after(()=>{for(const f of fs.readdirSync(d)){assert(['research.jsonl','STRATEGY.md'].includes(f));fs.unlinkSync(path.join(d,f));}fs.rmdirSync(d);});return d;}
function response(){return{notes:'Evidence reviewed, remaining unknowns explicit.',reviewed_coin_ids:[],cited_source_ids:[],strategy:null,watches:[],research_requests:[],next_review_at:null};}
function packet(d){return{controls:{strategy_version:0,required_initial_coin_ids:['coin-a','coin-b']},state:readState(d),market:{recorded_at:'2026-10-27T13:00:00Z'},sources:[{id:'source-1',qualified:true},{id:'bad-source',qualified:false}]};}
const watchedCoin='robinhood:0x1111111111111111111111111111111111111111';
function watch(coin_id=watchedCoin){return{coin_id,thesis:'Source-linked thesis remains under review.',condition:'Request fresh evidence before any judgement.',review_at:'2026-11-08T13:00:00Z'};}
function seedWatch(d){const p=packet(d),r=response();p.controls.required_initial_coin_ids.push(watchedCoin);r.watches=[watch()];commitReview(d,'seed-watch',0,p,r);return readState(d);}
test('owner-accepted feed scope admits packets, while unavailable transport blocks before model invocation',async t=>{
  const d=directory(t),book=new FeedBook({now:()=>Date.parse('2026-10-27T12:40:00Z')});
  for(const feed of ['migrated','trending']){assert(book.snapshot(feed,fixture[feed],SCOPE[feed]).accepted);book.connection(feed,true);}
  assert(book.view().research_ready);assert.equal(packetFor(book,readState(d)).market.ui_equivalence,'OWNER_ACCEPTED_BOUNDED_DIFFERENCE');
  const guidance=packetFor(book,readState(d)).controls.leader_research;
  assert.match(guidance.priority,/before settling or materially revising/);
  assert.match(guidance.selection,/both enabled chains/);
  assert.match(guidance.selection,/Feed screening alone/);
  assert.match(guidance.investigation,/original story and primary project\/X sources/);
  assert.match(guidance.investigation,/competing mints/);
  assert.match(guidance.strategy,/provisional/);
  assert.match(guidance.strategy,/paper-execution gates/);
  book.connection('trending',false);
  let calls=0;await assert.rejects(runResearch({book,stateDir:d,execute:async()=>{calls++;throw Error('MODEL_MUST_NOT_RUN');}}),/MARKET_NOT_READY/);assert.equal(calls,0);
});

test('known feed references retain qualification states while unknown citations and unsupported strategy changes fail',t=>{
  const d=directory(t),clock=Date.now(),book=new FeedBook({now:()=>clock});
  for(const feed of ['migrated','trending']){assert(book.snapshot(feed,fixture[feed],SCOPE[feed]).accepted);book.connection(feed,true);}
  const p=packetFor(book,readState(d)),catalogue=sourceCatalogue(p,clock),feedSource=catalogue.find(s=>s.kind==='DISCOVERY_FEED_RECORD');
  assert(feedSource?.qualified);assert.equal(catalogue.filter(s=>s.kind==='X_SOURCE').length,0);
  const r=response();r.cited_source_ids=[feedSource.id];assert.equal(validateReview(r,p,{now:clock}),r);
  assert.equal(validateReview(r,p,{now:clock+300001}),r);
  assert.equal(sourceCatalogue(p,clock+300001).find(s=>s.id===feedSource.id).qualified,false);
  assert.throws(()=>validateReview({...r,cited_source_ids:['f'.repeat(64)]},p,{now:clock}),/UNVERIFIED_SOURCE_CITATION/);
  const unavailable={...p,market:{...p.market,research_ready:false}};
  assert.equal(validateReview(r,unavailable,{now:clock}),r);
  assert.throws(()=>validateReview({...r,strategy:{operation:'NOTE',markdown:'Unsupported claim'}},unavailable,{now:clock}),/UNVERIFIED_SOURCE_CITATION/);
});

test('discovery failure permits held-position review but cannot form a new market strategy or add exposure',t=>{
  const d=directory(t),book=new FeedBook();
  for(const feed of ['migrated','trending']){assert(book.snapshot(feed,fixture[feed],SCOPE[feed]).accepted);book.connection(feed,true);}
  book.connection('trending',false);
  const accountState={revision:8,positions:[{coin_id:watchedCoin}]};
  const p=packetFor(book,readState(d),[],[],{accountState});
  assert.equal(p.controls.position_review_only,true);assert.equal(p.market.research_ready,false);
  assert.match(p.controls.leader_research.priority,/Urgent held-position review takes priority/);
  assert.match(p.controls.leader_research.priority,/do not infer current market leaders/);
  assert.equal(p.market.groups.length,0);assert.deepEqual(p.controls.required_initial_coin_ids,[]);
  assert(p.controls.allowed_research_coin_ids.includes(watchedCoin));
  const r=response();r.paper_action={action:'EXIT',coin_id:watchedCoin,expected_account_revision:8,percent:100,entry_low_mc:null,entry_high_mc:null,reason:'Fixture reduction'};
  validateReview(r,p);
  assert.throws(()=>validateReview({...r,paper_action:{...r.paper_action,action:'ADD',percent:20,entry_low_mc:1,entry_high_mc:2}},p),/ENTRY_NOT_QUALIFIED/);
  assert.throws(()=>validateReview({...r,paper_action:null,strategy:{operation:'REVISE',markdown:'Unsupported market rewrite'}},p),/MARKET_COVERAGE_UNAVAILABLE/);
});

test('research packet preserves every normalized field and its original partial-update proof without sharing mutable references',t=>{
  const d=directory(t);let clock=Date.parse('2026-10-27T12:40:00Z');
  // Fixture-only admission to exercise serialization. Real FeedBook remains
  // blocked by the separate UI-equivalence regression above.
  class PacketFixture extends FeedBook{view(){return{...super.view(),strategy_ready:true};}}
  const book=new PacketFixture({now:()=>clock});
  for(const feed of ['migrated','trending']){assert(book.snapshot(feed,fixture[feed],SCOPE[feed]).accepted);book.connection(feed,true);}
  const g=book.groups.get('migrated:sol'),row=[...g.tokens.values()][0];clock+=1000;
  assert(book.delta('migrated',{channel:'trenches_delta',data:{fid:g.filter_id,v:g.version,t:[{c:'sol',a:row.address,f:{hd:0}}]}}).accepted);
  const original=book.view(),expected=clone(original);for(const group of expected.groups)for(const token of group.rows)delete token.raw;
  const p=packetFor(book,readState(d));assert.deepEqual(p.market,expected);
  const target=p.market.groups.find(group=>group.feed==='migrated'&&group.chain==='solana').rows.find(r=>r.coin_id===row.coin_id);
  const proof=key=>target.field_provenance.observations[target.field_provenance.fields[key]];
  assert.equal(proof('hd').received_at,new Date(clock).toISOString());assert.notEqual(proof('mc').received_at,proof('hd').received_at);
  assert.equal(target.metrics.holders.value,0);assert.equal(target.indicative_price.execution_qualified,false);
  target.field_provenance.observations[0].received_at='tampered';target.metrics.holders.value=999;
  assert.deepEqual(book.view(),original);assert.equal(book.view().ui_equivalence,'OWNER_ACCEPTED_BOUNDED_DIFFERENCE');
});
test('initial strategy requires complete accounting and qualified citations, not a winner-only sample',t=>{
  const d=directory(t),p=packet(d),r=response();r.strategy={operation:'REVISE',markdown:'Supported strategy'};r.reviewed_coin_ids=['coin-a'];r.cited_source_ids=['source-1'];
  assert.throws(()=>validateReview(r,p),/NOT_FULLY_REVIEWED/);r.reviewed_coin_ids.push('coin-b');r.cited_source_ids=['bad-source'];assert.throws(()=>validateReview(r,p),/UNVERIFIED_SOURCE/);
  r.cited_source_ids=['source-1'];assert.equal(validateReview(r,p),r);r.trade={buy:true};assert.throws(()=>validateReview(r,p),/SHAPE/);
});
test('earlier-round coverage survives commit/restart; identical retries deduplicate and changed retries fail',t=>{
  const d=directory(t),p=packet(d),r=response();p.state.reviewed_coin_ids=['coin-a'];r.reviewed_coin_ids=['coin-b'];r.cited_source_ids=['source-1'];r.strategy={operation:'REVISE',markdown:'Source-supported flexible strategy'};
  assert.equal(commitReview(d,'run-1',0,p,r).status,'COMMITTED');const saved=readState(d);assert.deepEqual(saved.reviewed_coin_ids,['coin-a','coin-b']);assert.equal(saved.strategy_status,'RESEARCHED');
  fs.unlinkSync(path.join(d,'STRATEGY.md'));assert.equal(commitReview(d,'run-1',0,p,r).status,'ALREADY_COMMITTED');assert.equal(fs.readFileSync(path.join(d,'STRATEGY.md'),'utf8'),saved.strategy);const altered=clone(r);altered.notes='Different judgement';assert.throws(()=>commitReview(d,'run-1',0,p,altered),/RUN_ID_CONFLICT/);
  assert.throws(()=>commitReview(d,'run-2',0,p,r),/VERSION_CHANGED/);assert.equal(readState(d).version,1);
});
test('persisted off-feed watch can request research, record a review and survive commit/reload',t=>{
  const d=directory(t),state=seedWatch(d),book=new FeedBook();
  for(const feed of ['migrated','trending']){assert(book.snapshot(feed,fixture[feed],SCOPE[feed]).accepted);book.connection(feed,true);}
  const p=packetFor(book,state),request=response();assert(!p.controls.required_initial_coin_ids.includes(watchedCoin));assert(p.controls.allowed_research_coin_ids.includes(watchedCoin));
  request.research_requests=[{kind:'gmgn_token',input:watchedCoin,reason:'Recheck the persisted watch'}];assert.equal(validateReview(request,p),request);
  const r=response();r.reviewed_coin_ids=[watchedCoin];r.watches=[{...watch(),condition:'Keep watching with refreshed judgement.'}];
  assert.equal(commitReview(d,'watch-review',1,p,r).status,'COMMITTED');const saved=readState(d);
  assert.deepEqual(saved.watches,r.watches);assert.deepEqual(saved.reviewed_coin_ids,[watchedCoin]);assert.equal(saved.version,2);
  assert.equal(commitReview(d,'watch-review',1,p,r).status,'ALREADY_COMMITTED');assert.deepEqual(readState(d),saved);
});
test('unknown identities, forged allowed IDs and duplicate watches fail without changing saved state',t=>{
  const d=directory(t),state=seedWatch(d),p=packet(d);p.state=clone(state);p.controls.strategy_version=state.version;
  const journal=path.join(d,'research.jsonl'),before=fs.readFileSync(journal,'utf8'),strategy=fs.readFileSync(path.join(d,'STRATEGY.md'),'utf8');
  const unknown='solana:11111111111111111111111111111111',wrongChain=watchedCoin.replace('robinhood:','solana:');p.controls.allowed_research_coin_ids=[unknown,wrongChain];
  for(const id of [unknown,wrongChain]){
    const reviewed=response();reviewed.reviewed_coin_ids=[id];assert.throws(()=>commitReview(d,'unknown-review',1,p,reviewed),/UNKNOWN_REVIEWED_COIN/);
    const retained=response();retained.watches=[watch(id)];assert.throws(()=>commitReview(d,'unknown-watch',1,p,retained),/WATCH_INVALID/);
  }
  const requested=response();requested.research_requests=[{kind:'gmgn_token',input:unknown,reason:'Forged allowed ID'}];assert.throws(()=>validateReview(requested,p),/UNKNOWN_RESEARCH_COIN/);
  const duplicate=response();duplicate.watches=[watch(),watch()];assert.throws(()=>commitReview(d,'duplicate-watch',1,p,duplicate),/WATCH_INVALID/);
  // Caller packet state is not authority for adding a previously unknown watch.
  p.state.watches.push(watch(unknown));const forged=response();forged.watches=[watch(unknown)];assert.throws(()=>commitReview(d,'forged-state',1,p,forged),/WATCH_INVALID/);
  assert.equal(fs.readFileSync(journal,'utf8'),before);assert.equal(fs.readFileSync(path.join(d,'STRATEGY.md'),'utf8'),strategy);assert.deepEqual(readState(d),state);
});
test('off-feed review IDs from prior or returned progress cannot substitute for missing initial feed coverage',t=>{
  const d=directory(t),state=seedWatch(d),p=packet(d);p.state=clone(state);p.controls.strategy_version=state.version;
  const r=response();r.strategy={operation:'REVISE',markdown:'Initial source-supported strategy'};r.cited_source_ids=['source-1'];
  for(const [prior,current] of [[[watchedCoin],['coin-a']],[['coin-a'],[watchedCoin]],[[watchedCoin],['coin-a',watchedCoin]]]){
    p.state.reviewed_coin_ids=prior;r.reviewed_coin_ids=current;assert.throws(()=>validateReview(r,p),/NOT_FULLY_REVIEWED/);
  }
  p.state.reviewed_coin_ids=['coin-a',watchedCoin];r.reviewed_coin_ids=['coin-b',watchedCoin];assert.equal(commitReview(d,'complete-feed',1,p,r).status,'COMMITTED');
  assert.equal(readState(d).strategy_status,'RESEARCHED');
});
test('failed journal write cannot advance an off-feed watch or its reviewed state',t=>{
  const d=directory(t),state=seedWatch(d),p=packet(d);p.state=clone(state);p.controls.strategy_version=state.version;
  const r=response();r.reviewed_coin_ids=[watchedCoin];r.watches=[{...watch(),condition:'Updated after fresh review'}];
  const journal=path.join(d,'research.jsonl'),before=fs.readFileSync(journal,'utf8'),strategy=fs.readFileSync(path.join(d,'STRATEGY.md'),'utf8'),write=fs.writeSync;
  try{fs.writeSync=()=>{throw Error('SYNTHETIC_JOURNAL_WRITE_FAILURE');};assert.throws(()=>commitReview(d,'failed-watch',1,p,r),/SYNTHETIC_JOURNAL_WRITE_FAILURE/);}
  finally{fs.writeSync=write;}
  assert.equal(fs.readFileSync(journal,'utf8'),before);assert.equal(fs.readFileSync(path.join(d,'STRATEGY.md'),'utf8'),strategy);assert.deepEqual(readState(d),state);assert(!fs.existsSync(path.join(d,'research.lock')));
});
test('short journal writes advance by UTF-8 bytes and reload as a complete commit',t=>{
  const d=directory(t),p=packet(d),r=response();r.notes='Research 🌿 café remains explicit.';
  const write=fs.writeSync;let calls=0,split=0;
  try{fs.writeSync=(fd,bytes,offset,length,position)=>{
    assert(Buffer.isBuffer(bytes));calls++;
    if(calls===1){split=bytes.indexOf(Buffer.from('🌿'))+1;assert(split>1);return write(fd,bytes,offset,split,position);}
    assert.equal(offset,split);return write(fd,bytes,offset,length,position);
  };assert.equal(commitReview(d,'short-write',0,p,r).status,'COMMITTED');}
  finally{fs.writeSync=write;}
  assert.equal(calls,2);assert.equal(readState(d).notes,r.notes);assert.equal(readState(d).version,1);
});
test('zero or invalid journal write progress fails before strategy projection or acceptance',t=>{
  const d=directory(t),state=seedWatch(d),p=packet(d);p.state=clone(state);p.controls.strategy_version=state.version;
  const r=response();r.strategy={operation:'NOTE',markdown:'This must never reach the strategy projection.'};r.cited_source_ids=['source-1'];
  const journal=path.join(d,'research.jsonl'),before=fs.readFileSync(journal,'utf8'),strategy=fs.readFileSync(path.join(d,'STRATEGY.md'),'utf8'),write=fs.writeSync;
  try{for(const count of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER]){
    fs.writeSync=()=>count;assert.throws(()=>commitReview(d,'invalid-write',1,p,r),/RESEARCH_JOURNAL_WRITE_INCOMPLETE/);
  }}finally{fs.writeSync=write;}
  assert.equal(fs.readFileSync(journal,'utf8'),before);assert.equal(fs.readFileSync(path.join(d,'STRATEGY.md'),'utf8'),strategy);assert.deepEqual(readState(d),state);assert(!fs.existsSync(path.join(d,'research.lock')));
});
test('tampered or interrupted research journal never becomes accepted state',t=>{
  const d=directory(t),p=packet(d),r=response();commitReview(d,'run-1',0,p,r);const f=path.join(d,'research.jsonl'),original=fs.readFileSync(f,'utf8');
  fs.writeFileSync(f,original.trimEnd());assert.throws(()=>readState(d),/INCOMPLETE/);fs.writeFileSync(f,original.replace('Evidence reviewed','Changed evidence'));assert.throws(()=>readState(d),/INTEGRITY/);
});
test('source completion time follows collection; repeated posts and missing engagement remain intact',async()=>{
  let clock=Date.parse('2026-10-27T13:00:00Z');const post={id:'123',text:'Actual source text',author:{handle:'Example'},date:'2026-10-27T12:00:00Z',likes:null};
  const source=await researchSource({kind:'x_link',input:'https://x.com/Example',reason:'Narrative check'},{now:()=>clock,client:{async xUserTweets(){clock+=5000;return{ok:true,tweets:[post,clone(post)]};}}});
  assert(source.qualified);assert.equal(source.qualified_count,2);assert.equal(source.raw.tweets.length,2);assert.equal(source.raw.tweets[0].likes,null);assert.equal(Date.parse(source.collected_at)-Date.parse(source.capture_started_at),5000);
});
test('wrong author/post, empty text, future posts and unavailable browser are explicitly unverified',async()=>{
  const request={kind:'x_link',input:'https://x.com/example/status/123',reason:'Exact source check'},now=()=>Date.parse('2026-10-27T13:00:00Z');
  for(const patch of [{id:'999'},{author:{handle:'other'}},{text:''},{date:'2026-10-28T13:00:00Z'}]){
    const tweet={id:'123',author:{handle:'example'},text:'Text',date:'2026-10-27T12:00:00Z',...patch};const s=await researchSource(request,{now,client:{xTweet:async()=>({ok:true,tweet})}});assert.equal(s.qualified,false);assert.equal(s.unverified_count,1);assert.equal(s.post_checks.length,1);assert.equal(s.post_checks[0].qualified,false);assert(s.post_checks[0].reasons.length>0);
  }
  const browser=await researchSource({kind:'browser',input:'https://x.com/example',reason:'Check'},{now});assert.equal(browser.qualified,false);assert.equal(browser.reason,'BROWSER_TOOL_NOT_CONNECTED');
});
test('quota uses the five-hour window and reserve, never weekly availability or reset credits',async()=>{
  const result={ordinaryUsageAllowed:true,rateLimits:{primary:{windowDurationMins:10080,usedPercent:5},secondary:{windowDurationMins:300,usedPercent:64}}};
  assert(quotaFromResult(result).inference_allowed);result.rateLimits.secondary.usedPercent=65;assert(!quotaFromResult(result).inference_allowed);
  for(const usedPercent of [-1,101,NaN]){result.rateLimits.secondary.usedPercent=usedPercent;assert.throws(()=>quotaFromResult(result),/USAGE_UNAVAILABLE/);}
  result.rateLimits.secondary.usedPercent=10;result.ordinaryUsageAllowed=false;assert(!quotaFromResult(result).inference_allowed);
  await assert.rejects(runCodex({usageProvider:async()=>({inference_allowed:false})}),/RESERVE_REACHED/);
});

test('owner fifteen-percent reserve retains a five-percent start buffer and expires with its exact window',()=>{
  const resetsAt=Math.floor(Date.now()/1000)+3600;
  const result={ordinaryUsageAllowed:true,rateLimits:{primary:{windowDurationMins:300,usedPercent:79,resetsAt}}};
  const authorization={schema:'alphahands.usage-authorization.v1',owner_approved:true,window_resets_at:resetsAt,start_before_percent:80};
  const allowed=quotaFromResult(result,{authorization});
  assert.equal(allowed.inference_allowed,true);assert.equal(allowed.reserve_percent,15);assert.equal(allowed.start_buffer_percent,5);
  result.rateLimits.primary.usedPercent=80;assert.equal(quotaFromResult(result,{authorization}).inference_allowed,false);
  authorization.window_resets_at++;const expired=quotaFromResult(result,{authorization});
  assert.equal(expired.owner_window_waiver,false);assert.equal(expired.reserve_percent,30);assert.equal(expired.inference_allowed,false);
});
