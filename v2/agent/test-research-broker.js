'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createResearchBroker}=require('./research-broker');
const {buildXSource}=require('./x-evidence');
const {coinIdentity,collectTokenFromPage}=require('./token-evidence');
const {FeedBook,SCOPE}=require('../market/network-feed');
const marketFixture=require('../market/fixtures/gmgn-network-2026-10-27.json');
const {runResearch,readState}=require('./research-host');
function response(){return{notes:'Keep the original question and inspect exact evidence.',reviewed_coin_ids:[],cited_source_ids:[],strategy:null,watches:[],research_requests:[],next_review_at:null};}
function directory(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'alphahands-broker-unit-'));t.after(()=>{
  assert.equal(path.dirname(fs.realpathSync(d)),fs.realpathSync(os.tmpdir()));
  for(const file of fs.readdirSync(d)){
    if(file==='research-cache'){const cache=path.join(d,file);assert(fs.lstatSync(cache).isDirectory());for(const png of fs.readdirSync(cache)){assert(/^[a-f0-9]{64}\.png$/.test(png));fs.unlinkSync(path.join(cache,png));}fs.rmdirSync(cache);continue;}
    assert(['turns.jsonl','research.jsonl','STRATEGY.md','research-pending.json'].includes(file));fs.unlinkSync(path.join(d,file));}fs.rmdirSync(d);
});return d;}
function book(){const b=new FeedBook();for(const f of ['migrated','trending']){assert(b.snapshot(f,marketFixture[f],SCOPE[f]).accepted);b.connection(f,true);}return b;}
async function tokenFixture(coinId){
  const c=coinIdentity(coinId),page={url:()=>c.url,evaluate:async()=>[c.address]};
  return collectTokenFromPage({page,coinId,readData:async()=>({address:c.address,symbol:'FIXTURE_TOKEN',market_cap_usd:250000,price_usd:0.01,
    liquidity_usd:5000,volume_24h_usd:10000,total_fees_native:0,total_fees_unit:c.chain==='solana'?'SOL':'ETH',holders_count:0,socials:{twitter:'https://x.com/Example'}}),
    readChart:async()=>({ok:false,reason:'FIXTURE_NO_CHART'})});
}
test('API failure plus real browser fallback retains both source attempts and original text',async t=>{
  const {chromium}=require('playwright'),browser=await chromium.launch({headless:true});t.after(()=>browser.close());let releases=0,throwApi=false;
  const request={kind:'x_link',input:'https://x.com/Example/status/123',reason:'Read exact source'};
  const broker=createResearchBroker({xApi:async r=>{if(throwApi)throw Error('SYNTHETIC_TRANSPORT_ERROR');return buildXSource({request:r,raw:null,capture_started_at:new Date().toISOString(),collected_at:new Date().toISOString()});},
    acquirePage:async()=>{const page=await browser.newPage();await page.route('https://x.com/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:
      `<article data-testid="tweet"><a href="/Example/status/123"><time datetime="${new Date(Date.now()-1000).toISOString()}"></time></a><div data-testid="tweetText">Original 🌿 source</div></article>`}));
      return{owned:true,page,release:async()=>{releases++;await page.close();}};}});
  const result=await broker.collect(request);assert.equal(result.status,'COLLECTED');assert.equal(releases,1);
  assert.equal(result.sources.length,2);assert.equal(result.sources[0].qualified,false);assert.equal(result.sources[1].qualified,true);
  assert.equal(result.sources[1].raw.tweets[0].text,'Original 🌿 source');assert.equal(broker.capabilities.execution,'UNAVAILABLE');
  throwApi=true;const recovered=await broker.collect(request);assert.equal(recovered.status,'COLLECTED');
  assert.equal(recovered.sources.length,1);assert.equal(recovered.attempts[0].reason,'X_API_UNAVAILABLE');assert.equal(recovered.attempts[1].transport,'OWNED_X_PAGE');
  assert.equal(releases,2);
});
test('unowned pages and arbitrary URLs never acquire navigation authority or get closed',async()=>{
  let acquired=0,navigated=0,closed=0;
  const broker=createResearchBroker({acquirePage:async()=>{acquired++;return{owned:false,page:{goto(){navigated++;}},release(){closed++;}};}});
  const invalid=await broker.collect({kind:'browser',input:'https://example.org',reason:'Outside configured scope'});assert.equal(invalid.status,'UNVERIFIED');assert.equal(acquired,0);
  for(const route of ['messages','notifications','bookmarks','compose']){
    const privatePage=await broker.collect({kind:'browser',input:'https://x.com/'+route,reason:'Not a public account'});
    assert.equal(privatePage.status,'UNVERIFIED');assert.equal(acquired,0);
  }
  const request={kind:'x_link',input:'https://x.com/Example',reason:'Read'};
  assert.equal((await broker.collect(request)).reason,'NAVIGATION_OWNED_PAGE_REQUIRED');
  assert.equal((await broker.collect(request)).reason,'BROWSER_LEASE_UNRESOLVED');
  assert.deepEqual([acquired,navigated,closed],[1,0,0]);
});
test('failed cleanup is explicit and blocks further acquisitions rather than restarting',async t=>{
  const {chromium}=require('playwright'),browser=await chromium.launch({headless:true});t.after(()=>browser.close());let acquired=0;
  const broker=createResearchBroker({acquirePage:async()=>{acquired++;const page=await browser.newPage();await page.route('https://x.com/**',r=>r.fulfill({contentType:'text/html',body:
    `<article data-testid="tweet"><a href="/Example/status/123"><time datetime="${new Date(Date.now()-1000).toISOString()}"></time></a><div data-testid="tweetText">Source</div></article>`}));
    return{owned:true,page,release:async()=>{throw Error('SYNTHETIC_CLEANUP_FAILURE');}};}});
  const request={kind:'x_link',input:'https://x.com/Example/status/123',reason:'Read'};
  const result=await broker.collect(request);assert.equal(result.reason,'BROWSER_LEASE_RELEASE_FAILED');assert.equal(result.status,'UNVERIFIED');assert.equal(result.sources[0].qualified,true);
  assert.equal((await broker.collect(request)).reason,'BROWSER_LEASE_UNRESOLVED');assert.equal(acquired,1);
});
test('host accepts a scoped token request, passes collected data and prior notes to the next round, without inference',async t=>{
  const b=book(),d=directory(t),coin=b.view().groups[0].rows[0].coin_id,e=await tokenFixture(coin);let round=0,collected=0;
  const broker={capabilities:{gmgn:'FIXTURE_ONLY',execution:'UNAVAILABLE'},collect:async request=>{collected++;return{request,status:'COLLECTED',reason:null,sources:[],token_evidence:[e]};}};
  const result=await runResearch({book:b,stateDir:d,broker,execute:async({packet,images})=>{
    const r=response();if(round++===0){r.research_requests=[{kind:'gmgn_token',input:coin,reason:'Exact token research'}];}
    else{assert.equal(packet.token_research[0].token.symbol,'FIXTURE_TOKEN');assert.equal(packet.token_research[0].token.holders_count,0);
      assert.equal(packet.token_research[0].chart.ok,false);assert.equal(images.length,0);
      assert.equal(packet.research_progress[0].notes,response().notes);assert.equal(packet.request_results[0].token_evidence_ids[0],e.id);}
    return{text:JSON.stringify(r)};
  }});
  assert.equal(result.status,'COMMITTED');assert.equal(collected,1);assert.equal(round,2);assert.equal(readState(d).version,1);
});
test('unknown coins are blocked before collection and the last round does not launch work it cannot consume',async t=>{
  const b=book(),d=directory(t);let collected=0;const broker={capabilities:{},collect:async()=>{collected++;throw Error('MUST_NOT_COLLECT');}};
  await assert.rejects(runResearch({book:b,stateDir:d,broker,execute:async()=>{const r=response();r.research_requests=[{kind:'gmgn_token',input:'solana:11111111111111111111111111111111',reason:'Unknown coin'}];return{text:JSON.stringify(r)};}}),/UNKNOWN_RESEARCH_COIN/);
  const coin=b.view().groups[0].rows[0].coin_id;
  const result=await runResearch({book:b,stateDir:d,broker,maxRounds:1,execute:async()=>{const r=response();r.research_requests=[{kind:'gmgn_token',input:coin,reason:'Next bounded run'}];return{text:JSON.stringify(r)};}});
  assert.equal(result.status,'RESEARCH_IN_PROGRESS');assert.equal(result.outstanding_requests[0].input,coin);assert.equal(collected,0);
});
test('multi-token research travels in explicit batches with all cached identities declared and prior packets retained',async t=>{
  const b=book(),d=directory(t),ids=[...new Set(b.view().groups.flatMap(g=>g.rows.map(r=>r.coin_id)))].slice(0,2);
  assert.equal(ids.length,2);const evidence=await Promise.all(ids.map(tokenFixture));let rounds=0;
  const broker={capabilities:{gmgn:'FIXTURE_ONLY'},collect:async request=>({request,status:'COLLECTED',reason:null,sources:[],token_evidence:[evidence[0]]})};
  await runResearch({book:b,stateDir:d,broker,tokenEvidence:evidence,execute:async({packet})=>{
    assert.equal(packet.token_research.length,1);assert.equal(packet.available_token_evidence.length,2);
    assert.equal(packet.available_token_evidence.filter(e=>e.selected).length,1);
    const r=response();if(rounds++===0){assert.equal(packet.token_research[0].coin_id,ids[1]);r.research_requests=[{kind:'gmgn_token',input:ids[0],reason:'Next detailed batch'}];}
    else assert.equal(packet.token_research[0].coin_id,ids[0]);return{text:JSON.stringify(r)};
  }});
  const turns=fs.readFileSync(path.join(d,'turns.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(turns.map(t=>t.packet.token_research[0].coin_id),[ids[1],ids[0]]);
});
test('an API returning a qualified different account cannot silently satisfy the requested account',async()=>{
  const other={kind:'x_link',input:'https://x.com/Other',reason:'Synthetic wrong response'},time=new Date().toISOString();let acquired=0;
  const broker=createResearchBroker({xApi:async()=>buildXSource({request:other,raw:{ok:true,tweets:[{id:'123',author:{handle:'Other'},date:time,text:'Wrong source'}]},capture_started_at:time,collected_at:time}),
    acquirePage:async()=>{acquired++;throw Error('MUST_NOT_ACQUIRE');}});
  const r=await broker.collect({kind:'x_link',input:'https://x.com/Example',reason:'Requested source'});
  assert.equal(r.status,'UNVERIFIED');assert.equal(r.reason,'X_API_SOURCE_MISMATCH');assert.equal(r.sources.length,0);assert.equal(acquired,0);
});
test('timed-out acquisition fails closed, prevents duplicate launches and releases a late owned lease',async()=>{
  let resolveLease,acquired=0,released=0;
  const broker=createResearchBroker({acquireTimeoutMs:5,acquirePage:()=>{acquired++;return new Promise(resolve=>{resolveLease=resolve;});}});
  const request={kind:'x_link',input:'https://x.com/Example',reason:'Synthetic slow acquisition'};
  assert.equal((await broker.collect(request)).reason,'BROWSER_LEASE_ACQUIRE_FAILED_OR_TIMED_OUT');
  assert.equal((await broker.collect(request)).reason,'BROWSER_LEASE_UNRESOLVED');
  resolveLease({owned:true,page:{},release:async()=>{released++;}});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(acquired,1);assert.equal(released,1);assert.equal(broker.capabilities.browser,'UNAVAILABLE_LEASE_UNRESOLVED');
});
