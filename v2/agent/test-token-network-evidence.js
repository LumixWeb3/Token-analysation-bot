'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {coinIdentity}=require('./token-evidence');
const {hash}=require('../market/network-feed');
const {describeTokenRoute,buildObservation,observationForPacket,observeTokenResponses,requestTokenDepthFromPage,publicTokenRequest,numeric}=require('./token-network-evidence');
const NOW=Date.parse('2026-11-06T16:00:00Z'),at=n=>new Date(n).toISOString();
const SOL=coinIdentity('solana:DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP');
const RH=coinIdentity('robinhood:0xedbf91223639800bcd5756815caf908df3b890be');
function observation(coin=SOL,kind='token_stat',data={holder_count:0,top_10_holder_rate:'0.116',top_bundler_trader_percentage:'0'},query='',creatorAddress=null){
  const route={full_info:'/mrwapi/v1/multi_token_full_info',token_stat:`/api/v1/token_stat/${coin.chain==='solana'?'sol':coin.chain}/${coin.address}`,
    holder_stat:`/vas/api/v1/token_holder_stat/${coin.chain==='solana'?'sol':coin.chain}/${coin.address}`,
    mcap_candles:`/api/v1/token_mcap_candles/${coin.chain==='solana'?'sol':coin.chain}/${coin.address}`,
    holder_wallets:`/vas/api/v1/token_holders/${coin.chain==='solana'?'sol':coin.chain}/${coin.address}`,
    developer_history:`/api/v1/dev_created_tokens/${coin.chain==='solana'?'sol':coin.chain}/${creatorAddress}`}[kind];
  return buildObservation({coin,creatorAddress,url:'https://gmgn.ai'+route+query,body:{code:0,data},request_started_at:at(NOW-1000),received_at:at(NOW)});
}
test('mixed full-info selects only the exact token public projection, excluding account values and personal flags',()=>{
  for(const coin of [SOL,RH]){
    const o=observation(coin,'full_info',[{chain:coin.chain==='solana'?'sol':coin.chain,address:coin.address,symbol:'FIXTURE',holder_count:0,
      total_fee:coin.chain==='solana'?'5424.14':'10.88',liquidity:0,creator_address:'PUBLIC_CREATOR',is_hidden:true,
      account:{access_token:'MUST_NOT_BE_COPIED'},link:{twitter:'https://x.com/Example',auth_token:'MUST_NOT_BE_COPIED'}}]);
    assert(!JSON.stringify(o).includes('MUST_NOT_BE_COPIED'));assert.equal(o.raw_public.is_hidden,undefined);
    const p=observationForPacket(o,coin,NOW);assert(p.qualified);assert.equal(p.fields.holders_count.value,0);
    assert.equal(p.fields.total_fees_native.unit,coin.chain==='solana'?'SOL':'ETH');assert.equal(p.fields.liquidity_usd.value,0);
    assert.equal(p.fields.top10_concentration_pct.state,'MISSING');assert.equal(p.raw_public.creator_address,'PUBLIC_CREATOR');
  }
  const raw={chain:'sol',address:SOL.address};
  for(const records of [[],[{...raw,address:RH.address}],[raw,raw]])assert.throws(()=>observation(SOL,'full_info',records),/IDENTITY/);
});
test('route and body identity reject cross-chain, duplicate, redirected and private responses',()=>{
  const url=`https://gmgn.ai/api/v1/token_stat/sol/${SOL.address}`;
  for(const wrong of [url.replace('gmgn.ai','example.com'),url.replace('/sol/','/robinhood/'),url.replace(SOL.address,RH.address),'https://gmgn.ai/api/v1/user'])assert.equal(describeTokenRoute(wrong,SOL),null);
  assert.throws(()=>observation(SOL,'token_stat',{access_token:'FIXTURE_ONLY'}),/PRIVATE_RESPONSE/);
  assert.throws(()=>buildObservation({coin:SOL,url,body:{code:401,data:{}},received_at:at(NOW)}),/PROVIDER_FAILURE/);
  const o=observation();assert.throws(()=>observationForPacket(o,RH,NOW),/IDENTITY/);
});
test('typed numbers preserve zeros and nulls; percentage fractions are converted once and invalids stay invalid',()=>{
  assert.deepEqual(numeric(null,'count'),{value:null,raw:null,state:'MISSING',unit:'count'});
  assert.equal(numeric('0','count').value,0);assert.equal(numeric('0.116','fraction').value,11.600000000000001);
  for(const raw of ['',true,'NaN','Infinity','-1','2e3',{},[]])assert.equal(numeric(raw,'USD').state,'INVALID');
  assert.equal(numeric('1.01','fraction').state,'INVALID');assert.equal(numeric('9007199254740993','count').state,'INVALID');
  const p=observationForPacket(observation(SOL,'token_stat',{holder_count:0,top_10_holder_rate:'11.6'}),SOL,NOW);
  assert.equal(p.qualified,false);assert.deepEqual(p.invalid_fields,['top10_concentration_pct']);
});

test('public holder transfer receipts preserve observed fields, nulls and zero without copying account metadata',()=>{
  const transfer={name:null,address:RH.address,timestamp:0,tx_hash:'0xpublic_fixture_hash',type:'transfer',account_address:'PRIVATE_FIXTURE_DO_NOT_COPY'};
  const row={address:RH.address,amount_percentage:'0.01',wallet_tag_v2:'TOP1',account_address:'PRIVATE_FIXTURE_DO_NOT_COPY',
    native_transfer:null,token_transfer:transfer,token_transfer_in:{...transfer,name:'Public source label'},token_transfer_out:null};
  const o=observation(RH,'holder_wallets',{list:[row],next:null},'?limit=100&orderby=amount_percentage&direction=desc');
  assert(!JSON.stringify(o).includes('PRIVATE_FIXTURE_DO_NOT_COPY'));
  assert.equal(o.raw_public.list[0].native_transfer,null);assert.equal(o.raw_public.list[0].token_transfer.timestamp,0);
  assert.deepEqual(o.raw_public.list[0].token_transfer,{name:null,address:RH.address,timestamp:0,tx_hash:'0xpublic_fixture_hash',type:'transfer'});
  assert.equal(o.raw_public.list[0].token_transfer_in.name,'Public source label');
  row.token_transfer.timestamp=-1;assert.throws(()=>observation(RH,'holder_wallets',{list:[row],next:null},'?limit=100&orderby=amount_percentage&direction=desc'),/TRANSFER_TIME_INVALID/);
});
test('collection freshness and integrity are recomputed; rehashed private or unexpected data does not qualify',()=>{
  const o=observation();assert(observationForPacket(o,SOL,NOW).qualified);
  for(const clock of [NOW-1,NOW+300001])assert.equal(observationForPacket(o,SOL,clock).qualified,false);
  const {id,...body}=o;body.raw_public.holder_count=99;assert.throws(()=>observationForPacket({id,...body},SOL,NOW),/INTEGRITY/);
  body.raw_public.extra='UNAPPROVED';assert.throws(()=>observationForPacket({id:hash(body),...body},SOL,NOW),/PROJECTION/);
  delete body.raw_public.extra;body.raw_public.auth_token='SYNTHETIC';assert.throws(()=>observationForPacket({id:hash(body),...body},SOL,NOW),/PRIVATE/);
});
test('holder aggregates retain KOL/smart counts without copying personal following or pretending to describe wallet flows',()=>{
  const p=observationForPacket(observation(SOL,'holder_stat',{renowned_count:2,smart_degen_count:0,following_count:99}),SOL,NOW);
  assert.equal(p.fields.renowned_count.value,2);assert.equal(p.fields.smart_degen_count.value,0);
  assert.equal(p.raw_public.following_count,undefined);assert.equal(p.fields.bundler_count.state,'MISSING');
});
test('MC candles retain sparse observed bars, reject bad OHLC/time order, and never invent volume units or full history',()=>{
  const list=[{time:NOW-120000,open:'10',high:'12',low:'9',close:'11',volume:'3',amount:'4'},
    {time:NOW-60000,open:'11',high:'13',low:'10',close:'12',volume:'5',amount:'6'}];
  const check=rows=>observationForPacket(observation(RH,'mcap_candles',{list:rows},'?resolution=1m&to=1793980800'),RH,NOW).candles;
  const c=check(list);assert.equal(c.state,'QUALIFIED_OBSERVED_WINDOW');assert.equal(c.rows.length,2);assert.equal(c.complete_history,false);
  assert.equal(c.rows[0].volume_unit,'UNVERIFIED');assert.equal(c.rows[0].close,11);
  for(const rows of [[list[1],list[0]],[list[0],list[0]],[{...list[0],time:NOW+1}],[{...list[0],high:'8'}]]){
    const bad=check(rows);assert.equal(bad.state,'UNVERIFIED');assert.equal(bad.rows.length,0);
  }
  assert.equal(observationForPacket(observation(RH,'mcap_candles',{list}),RH,NOW).candles.state,'UNVERIFIED');
});
test('passive capture owns only its listeners; ignores pre-existing and other-token traffic and preserves repeated observations',async()=>{
  const page=new EventEmitter(),request={},url=`https://gmgn.ai/api/v1/token_stat/sol/${SOL.address}`;
  const response={url:()=>url,request:()=>request,status:()=>200,body:async()=>Buffer.from(JSON.stringify({code:0,data:{holder_count:0}}))};
  const watcher=observeTokenResponses(page,SOL,{now:()=>NOW});page.emit('response',response);
  page.emit('request',request);page.emit('response',response);page.emit('response',response);
  page.emit('response',{...response,url:()=>url.replace(SOL.address,RH.address)});
  const result=await watcher.finish();assert.equal(result.observations.length,2);assert.equal(result.failures.length,0);
  assert.equal(page.listenerCount('request'),0);assert.equal(page.listenerCount('response'),0);assert.deepEqual(await watcher.finish(),result);
});
test('unfinished response bodies time out without a late mutation or dangling page listeners',async()=>{
  const page=new EventEmitter(),request={};let finishBody;
  const watcher=observeTokenResponses(page,SOL,{now:()=>NOW,finishTimeoutMs:10});page.emit('request',request);
  page.emit('response',{url:()=>`https://gmgn.ai/api/v1/token_stat/sol/${SOL.address}`,request:()=>request,status:()=>200,body:()=>new Promise(resolve=>{finishBody=resolve;})});
  const r=await watcher.finish();assert.equal(r.observations.length,0);assert.deepEqual(r.failures,[{reason:'TOKEN_JSON_CAPTURE_TIMEOUT'}]);
  finishBody(Buffer.from(JSON.stringify({code:0,data:{holder_count:0}})));await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(await watcher.finish(),r);assert.equal(page.listenerCount('response'),0);
});
test('actual holder-page fields retain native base units, pool/bot attribution and pagination without claiming KOL buys',()=>{
  const data={list:[{address:RH.address,exchange:'uniswap_v4',native_balance:'25139286601318590543516',amount_percentage:0.1065,usd_value:1328037,
    tags:['sandwich_bot'],maker_token_tags:['top_holder','bundler'],name:null,twitter_username:null,account_address:'OMIT_PERSONAL_FIELD'}],next:'NEXT_PUBLIC_PAGE'};
  const o=observation(RH,'holder_wallets',data,'?limit=100&orderby=amount_percentage&direction=desc');
  const p=observationForPacket(o,RH,NOW);assert(p.qualified);assert.equal(p.depth.returned_count,1);assert.equal(p.depth.has_more,true);
  assert.equal(p.depth.complete_wallet_list,false);assert.equal(p.depth.rows[0].native_balance_raw,data.list[0].native_balance);
  assert.equal(p.depth.rows[0].native_balance_unit,'PROVIDER_BASE_UNITS_UNVERIFIED');assert.equal(p.depth.rows[0].provider_exchange,'uniswap_v4');
  assert.deepEqual(p.depth.rows[0].provider_tags,['sandwich_bot']);assert(!JSON.stringify(o).includes('OMIT_PERSONAL_FIELD'));
  assert.equal(p.depth.rows[0].remaining_share.value,10.65);
  assert.throws(()=>observation(RH,'holder_wallets',{list:data.list}),/PAGINATION/);
  assert.throws(()=>observation(RH,'holder_wallets',{list:[{address:SOL.address}],next:null}),/ADDRESS/);
});
const holderRows=(count=20)=>Array.from({length:count},(_,i)=>({address:'0x'+(i+1).toString(16).padStart(40,'0'),
  amount_percentage:.2/(i+1),amount_cur:i===19?0:100/(i+1),usd_value:i===19?0:1000/(i+1),wallet_tag_v2:'TOP'+(i+1),
  name:null,twitter_username:null,tags:[],maker_token_tags:[],start_holding_at:0,end_holding_at:null}));
const holderQuery='?limit=100&orderby=amount_percentage&direction=desc';
test('top20 preserves provider order, exact chain/wallet identity, zeros/nulls, labels and provenance within a partial100 page',()=>{
  const list=holderRows(100);list[0]={...list[0],addr_type:2,exchange:'uniswap_v4',name:'Provider pool label'};
  list[1]={...list[1],name:'Bharat Krymo',twitter_username:'krybharat',twitter_name:'Provider X name',tags:['kol','fomo']};
  list[2].tags=null;delete list[3].tags;list[4].amount_cur=null;
  const o=observation(RH,'holder_wallets',{list,next:'NEXT_PUBLIC_PAGE',total:100,total_count:null},holderQuery),p=observationForPacket(o,RH,NOW),t=p.depth.top20;
  assert(t.qualified);assert(t.complete_top20);assert.equal(t.rows.length,20);assert.equal(t.source_page_returned_count,100);assert(t.has_more);assert.equal(t.complete_wallet_list,false);
  assert.deepEqual(t.rows.map(r=>r.address),list.slice(0,20).map(r=>r.address));assert.equal(t.rows[0].provider_rank,1);
  assert.equal(t.rows[0].chain,'robinhood');assert.equal(t.rows[0].token_coin_id,RH.coin_id);assert.equal(t.rows[0].wallet_id,'robinhood:'+list[0].address);
  assert.equal(t.rows[0].pool_exclusion,'NONE');assert.equal(t.excluded_rows.length,0);assert.equal(t.rows[1].provider_kol_label.state,'GMGN_KOL_TAG_OBSERVED');
  assert.equal(t.rows[1].provider_x_handle,'krybharat');assert.equal(t.rows[1].kol_attribution,'UNVERIFIED');assert.equal(t.rows[0].provider_kol_label.state,'UNKNOWN');
  assert.equal(t.rows[2].labels.tags.state,'NULL');assert.equal(t.rows[3].labels.tags.state,'MISSING');assert.equal(t.rows[4].remaining_tokens.state,'MISSING');
  assert.equal(t.rows[19].remaining_usd.value,0);assert.equal(t.rows[19].remaining_tokens.value,0);
  assert.equal(t.provider_total_fields.total.value,100);assert.equal(t.provider_total_fields.total_count.state,'MISSING');
  assert.equal(observationForPacket(observation(RH,'holder_wallets',{list:[],next:null,total:0},holderQuery),RH,NOW).depth.provider_total_fields.total.value,0);
  assert.equal(t.rows[1].label_provenance.observation_id,o.id);assert.equal(t.rows[1].label_provenance.source_row_index,1);assert.equal(t.rows[1].label_provenance.received_at,at(NOW));
  assert.equal(t.provider_updated_at,null);assert.equal(t.rows[1].provider_times.start_holding_at,0);assert.equal(t.rows[1].provider_times.end_holding_at,null);
  assert.equal(observationForPacket(o,RH,NOW+300001).depth.top20.qualified,false);
  assert.throws(()=>observationForPacket(o,SOL,NOW),/IDENTITY/);
});
test('top20 requires observed first-page scope, descending shares and matching provider ranks; it never sorts bad input to hide it',()=>{
  const cases=[
    {list:holderRows(19),query:holderQuery,reason:'FEWER_THAN_20_OBSERVED'},
    {list:holderRows(),query:'?limit=100&orderby=amount_percentage&direction=asc',reason:'FIRST_PAGE_UNFILTERED_SCOPE_UNVERIFIED'},
    {list:holderRows(),query:holderQuery+'&cursor=NEXT',reason:'FIRST_PAGE_UNFILTERED_SCOPE_UNVERIFIED'},
    {list:holderRows(),query:holderQuery+'&tag=kol',reason:'FIRST_PAGE_UNFILTERED_SCOPE_UNVERIFIED'},
    {list:holderRows(),query:holderQuery+'&limit=100',reason:'FIRST_PAGE_UNFILTERED_SCOPE_UNVERIFIED'},
    {list:holderRows(),query:holderQuery,reason:'PROVIDER_ORDER_NOT_DESCENDING',edit:r=>r[1].amount_percentage=.9},
    {list:holderRows(),query:holderQuery,reason:'PROVIDER_RANK_CONFLICT',edit:r=>r[1].wallet_tag_v2='TOP3'},
    {list:holderRows(),query:holderQuery,reason:'SHARE_MISSING_OR_INVALID',edit:r=>r[1].amount_percentage=null}
  ];
  for(const c of cases){c.edit?.(c.list);const o=observation(RH,'holder_wallets',{list:c.list,next:null},c.query),t=observationForPacket(o,RH,NOW).depth.top20;
    assert.equal(t.qualified,false);assert(t.reasons.includes(c.reason),c.reason);assert.deepEqual(t.rows.map(r=>r.address),c.list.slice(0,20).map(r=>r.address));}
  const rows=holderRows();rows[1].address=rows[0].address.toUpperCase().replace('0X','0x');
  assert.throws(()=>observation(RH,'holder_wallets',{list:rows,next:null},holderQuery),/DUPLICATE/);
});
test('holder public response does not equate empty or absent labels with absence of KOL and rejects malformed label arrays',()=>{
  const rows=holderRows();for(const r of rows)delete r.wallet_tag_v2;
  const t=observationForPacket(observation(RH,'holder_wallets',{list:rows,next:null},holderQuery),RH,NOW).depth.top20;
  assert(t.qualified);assert.equal(t.rows[0].provider_rank,null);assert.equal(t.rows[0].provider_kol_label.state,'UNKNOWN');
  rows[0].tags=[{label:'kol'}];assert.throws(()=>observation(RH,'holder_wallets',{list:rows,next:null},holderQuery),/TAGS_INVALID/);
  rows[0].tags=[];rows[0].name=42;assert.throws(()=>observation(RH,'holder_wallets',{list:rows,next:null},holderQuery),/LABEL_INVALID/);
  delete rows[0].name;
  for(const [total,reason]of [[0,'PROVIDER_TOTAL_BELOW_RETURNED_COUNT'],['NaN','PROVIDER_TOTAL_INVALID']]){
    const t=observationForPacket(observation(RH,'holder_wallets',{list:rows,next:null,total},holderQuery),RH,NOW).depth.top20;
    assert.equal(t.qualified,false);assert(t.reasons.includes(reason));
  }
});
test('developer sample binds to the observed creator, separates current MC from ATH and keeps mixed-chain limits visible',()=>{
  const creatorAddress=SOL.address,data={inner_count:7736,open_count:101,open_ratio:'0.013',creator_ath_info:{creator:creatorAddress,ath_token:SOL.address,ath_mc:'69000000'},
    tokens:[{token_address:SOL.address,chain:'sol',market_cap:'7900000',marcket_cap:'7900000',token_ath_mc:'69000000',total_fee:'5424.72',is_open:true},
      {token_address:RH.address,chain:'UNSUPPORTED',market_cap:'0',token_ath_mc:null,total_fee:'0'}]};
  const o=observation(SOL,'developer_history',data,'',creatorAddress),p=observationForPacket(o,SOL,NOW,creatorAddress);
  assert.equal(p.depth.complete_history,false);assert.equal(p.depth.returned_count,2);assert.equal(p.depth.total_migrated.value,101);
  assert.equal(p.depth.rows[0].current_mc.value,7900000);assert.equal(p.depth.rows[0].ath_mc.value,69000000);
  assert.equal(p.depth.rows[0].total_fees.unit,'SOL');assert.equal(p.depth.rows[1].state,'UNVERIFIED_TOKEN_IDENTITY');
  assert.equal(p.qualified,false);assert.equal(p.qualification_status,'UNVERIFIED_DEPTH_ROWS');
  assert.throws(()=>observationForPacket(o,SOL,NOW),/ROUTE_MISMATCH/);
  assert.throws(()=>observation(SOL,'developer_history',{...data,creator_ath_info:{creator:'not-a-wallet'}},'',creatorAddress),/ADDRESS/);
});
test('window market data needs an exact chain request, validates nested identities and labels MC derivation',()=>{
  const record={address:RH.address,circulating_supply:'1000000',holder_count:0,liquidity:'2000',total_fee:'10.883732',
    price:{address:RH.address,price:'0.0124',volume_24h:'750000',buys_24h:100,sells_24h:90},
    pool:{address:RH.address,quote_symbol:'ETH'},dev:{address:RH.address,creator_address:RH.address}};
  const input={coin:RH,url:'https://gmgn.ai/api/v1/mutil_window_token_info',body:{code:0,data:[record]},request_started_at:at(NOW-1),received_at:at(NOW)};
  assert.equal(publicTokenRequest({chain:'sol',addresses:[RH.address]},RH),null);
  assert.equal(publicTokenRequest({chain:'robinhood',addresses:[SOL.address]},RH),null);
  const request_context=publicTokenRequest({chain:'robinhood',addresses:[RH.address],unrelated_account:'DO_NOT_COPY'},RH);
  assert(!JSON.stringify(request_context).includes('DO_NOT_COPY'));
  assert.throws(()=>buildObservation(input),/CHAIN_REQUEST/);
  const p=observationForPacket(buildObservation({...input,request_context}),RH,NOW);
  assert.equal(p.fields.price_usd.value,0.0124);assert.equal(p.fields.volume_24h_usd.value,750000);
  assert.equal(p.fields.derived_market_cap_usd.value,12400);assert.equal(p.fields.derived_market_cap_usd.state,'DERIVED');
  assert.equal(p.fields.total_fees_native.unit,'ETH');assert.equal(p.raw_public.price.buys_24h,100);
  assert.throws(()=>buildObservation({...input,request_context:{...request_context,cookie:'SYNTHETIC'}}),/CONTEXT_NOT_PUBLIC/);
  record.price.address=SOL.address;assert.throws(()=>buildObservation({...input,request_context}),/NESTED_IDENTITY/);
});
test('already qualified matching holder observations avoid a duplicate request; other scopes still fetch',async()=>{
  const routes=[],page={url:()=>SOL.url,evaluate:async(fn,route)=>{routes.push(route);return{status:200};}};
  const results=await requestTokenDepthFromPage(page,SOL,SOL.address,{reuse:(kind,q)=>kind==='holder_wallets'&&q.limit==='100'});
  assert.equal(results[0].reused_observation,true);assert.equal(routes.length,1);assert(routes[0].includes('dev_created_tokens'));
});
test('explicit depth requests use only the same token page and two observed public paths, with no UI clicks or auth export',async()=>{
  const requested=[],page={url:()=>RH.url,evaluate:async(fn,route)=>{requested.push(route);return{status:200};}};
  const result=await requestTokenDepthFromPage(page,RH,RH.address);assert.equal(result.length,2);
  assert.equal(requested[0],`/vas/api/v1/token_holders/robinhood/${RH.address}?limit=100&orderby=amount_percentage&direction=desc`);
  assert.equal(requested[1],`/api/v1/dev_created_tokens/robinhood/${RH.address}`);
  await assert.rejects(requestTokenDepthFromPage({...page,url:()=>SOL.url},RH,RH.address),/PAGE_CHANGED/);
});
test('real browser fetch returns numeric status, captures both public bodies, and refuses HTTP200 provider errors',async t=>{
  const {chromium}=require('playwright'),browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();let failDev=false;
  await page.route('https://gmgn.ai/**',route=>{
    const u=new URL(route.request().url());
    if(u.pathname.includes('/token_holders/'))return route.fulfill({contentType:'application/json',body:JSON.stringify({code:0,data:{list:[],next:null}})});
    if(u.pathname.includes('/dev_created_tokens/'))return route.fulfill({contentType:'application/json',body:JSON.stringify(failDev?{code:1,data:{}}:
      {code:0,data:{tokens:[],inner_count:0,open_count:0,open_ratio:'0',creator_ath_info:{creator:RH.address}}})});
    return route.fulfill({contentType:'text/html; charset=utf-8',body:'<h1>Isolated token fixture</h1>'});
  });
  await page.goto(RH.url);
  for(const bad of [false,true]){
    failDev=bad;const watcher=observeTokenResponses(page,RH);watcher.setCreator(RH.address);
    const result=await requestTokenDepthFromPage(page,RH,RH.address);assert.deepEqual(result.map(r=>r.status),[200,200]);
    assert(result.every(r=>!r.error_type));const captured=await watcher.finish();
    assert.equal(captured.observations.length,bad?1:2);
    if(bad)assert(captured.failures.some(f=>f.reason==='TOKEN_JSON_PROVIDER_FAILURE'));else assert.equal(captured.failures.length,0);
  }
});
