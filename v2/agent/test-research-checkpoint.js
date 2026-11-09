'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),zlib=require('node:zlib');
const {FeedBook,SCOPE,hash}=require('../market/network-feed');
const fixture=require('../market/fixtures/gmgn-network-2026-10-27.json');
const {runResearch,readState,commitReview,packetFor}=require('./research-host');
const checkpoint=require('./research-checkpoint');
const {buildXSource}=require('./x-evidence');
const {coinIdentity,collectTokenFromPage,validatePng}=require('./token-evidence');
const clone=x=>JSON.parse(JSON.stringify(x)),NOW=Date.parse('2026-11-07T13:00:00Z');
function directory(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'alphahands-checkpoint-'));t.after(()=>{
  assert.equal(path.dirname(fs.realpathSync(d)),fs.realpathSync(os.tmpdir()));
  for(const f of fs.readdirSync(d)){const target=path.join(d,f);if(f==='research-cache'){assert(fs.lstatSync(target).isDirectory());for(const p of fs.readdirSync(target)){assert(/^[a-f0-9]{64}\.png$/.test(p));fs.unlinkSync(path.join(target,p));}fs.rmdirSync(target);}else{assert(/^(turns\.jsonl|research\.jsonl|research\.lock|STRATEGY\.md|research-pending\.json)$/.test(f));fs.unlinkSync(target);}}fs.rmdirSync(d);
});return d;}
function book(now=NOW){const b=new FeedBook({now:()=>now});for(const f of ['migrated','trending']){assert(b.snapshot(f,fixture[f],SCOPE[f]).accepted);b.connection(f,true);}return b;}
function response(){return{notes:'Original 🌿 notes: evidence still uncertain.',reviewed_coin_ids:[],cited_source_ids:[],strategy:null,watches:[],research_requests:[],next_review_at:null};}
function pendingResponse(){return{...response(),research_requests:[{kind:'x_search',input:'Original question',reason:'Need another source'}]};}
async function pause(d,b,options={}){return runResearch({book:b,stateDir:d,maxRounds:1,execute:async()=>({text:JSON.stringify(pendingResponse())}),...options});}
function rewrite(d,mutate){const f=path.join(d,'research-pending.json'),v=JSON.parse(fs.readFileSync(f));mutate(v.body);v.sha256=hash(v.body);fs.writeFileSync(f,JSON.stringify(v));}
function png(){
  const crc=bytes=>{let c=-1;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^-1)>>>0;};
  const chunk=(name,data)=>{const type=Buffer.from(name),a=Buffer.alloc(4),b=Buffer.alloc(4);a.writeUInt32BE(data.length);b.writeUInt32BE(crc(Buffer.concat([type,data])));return Buffer.concat([a,type,data,b]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(100);header.writeUInt32BE(100,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(Buffer.alloc(30100))),chunk('IEND',Buffer.alloc(0))]);
}
function source(){return buildXSource({request:{kind:'x_link',input:'https://x.com/Example',reason:'Original linked source'},raw:{ok:true,tweets:[{id:'123',author:{handle:'Example'},text:'Exact original source 🌿',date:new Date(NOW-1000).toISOString(),likes:null}]},capture_started_at:new Date(NOW).toISOString(),collected_at:new Date(NOW).toISOString()});}
async function token(coin){const c=coinIdentity(coin),bytes=png(),image=validatePng(bytes.toString('base64'));
  return collectTokenFromPage({coinId:coin,page:{url:()=>c.url,evaluate:async()=>[c.address]},now:()=>NOW,
    readData:async()=>({address:c.address,symbol:'FIXTURE',market_cap_usd:100000,price_usd:0.01,liquidity_usd:0,volume_24h_usd:0,total_fees_native:0,total_fees_unit:c.chain==='solana'?'SOL':'ETH',holders_count:0,socials:{twitter:'https://x.com/Example'}}),
    readChart:async()=>({ok:true,coin_id:coin,source_url:c.url,captured_at:new Date(NOW).toISOString(),rendered_label:`Chart for ${c.chain==='solana'?'sol':c.chain}/${c.address}/USD`,content_type:'image/png',sha256:image.sha256,width:image.width,height:image.height,base64:bytes.toString('base64')})});
}
test('ordinary pause collects nothing; explicit resume preserves all evidence, images, notes and cumulative rounds with current prices',async t=>{
  const d=directory(t),b=book(),ids=[...new Set(b.view().groups.flatMap(g=>g.rows.map(r=>r.coin_id)))].slice(0,2),tokens=await Promise.all(ids.map(token)),s=source();let collects=0,models=0;
  const broker={capabilities:{},collect:async request=>{collects++;return{request,status:'OBSERVED',sources:[],token_evidence:[]};}};
  const paused=await pause(d,b,{broker,initialSources:[s],tokenEvidence:tokens});assert.equal(collects,0);assert.equal(readState(d).version,0);
  const text=fs.readFileSync(path.join(d,'research-pending.json'),'utf8');assert(!text.includes('base64'));assert(!fs.readFileSync(path.join(d,'turns.jsonl'),'utf8').includes('base64'));
  assert.deepEqual(checkpoint.load(d).tokens,tokens);assert.deepEqual(checkpoint.load(d).sources,[s]);
  await assert.rejects(runResearch({book:b,stateDir:d,execute:async()=>{models++;}}),/RESUME_REQUIRED/);assert.equal(models,0);
  const row=[...b.groups.values()][0].tokens.values().next().value;row.metrics.market_cap_usd.value+=123;
  const result=await runResearch({book:b,stateDir:d,resumeRunId:paused.run_id,broker,maxRounds:1,execute:async({packet,images})=>{
    models++;assert.equal(packet.controls.round,1);assert.equal(packet.research_progress[0].notes,response().notes);assert.equal(packet.research_progress[0].recorded_at,new Date(NOW).toISOString());
    assert.equal(packet.available_token_evidence.length,2);assert.equal(packet.token_research[0].evidence_id,tokens[1].id);assert.equal(images[0].base64,tokens[1].chart.base64);
    assert.equal(packet.sources[0].raw.tweets[0].text,s.raw.tweets[0].text);assert.equal(packet.request_results.length,1);assert.equal(checkpoint.load(d).phase,'ACTIVE');
    assert.equal(packet.market.groups[0].rows.find(r=>r.coin_id===row.coin_id).metrics.market_cap_usd.value,row.metrics.market_cap_usd.value);
    return{text:JSON.stringify(response())};
  }});assert.equal(result.status,'COMMITTED');assert.equal(collects,1);assert.equal(models,1);assert(!checkpoint.exists(d));assert.equal(readState(d).version,1);
});
test('policy, schema, state, cohort, staleness, corruption, missing PNG and existing lock block before any external work',async t=>{
  for(const kind of ['policy','schema','state','cohort','filter','stale-source','stale-token','tamper','missing-png','lock','shape']){
    await t.test(kind,async t=>{const d=directory(t),b=book(),coin=b.view().groups[0].rows[0].coin_id;
      const paused=await pause(d,b,{initialSources:[source()],tokenEvidence:await Promise.all([coin].map(token))});let current=b,calls=0;
      if(kind==='policy')rewrite(d,v=>v.policy_sha256='changed');if(kind==='schema')rewrite(d,v=>v.response_schema_sha256='changed');
      if(kind==='shape')rewrite(d,v=>v.extra='unrecognized');
      if(kind==='state'){const p=packetFor(b,readState(d));commitReview(d,'different-run',0,p,response());}
      if(kind==='cohort')[...b.groups.values()][0].tokens.delete([...b.groups.values()][0].tokens.keys().next().value);
      if(kind==='filter')[...b.groups.values()][0].request_sha256='changed';
      if(kind==='stale-source'||kind==='stale-token'){current=book(NOW+6*60*1000);if(kind==='stale-token')rewrite(d,v=>v.sources=[]);}
      if(kind==='tamper'){const f=path.join(d,'research-pending.json');fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace('Original question','Tampered question'));}
      if(kind==='missing-png')fs.unlinkSync(path.join(d,'research-cache',fs.readdirSync(path.join(d,'research-cache'))[0]));
      if(kind==='lock')fs.writeFileSync(path.join(d,'research.lock'),'');
      await assert.rejects(runResearch({book:current,stateDir:d,resumeRunId:paused.run_id,source:async()=>{calls++;},execute:async()=>{calls++;}}),kind==='lock'?/EEXIST/:/REVALIDATION_REQUIRED/);
      assert.equal(calls,0);assert(fs.existsSync(path.join(d,'research-pending.json')));
    });
  }
});
test('interrupted active continuation cannot replay requests; repeated ordinary pauses preserve cumulative round numbering',async t=>{
  const d=directory(t),b=book(),paused=await pause(d,b);let calls=0;
  const again=await runResearch({book:b,stateDir:d,resumeRunId:paused.run_id,maxRounds:1,source:async request=>buildXSource({request,raw:null,capture_started_at:new Date(NOW).toISOString(),collected_at:new Date(NOW).toISOString()}),execute:async({packet})=>{assert.equal(packet.controls.round,1);return{text:JSON.stringify(pendingResponse())};}});
  assert.equal(again.run_id,paused.run_id);assert.equal(checkpoint.load(d).next_round,2);
  await assert.rejects(runResearch({book:b,stateDir:d,resumeRunId:paused.run_id,source:async()=>{calls++;throw Error('INTERRUPTED_FIXTURE');},execute:async()=>{calls++;}}),/INTERRUPTED_FIXTURE/);assert.equal(calls,1);
  await assert.rejects(runResearch({book:b,stateDir:d,resumeRunId:paused.run_id,source:async()=>{calls++;},execute:async()=>{calls++;}}),/REVALIDATION_REQUIRED/);assert.equal(calls,1);
});
test('resume retains initial coverage gate and refuses cohort mutation during a model round',async t=>{
  const d=directory(t),b=book(),paused=await pause(d,b);const broker={capabilities:{},collect:async request=>({request,status:'OBSERVED',sources:[],token_evidence:[]})};
  await assert.rejects(runResearch({book:b,stateDir:d,resumeRunId:paused.run_id,broker,execute:async()=>{const r=response();r.strategy={operation:'REVISE',markdown:'Unsupported initial strategy'};r.cited_source_ids=[];return{text:JSON.stringify(r)};}}),/NOT_FULLY_REVIEWED/);assert.equal(readState(d).version,0);
  const d2=directory(t),b2=book();await assert.rejects(runResearch({book:b2,stateDir:d2,execute:async()=>{[...b2.groups.values()][0].tokens.clear();return{text:JSON.stringify(response())};}}),/REVALIDATION_REQUIRED/);assert.equal(readState(d2).version,0);
});
test('committed journal wins over pending cleanup failure and repairs strategy projection on explicit retry',async t=>{
  const d=directory(t),b=book(),paused=await pause(d,b),clear=checkpoint.clear;
  let result;try{checkpoint.clear=()=>{throw Error('SYNTHETIC_CLEANUP_FAILURE');};result=await runResearch({book:b,stateDir:d,resumeRunId:paused.run_id,broker:{capabilities:{},collect:async request=>({request,status:'OBSERVED',sources:[],token_evidence:[]})},execute:async()=>({text:JSON.stringify(response())})});}finally{checkpoint.clear=clear;}
  assert.equal(result.status,'COMMITTED');assert.equal(result.pending_cleanup,'PENDING_CLEANUP_FAILED');fs.unlinkSync(path.join(d,'STRATEGY.md'));
  const retry=await runResearch({book:b,stateDir:d,resumeRunId:paused.run_id,execute:async()=>{throw Error('NO_MODEL_RETRY');}});assert.equal(retry.status,'ALREADY_COMMITTED');assert.equal(readState(d).version,1);assert.equal(fs.readFileSync(path.join(d,'STRATEGY.md'),'utf8'),readState(d).strategy);assert(!checkpoint.exists(d));
});
