'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),zlib=require('node:zlib');
const {hash}=require('../market/network-feed');
const {collectTokenFromPage,tokenForPacket,coinIdentity,validatePng,compareDomFields}=require('./token-evidence');
const {buildXSource,sourceForPacket,stamp}=require('./x-evidence');
const {validateImageInputs,writeImageInputs}=require('./codex-runner');
const {researchSource,sourceCatalogue,validateReview}=require('./research-host');
const NOW=Date.parse('2026-11-06T14:00:00Z'),iso=n=>new Date(n).toISOString();
const SOL='solana:DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP';
const RH='robinhood:0xedbf91223639800bcd5756815caf908df3b890be';
const clone=x=>JSON.parse(JSON.stringify(x));
function png(){
  const crc=bytes=>{let c=-1;for(const b of bytes){c^=b;for(let n=0;n<8;n++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^-1)>>>0;};
  const chunk=(name,data)=>{const type=Buffer.from(name),head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);tail.writeUInt32BE(crc(Buffer.concat([type,data])));return Buffer.concat([head,type,data,tail]);};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(200);ihdr.writeUInt32BE(120,4);ihdr[8]=8;ihdr[9]=2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(Buffer.alloc((200*3+1)*120))),chunk('IEND',Buffer.alloc(0))]);
}
function source(patch={},request={kind:'x_link',input:'https://x.com/Example',reason:'Token narrative'}){
  return buildXSource({request,raw:{ok:true,tweets:[{id:'123',text:'Original post',author:{handle:'Example'},date:iso(NOW-3600000),likes:null,urls:[{url:'https://t.co/test',expanded_url:'https://example.org/coin'}],...patch}]},capture_started_at:iso(NOW-500),collected_at:iso(NOW)});
}
async function evidence(coin=SOL,patch={},options={}){
  const id=coinIdentity(coin);let read=0;
  const page={url:()=>options.wrongUrl??id.url,evaluate:async()=>++read===2&&options.changed?[coinIdentity(RH).address]:[id.address]};
  const bytes=png();
  return collectTokenFromPage({page,coinId:coin,now:()=>NOW,
    networkCapture:options.network?async()=>options.network:undefined,
    readData:async()=>({address:id.address,symbol:'FIXTURE',market_cap_usd:250000,price_usd:0.001,liquidity_usd:0,volume_24h_usd:10000,
      total_fees_native:0,total_fees_unit:id.chain==='solana'?'SOL':'ETH',holders_count:0,top10_concentration_pct:0,bundler_pct_gmgn:0,
      socials:{twitter:'https://x.com/Example'},dev_token_count:null,...patch}),
    readChart:async()=>options.noChart?{ok:false,reason:'CHART_UNVERIFIED'}:({ok:true,coin_id:coin,source_url:id.url,captured_at:iso(NOW),
      rendered_label:`Chart for ${id.chain==='solana'?'sol':id.chain}/${id.address}/USD/MCAP, 1 second`,content_type:'image/png',
      sha256:require('node:crypto').createHash('sha256').update(bytes).digest('hex'),width:200,height:120,base64:bytes.toString('base64')})});
}
test('same token evidence retains zero, null, every raw field, native chain units and explicit missing depth',async()=>{
  for(const coin of [SOL,RH]){
    const e=await evidence(coin),result=tokenForPacket(e,[source()],NOW);
    assert.equal(result.packet.research_ready,true);assert.deepEqual(result.packet.token,e.token);
    assert.equal(result.packet.token.holders_count,0);assert.equal(result.packet.token.dev_token_count,null);
    assert.equal(result.packet.token.total_fees_unit,coin===SOL?'SOL':'ETH');
    assert.equal(result.packet.coverage.kol_flows,'NOT_COLLECTED');assert.equal(result.packet.execution_qualified,false);
    assert.equal(result.images.length,1);assert.equal(result.packet.chart.base64,undefined);
    result.packet.token.socials.twitter='changed';assert.equal(e.token.socials.twitter,'https://x.com/Example');
  }
});
test('wrong page and token changing during collection fail without returning an old chart',async()=>{
  await assert.rejects(evidence(SOL,{}, {wrongUrl:coinIdentity(RH).url}),/IDENTITY_MISMATCH/);
  await assert.rejects(evidence(SOL,{}, {changed:true}),/CHANGED_DURING_CAPTURE/);
});
test('snapshot tampering, cross-chain chart and stale or future collection are rejected',async()=>{
  const e=await evidence();const modified=clone(e);modified.token.price_usd=99;
  assert.throws(()=>tokenForPacket(modified,[source()],NOW),/INTEGRITY/);
  for(const time of [NOW-1,NOW+300001])assert.throws(()=>tokenForPacket(e,[source()],time),/TIME/);
  const {id,...body}=e;body.chart.coin_id=RH;const wrong={id:hash(body),...body};
  assert.throws(()=>tokenForPacket(wrong,[source()],NOW),/CHART_IDENTITY/);
});

test('a snapshot aging during research remains lossless historical evidence with current qualification withdrawn',async()=>{
  const e=await evidence(),original=JSON.stringify(e),later=NOW+300001;
  const result=tokenForPacket(e,[source()],later,{allowHistorical:true});
  assert.equal(result.packet.freshness_status,'HISTORICAL_REQUIRES_REFRESH');
  assert.equal(result.packet.capture_age_ms,300001);
  assert.equal(result.packet.collected_at,e.collected_at);
  assert.equal(result.packet.evidence_id,e.id);
  assert.deepEqual(result.packet.token,e.token);
  assert.equal(result.packet.research_ready,false);
  assert.equal(result.packet.execution_qualified,false);
  assert(result.packet.reasons.includes('STALE_TOKEN_SNAPSHOT_REQUIRES_REFRESH'));
  assert.equal(result.images[0].base64,e.chart.base64);
  assert.equal(JSON.stringify(e),original);
  assert.throws(()=>tokenForPacket(e,[source()],later),/TIME/);
  assert.throws(()=>tokenForPacket(e,[source()],NOW-1,{allowHistorical:true}),/TIME/);
  const modified=clone(e);modified.token.price_usd=99;
  assert.throws(()=>tokenForPacket(modified,[source()],later,{allowHistorical:true}),/INTEGRITY/);
});

test('research packet retains expired token and chart without admitting them as current citations',async()=>{
  const {FeedBook,SCOPE}=require('../market/network-feed');
  const fixture=require('../market/fixtures/gmgn-network-2026-10-27.json');
  const {packetFor,sourceCatalogue,validateReview}=require('./research-host');
  const e=await evidence(),later=NOW+300001,book=new FeedBook({now:()=>later});
  for(const feed of ['migrated','trending']){
    assert(book.snapshot(feed,fixture[feed],SCOPE[feed]).accepted);book.connection(feed,true);
  }
  const packet=packetFor(book,{version:0,watches:[],reviewed_coin_ids:[]},[source()],[e]);
  const token=packet.token_research[0];
  assert.equal(token.freshness_status,'HISTORICAL_REQUIRES_REFRESH');
  assert.equal(token.research_ready,false);
  assert.deepEqual(token.token,e.token);
  assert.equal(token.chart.sha256,e.chart.sha256);
  assert.equal(sourceCatalogue(packet,later).find(s=>s.id===e.id).qualified,false);
  assert.throws(()=>validateReview({notes:'Historical snapshot only.',reviewed_coin_ids:[],cited_source_ids:[e.id],
    strategy:{operation:'NOTE',markdown:'Unsupported current claim.'},watches:[],research_requests:[],next_review_at:null},packet,{now:later}),/UNVERIFIED_SOURCE_CITATION/);
  assert.equal(packet.market.groups.length,4);
});

test('superseded same-turn input citations remain known with their actual age and identity',async()=>{
  const {sourceCatalogue,validateReview}=require('./research-host');
  const old=tokenForPacket(await evidence(SOL),[source()],NOW).packet;
  const selected=tokenForPacket(await evidence(RH),[source()],NOW).packet;
  const packet={controls:{required_initial_coin_ids:[SOL,RH]},state:{watches:[],reviewed_coin_ids:[]},
    market:{research_ready:true,recorded_at:iso(NOW),groups:[]},sources:[],token_research:[selected],prior_token_research:[old]};
  assert.equal(sourceCatalogue(packet,NOW).find(s=>s.id===old.evidence_id).qualified,true);
  const review={notes:'Cite the original same-turn input.',reviewed_coin_ids:[],cited_source_ids:[old.evidence_id],
    strategy:{operation:'NOTE',markdown:'Source-backed research.'},watches:[],research_requests:[],next_review_at:null};
  assert.equal(validateReview(review,packet,{now:NOW}),review);
  assert.equal(sourceCatalogue(packet,NOW+300001).find(s=>s.id===old.evidence_id).qualified,false);
  assert.throws(()=>validateReview(review,packet,{now:NOW+300001}),/UNVERIFIED_SOURCE_CITATION/);
  assert.throws(()=>validateReview({...review,cited_source_ids:['f'.repeat(64)]},packet,{now:NOW}),/UNVERIFIED_SOURCE_CITATION/);
  assert.equal(old.collected_at,iso(NOW));
});
test('missing optional depth stays explicit; missing core fields, chart or linked X prevents complete initial research',async()=>{
  const p=tokenForPacket(await evidence(SOL,{price_usd:null}, {noChart:true}),[],NOW).packet;
  assert.equal(p.research_ready,false);assert.deepEqual(p.reasons,['MISSING:price_usd','LINKED_X_UNVERIFIED','CHART_UNVERIFIED']);
  const unrelated=source({}, {kind:'x_link',input:'https://x.com/Other',reason:'Unrelated'});
  assert(tokenForPacket(await evidence(),[unrelated],NOW).packet.reasons.includes('LINKED_X_UNVERIFIED'));
});
test('invalid numeric values and wrong native unit do not silently become missing or cross-chain fees',async()=>{
  const e=await evidence();const {id,...body}=e;body.token.market_cap_usd=-1;
  assert.throws(()=>tokenForPacket({id:hash(body),...body},[source()],NOW),/NUMERIC/);
  body.token.market_cap_usd=1;body.token.total_fees_unit='ETH';
  assert.throws(()=>tokenForPacket({id:hash(body),...body},[source()],NOW),/FEE_UNIT/);
});
test('source checks reject absent/invalid/future dates and permalink/author conflicts',()=>{
  for(const patch of [{date:null},{date:'not a date'},{date:iso(NOW+1)},{id:123},{text:' '},{text_complete:false},{author:{handle:'Other'}},{url:'https://x.com/Other/status/123'}]){
    const s=source(patch);assert.equal(s.qualified,false);assert.equal(s.checked_count,1);assert.equal(s.unverified_count,1);
    assert(s.post_checks[0].reasons.length);
  }
});
test('browser adapter marks Show more text incomplete and preserves the exact opened status',async t=>{
  const {chromium}=require('playwright'),{collectXFromPage}=require('./x-browser-source');
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.route('https://x.com/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`<div data-testid="UserDescription">Community <img alt="🌿">; ${SOL}</div><article data-testid="tweet"><a href="/Example/status/123"><time datetime="${iso(NOW-1000)}"></time></a><div data-testid="tweetText">Original <img alt="🌿"> complete<br>or collapsed text</div><button data-testid="tweet-text-show-more-link">Show more</button></article>`}));
  await page.goto('https://x.com/Example/status/123');
  const request={kind:'x_link',input:'https://x.com/Example/status/123',reason:'Original source'};
  const collapsed=await collectXFromPage({page,request,now:()=>NOW});assert.equal(collapsed.qualified,false);assert(collapsed.post_checks[0].reasons.includes('POST_TEXT_COLLAPSED'));
  await page.locator('[data-testid="tweet-text-show-more-link"]').evaluate(e=>e.remove());
  const full=await collectXFromPage({page,request,now:()=>NOW});assert(full.qualified);assert.equal(full.current_count,1);assert.equal(full.raw.tweets[0].url,request.input);
  assert.equal(full.raw.tweets[0].text,'Original 🌿 complete\nor collapsed text');
  assert.equal(full.raw.profile_bio_text,null);
  await page.goto('https://x.com/Example');
  const profile=await collectXFromPage({page,request:{kind:'x_link',input:'https://x.com/Example',reason:'Public profile'},now:()=>NOW});
  assert.equal(profile.raw.profile_bio_text,'Community 🌿; '+SOL);assert.match(profile.raw.profile_bio_coverage,/VISIBLE_PROFILE/);
});
test('archival posts remain historical evidence, and stale collection loses qualification at consumption',()=>{
  const s=source({date:iso(NOW-30*86400000)});assert(s.qualified);assert.equal(s.current_count,0);assert.equal(s.archival_count,1);
  assert.equal(s.status,'QUALIFIED_ARCHIVAL_SAMPLE');assert.equal(sourceForPacket(s,NOW+300001).qualified,false);
  const tampered=clone(s);tampered.raw.tweets[0].text='replaced';assert.throws(()=>sourceForPacket(tampered,NOW),/HASH/);
});
test('repeated X records and expanded URLs remain lossless, with unknown unchecked coverage',async()=>{
  const post=source().raw.tweets[0],s=await researchSource({kind:'x_link',input:'https://x.com/Example',reason:'Verify'},
    {now:()=>NOW,client:{xUserTweets:async()=>({ok:true,tweets:[post,clone(post)]})}});
  assert.equal(s.qualified_count,2);assert.equal(s.raw.tweets.length,2);assert.equal(s.raw.tweets[0].likes,null);
  assert.equal(s.raw.tweets[0].urls[0].expanded_url,'https://example.org/coin');assert.equal(s.unchecked_count,null);
});
test('wrong community and browser page are unverified while their raw observations remain inspectable',()=>{
  const s=buildXSource({request:{kind:'x_link',input:'https://x.com/i/communities/123',reason:'Community'},
    raw:{ok:true,community_id:'999',tweets:source().raw.tweets},capture_started_at:iso(NOW),collected_at:iso(NOW)});
  assert.equal(s.qualified,false);assert.equal(s.reason,'COMMUNITY_ID_MISMATCH');assert.equal(s.raw.community_id,'999');
  const b=buildXSource({request:{kind:'x_link',input:'https://x.com/Example',reason:'Browser'},transport:'BROWSER_DOM',source_page_url:'https://x.com/Other',
    raw:source().raw,capture_started_at:iso(NOW),collected_at:iso(NOW)});assert.equal(b.reason,'BROWSER_SOURCE_PAGE_MISMATCH');
});
test('handoff requires actual exact-hash image bytes and materializes only those images in the isolated workspace',async t=>{
  const handoff=tokenForPacket(await evidence(),[source()],NOW),packet={token_research:[handoff.packet]};
  assert.throws(()=>validateImageInputs(packet,[]),/INCOMPLETE/);
  const mismatch=clone(handoff.images);mismatch[0].coin_id=RH;assert.throws(()=>validateImageInputs(packet,mismatch),/IDENTITY/);
  const bytes=validateImageInputs(packet,handoff.images),directory=fs.mkdtempSync(path.join(os.tmpdir(),'alphahands-v2-images-'));
  t.after(()=>{for(const f of fs.readdirSync(directory))fs.unlinkSync(path.join(directory,f));fs.rmdirSync(directory);});
  const files=writeImageInputs(directory,bytes);assert.equal(files.length,1);assert.deepEqual(fs.readFileSync(files[0]),png());
  assert(!JSON.stringify(packet).includes(handoff.images[0].base64));
});
test('a PNG header, corrupt compressed bytes, incomplete file or trailing data cannot masquerade as a chart',()=>{
  const valid=png();assert.equal(validatePng(valid.toString('base64')).width,200);
  for(const bad of [valid.subarray(0,33),valid.subarray(0,valid.length-1),Buffer.concat([valid,Buffer.from('extra')]),Buffer.from(valid)]){
    if(bad.length===valid.length)bad[50]^=1;
    assert.throws(()=>validatePng(bad.toString('base64')),/CHART_BYTES/);
  }
});
test('strict source dates reject normalized impossible calendar dates and rehashed source identity lies',()=>{
  for(const date of ['2026-02-30T12:00:00Z','2026-11-06T24:00:00Z','2026-11-06T12:60:00Z'])assert(Number.isNaN(stamp(date)));
  assert(Number.isFinite(stamp('2024-02-29T12:00:00+05:30')));
  const s=source(),{id,qualified,status,reason,checked_count,qualified_count,unverified_count,current_count,archival_count,post_checks,capture_age_ms,note,...body}=s;
  body.request={kind:'browser',input:'https://x.com/Example',reason:'Unsupported tool'};
  assert.throws(()=>sourceForPacket({id:hash(body),...body},NOW),/SOURCE_IDENTITY/);
  const search=buildXSource({request:{kind:'x_search',input:'exact query',reason:'Search'},raw:{ok:true,query:'exact query',tweets:s.raw.tweets},transport:'BROWSER_DOM',
    source_page_url:'https://example.org/search?q=exact+query',capture_started_at:iso(NOW),collected_at:iso(NOW)});
  assert.equal(search.qualified,false);assert.equal(search.reason,'BROWSER_SEARCH_PAGE_MISMATCH');
});
test('all exact-token network records and raw public nulls survive the same token/image/source handoff',async()=>{
  const {buildObservation}=require('./token-network-evidence'),coin=coinIdentity(SOL);
  const o=buildObservation({coin,url:`https://gmgn.ai/api/v1/token_stat/sol/${coin.address}`,body:{code:0,data:{holder_count:0,creator_hold_rate:null}},
    request_started_at:iso(NOW-1000),received_at:iso(NOW)});
  const e=await evidence(SOL,{}, {network:{observations:[o,clone(o)],failures:[]}}),p=tokenForPacket(e,[source()],NOW);
  assert.equal(p.packet.network.observations.length,2);assert.equal(p.packet.network.observations[0].raw_public.creator_hold_rate,null);
  assert.equal(p.packet.network.observations[0].fields.holders_count.value,0);assert.equal(p.packet.deep_research_complete,false);
  assert.equal(p.packet.readiness_scope,'CORE_MARKET_CHART_LINKED_X_REVIEW');assert.equal(validateImageInputs({token_research:[p.packet]},p.images).length,1);
  p.packet.network.observations[0].raw_public.holder_count=99;assert.equal(e.network.observations[0].raw_public.holder_count,0);
});
test('DOM and JSON comparisons preserve rounding and conflicts without substituting a network or derived value',()=>{
  const token={price_usd:0.0124,price_text:'$0.0124',market_cap_usd:12400,market_cap_text:'$12.4K',total_fees_native:10.88,total_fees_text:'10.88',holders_count:100};
  const o={id:'PUBLIC_SOURCE',fields:{price_usd:{state:'OBSERVED',value:0.0124001,unit:'USD'},
    derived_market_cap_usd:{state:'DERIVED',value:12400.1,unit:'USD',formula:'circulating_supply * price_usd'},
    total_fees_native:{state:'OBSERVED',value:10.883732,unit:'ETH'},holders_count:{state:'OBSERVED',value:101,unit:'count'}}};
  const before=clone(token),result=compareDomFields(token,[o]);assert.deepEqual(token,before);
  assert.equal(result[0].state,'COMPATIBLE_WITH_DISPLAY_PRECISION');assert.equal(result[1].derivation,o.fields.derived_market_cap_usd.formula);
  assert.equal(result[2].state,'COMPATIBLE_WITH_DISPLAY_PRECISION');assert.equal(result[3].state,'DIFFERENT_OBSERVATIONS');
});
test('the same exact-token handoff exposes observed top20 coverage and preserves GMGN KOL tag provenance',async()=>{
  const {buildObservation}=require('./token-network-evidence'),coin=coinIdentity(RH);
  const list=Array.from({length:20},(_,i)=>({address:'0x'+(i+1).toString(16).padStart(40,'0'),amount_percentage:.1/(i+1),usd_value:0,
    wallet_tag_v2:'TOP'+(i+1),tags:i===0?['kol']:[],name:i===0?'Provider label':null,twitter_username:null}));
  const o=buildObservation({coin,url:`https://gmgn.ai/vas/api/v1/token_holders/robinhood/${coin.address}?limit=100&orderby=amount_percentage&direction=desc`,
    body:{code:0,data:{list,next:'NEXT_PUBLIC_PAGE'}},request_started_at:iso(NOW-1),received_at:iso(NOW)});
  const e=await evidence(RH,{}, {network:{observations:[o],failures:[]}}),p=tokenForPacket(e,[],NOW);
  assert.equal(p.packet.coverage.holder_top20,'QUALIFIED_OBSERVED_TOP20');assert.equal(p.packet.network.holder_top20[0].coin_id,RH);
  assert.equal(p.packet.network.holder_top20[0].observation_id,o.id);assert.equal(p.packet.network.observations[0].depth.top20.rows[0].provider_kol_label.state,'GMGN_KOL_TAG_OBSERVED');
  assert.equal(p.packet.network.holder_top20[0].rows_ref,'/network/observations/0/depth/top20/rows');
  assert.equal(p.packet.network.observations[0].raw_public.list[0].tags[0],'kol');assert.equal(p.packet.deep_research_complete,false);
  assert.equal(tokenForPacket(await evidence(),[],NOW).packet.coverage.holder_top20,'NOT_COLLECTED');
});
test('the research host can cite real GMGN evidence and rechecks it instead of accepting stored qualified flags',async()=>{
  const {buildObservation}=require('./token-network-evidence'),coin=coinIdentity(SOL);
  const o=buildObservation({coin,url:`https://gmgn.ai/api/v1/token_stat/sol/${coin.address}`,body:{code:0,data:{holder_count:0}},request_started_at:iso(NOW-1),received_at:iso(NOW)});
  const e=await evidence(SOL,{}, {network:{observations:[o],failures:[]}}),handoff=tokenForPacket(e,[source()],NOW);
  const packet={sources:handoff.sources,token_research:[handoff.packet],controls:{required_initial_coin_ids:[SOL]},state:{reviewed_coin_ids:[],strategy_status:'UNINITIALIZED'}};
  assert(sourceCatalogue(packet,NOW).some(s=>s.id===o.id&&s.qualified));
  const r={notes:'Exact-token source reviewed.',reviewed_coin_ids:[SOL],cited_source_ids:[o.id],strategy:null,watches:[],research_requests:[],next_review_at:null};
  assert.equal(validateReview(r,packet,{now:NOW}),r);
  assert.equal(validateReview(r,packet,{now:NOW+300001}),r);
  assert.equal(sourceCatalogue(packet,NOW+300001).find(s=>s.id===o.id).qualified,false);
  assert.throws(()=>validateReview({...r,strategy:{operation:'NOTE',markdown:'Unsupported current observation'}},packet,{now:NOW+300001}),/UNVERIFIED_SOURCE_CITATION/);
  packet.token_research[0].network.observations[0].raw_public.holder_count=999;
  assert.throws(()=>validateReview(r,packet,{now:NOW}),/TOKEN_JSON_INTEGRITY/);
});
test('X handle case changes do not break a real link, while different authors and post IDs stay disqualified',async()=>{
  const s=source({}, {kind:'x_link',input:'https://x.com/eXaMpLe',reason:'Same account'});
  assert.equal(tokenForPacket(await evidence(),[s],NOW).packet.research_ready,true);
  const browser=buildXSource({request:{kind:'x_link',input:'https://x.com/EXAMPLE/status/123',reason:'Same status'},raw:source().raw,
    capture_started_at:iso(NOW),collected_at:iso(NOW),transport:'BROWSER_DOM',source_page_url:'https://x.com/example/status/123'});
  assert(browser.qualified);assert.equal(tokenForPacket(await evidence(),[browser],NOW).packet.research_ready,true);
  const other=source({}, {kind:'x_link',input:'https://x.com/Different',reason:'Other account'});
  assert.equal(tokenForPacket(await evidence(),[other],NOW).packet.research_ready,false);
});

test('paper response requires accepted strategy, exact cited qualified token and matching account revision',async()=>{
  const s=source(),e=await evidence(),token=tokenForPacket(e,[s],NOW).packet;
  const packet={controls:{required_initial_coin_ids:[SOL],account_state:{revision:4,positions:[]}},
    state:{strategy_status:'RESEARCHED',reviewed_coin_ids:[SOL],watches:[]},sources:[s],token_research:[token]};
  const response={notes:'Fixture entry evaluation',reviewed_coin_ids:[SOL],cited_source_ids:[e.id],strategy:null,watches:[],research_requests:[],next_review_at:null,
    paper_action:{action:'BUY',coin_id:SOL,expected_account_revision:4,percent:20,entry_low_mc:200000,entry_high_mc:300000,reason:'Synthetic setup'}};
  assert.equal(validateReview(response,packet,{now:NOW}),response);
  for(const altered of [{...response,paper_action:{...response.paper_action,expected_account_revision:3}},
    {...response,cited_source_ids:[]},{...response,strategy:{operation:'NOTE',markdown:'Change'}}])assert.throws(()=>validateReview(altered,packet,{now:NOW}));
  assert.throws(()=>validateReview(response,{...packet,state:{...packet.state,strategy_status:'UNINITIALIZED'}},{now:NOW}),/ENTRY_EVIDENCE/);
  assert.throws(()=>validateReview(response,{...packet,token_research:[{...token,research_ready:false}]},{now:NOW}),/ENTRY_EVIDENCE/);
});
