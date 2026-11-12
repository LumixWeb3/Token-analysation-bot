'use strict';

// Inert collection/handoff boundary. Caller owns the page and all navigation.
const crypto=require('node:crypto');
const {identity,sourceLink}=require('../market/gmgn');
const {hash}=require('../market/network-feed');
const {sourceForPacket,stamp,sameXSource,MAX_CAPTURE_AGE_MS}=require('./x-evidence');
const {observationForPacket}=require('./token-network-evidence');
const clone=value=>JSON.parse(JSON.stringify(value));
const CORE=['market_cap_usd','price_usd','liquidity_usd','volume_24h_usd','total_fees_native','holders_count'];
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function explicitMissing(value){
  if(value===undefined)return null;
  if(typeof value==='number'&&!Number.isFinite(value))throw Error('TOKEN_NONFINITE_VALUE');
  if(Array.isArray(value))return value.map(explicitMissing);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,explicitMissing(v)]));
  return value;
}
function coinIdentity(coinId){
  const match=/^(solana|robinhood):(.+)$/.exec(coinId??'');
  if(!match)throw Error('EXACT_COIN_ID_REQUIRED');
  return identity(`https://gmgn.ai/${match[1]==='solana'?'sol':match[1]}/token/${match[2]}`);
}
function validatePageUrl(url,expected){
  if(identity(url).coin_id!==expected.coin_id)throw Error('TOKEN_PAGE_IDENTITY_MISMATCH');
}
function compareDomFields(token,observations){
  const comparisons=[],texts={total_fees_native:'total_fees_text',liquidity_usd:'liquidity_text',price_usd:'price_text',volume_24h_usd:'volume_24h_text',market_cap_usd:'market_cap_text'};
  for(const observation of observations)for(const [sourceField,value]of Object.entries(observation.fields)){
    const field=sourceField==='derived_market_cap_usd'?'market_cap_usd':sourceField;
    const dom=token[field];if(typeof dom!=='number'||!Number.isFinite(dom)||!['OBSERVED','DERIVED'].includes(value.state))continue;
    const difference=value.value-dom,epsilon=Math.max(1,Math.abs(dom))*Number.EPSILON*8;
    const raw=token[texts[field]],m=typeof raw==='string'?/^\$?([\d,]+)(?:\.(\d+))?([KMB])?$/.exec(raw):null;
    const precision=m?10**(-(m[2]?.length??0))*({K:1e3,M:1e6,B:1e9}[m[3]]??1):null;
    comparisons.push({observation_id:observation.id,field,source_field:sourceField,derivation:value.formula??null,dom_value:dom,network_value:value.value,unit:value.unit,
      state:Math.abs(difference)<=epsilon?'NUMERIC_EQUAL':precision!==null&&Math.abs(difference)<precision?'COMPATIBLE_WITH_DISPLAY_PRECISION':'DIFFERENT_OBSERVATIONS',
      difference,display_text:raw??null,
      note:'Separate receipts may reflect rounding, live changes or provider caching; a difference is retained, not silently reconciled.'});
  }
  return comparisons;
}
function validatePng(base64){
  if(typeof base64!=='string'||base64.length>20*1024*1024||!/^[-A-Za-z0-9+/=]+$/.test(base64))throw Error('CHART_BYTES_INVALID');
  const bytes=Buffer.from(base64,'base64');
  if(bytes.length<33||bytes.toString('base64')!==base64||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.toString('ascii',12,16)!=='IHDR')throw Error('CHART_BYTES_INVALID');
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
  if(width<100||height<100||width>10000||height>10000||width*height>16*1024*1024)throw Error('CHART_DIMENSIONS_INVALID');
  const crc=data=>{let c=-1;for(const b of data){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^-1)>>>0;};
  let offset=8,header=false,ended=false,idatEnded=false;const compressed=[];
  while(offset<bytes.length){
    if(offset+12>bytes.length)throw Error('CHART_BYTES_INVALID');
    const size=bytes.readUInt32BE(offset),end=offset+12+size;
    if(end>bytes.length)throw Error('CHART_BYTES_INVALID');
    const type=bytes.toString('ascii',offset+4,offset+8),data=bytes.subarray(offset+8,end-4);
    if(crc(bytes.subarray(offset+4,end-4))!==bytes.readUInt32BE(end-4))throw Error('CHART_BYTES_INVALID');
    if(!header&&type!=='IHDR')throw Error('CHART_BYTES_INVALID');
    if(type==='IHDR'){if(header||size!==13)throw Error('CHART_BYTES_INVALID');header=true;}
    if(type==='IDAT'){if(idatEnded)throw Error('CHART_BYTES_INVALID');compressed.push(data);}
    else if(compressed.length)idatEnded=true;
    if(type==='IEND'){if(size!==0||end!==bytes.length)throw Error('CHART_BYTES_INVALID');ended=true;}
    offset=end;
  }
  if(!ended||!compressed.length||bytes[24]!==8||bytes[26]!==0||bytes[27]!==0||bytes[28]!==0)throw Error('CHART_BYTES_INVALID');
  const channels={0:1,2:3,4:2,6:4}[bytes[25]];
  if(!channels)throw Error('CHART_BYTES_INVALID');
  const stride=width*channels+1,expectedSize=stride*height;
  let pixels;try{pixels=require('node:zlib').inflateSync(Buffer.concat(compressed),{maxOutputLength:expectedSize});}catch{throw Error('CHART_BYTES_INVALID');}
  if(pixels.length!==expectedSize)throw Error('CHART_BYTES_INVALID');
  for(let row=0;row<height;row++)if(pixels[row*stride]>4)throw Error('CHART_BYTES_INVALID');
  return{bytes,width,height,sha256:sha(bytes)};
}
async function chartFromPage(page,expected,now){
  const labels=[];
  for(const frame of page.frames()){
    const proof=await frame.evaluate(()=>({
      labels:Array.from(document.querySelectorAll('[aria-label^="Chart for "]')).map(e=>e.getAttribute('aria-label')),
      canvases:Array.from(document.querySelectorAll('canvas')).filter(e=>e.width>0&&e.height>0).length,
      no_data:/No data here|Hope, it'll appear on the chart soon/.test(document.body?.innerText??'')
    })).catch(()=>null);
    if(proof?.labels.length)labels.push({...proof});
  }
  const prefix=`Chart for ${expected.chain==='solana'?'sol':expected.chain}/${expected.address}/`;
  const matches=labels.flatMap(p=>p.labels.map(label=>({...p,label}))).filter(p=>p.label.startsWith(prefix));
  if(matches.length!==1||!matches[0].canvases||matches[0].no_data)throw Error('EXACT_CHART_NOT_RENDERED');
  const containers=page.locator('[data-sentry-component="TradingView"]');
  if(await containers.count()!==1)throw Error('CHART_CONTAINER_NOT_UNIQUE');
  const png=await containers.screenshot({type:'png',timeout:10000}),checked=validatePng(png.toString('base64'));
  return{ok:true,coin_id:expected.coin_id,source_url:expected.url,captured_at:new Date(now()).toISOString(),
    rendered_label:matches[0].label,content_type:'image/png',sha256:checked.sha256,width:checked.width,height:checked.height,
    base64:png.toString('base64'),coverage:'Rendered chart image, not historical OHLC data or an executable quote.'};
}
async function collectTokenFromPage({page,coinId,now=()=>Date.now(),readData,readChart,networkCapture,prepareDepth}={}){
  const expected=coinIdentity(coinId),started=new Date(now()).toISOString();
  if(!page?.evaluate||!page?.url)throw Error('CALLER_OWNED_TOKEN_PAGE_REQUIRED');
  validatePageUrl(page.url(),expected);
  // Only the pure DOM extractor/finalizer is reused. No V1 page manager, scanner,
  // one-shot browser launcher or clicking developer-history helper is called.
  const parser=require('../../gmgn-token-page-scraper');
  const before=await page.evaluate(()=>Array.from(document.querySelectorAll('#token-base-address')).map(e=>e.getAttribute('data-addr')));
  if(before.length!==1)throw Error('TOKEN_HEADER_NOT_UNIQUE');
  const data=await (readData??parser.extractTokenPageData)(page,{chain:expected.chain});
  const token=explicitMissing(parser._internal.finalizeTokenPageData(data,{expectedIdentity:expected,sourceUrl:page.url(),scrapedAt:new Date(now()).toISOString()}));
  if((expected.chain==='robinhood'?before[0]?.toLowerCase():before[0])!==expected.address)throw Error('TOKEN_HEADER_IDENTITY_MISMATCH');
  if(prepareDepth&&!networkCapture)throw Error('TOKEN_NETWORK_CAPTURE_REQUIRED_FOR_DEPTH');
  const depthRequests=prepareDepth?await prepareDepth({page,coin:expected,creatorAddress:token.dev_wallet}):[];
  let chart;
  try{chart=await (readChart??chartFromPage)(page,expected,now);}
  catch(e){chart={ok:false,reason:'CHART_UNVERIFIED',coin_id:expected.coin_id,
    error_code:/^(?:EXACT_CHART_NOT_RENDERED|CHART_[A-Z_]+)$/.test(e.message)?e.message:'CHART_CAPTURE_UNAVAILABLE'};}
  const after=await page.evaluate(()=>Array.from(document.querySelectorAll('#token-base-address')).map(e=>e.getAttribute('data-addr')));
  validatePageUrl(page.url(),expected);
  if(after.length!==1||(expected.chain==='robinhood'?after[0]?.toLowerCase():after[0])!==expected.address)throw Error('TOKEN_CHANGED_DURING_CAPTURE');
  const network=networkCapture?await networkCapture():{observations:[],failures:[],status:'NOT_COLLECTED'};
  validatePageUrl(page.url(),expected);
  const body={schema:'alphahands.token-evidence.v2',coin_id:expected.coin_id,capture_started_at:started,collected_at:new Date(now()).toISOString(),
    source_url:expected.url,transport:'GMGN_PUBLIC_DOM',token,chart,network:explicitMissing({...network,depth_requests:depthRequests}),
    coverage:{summary:token.coverage,
      holder_wallet_list:network.observations.some(o=>o.route.kind==='holder_wallets')?'PARTIAL_OBSERVED_PAGE':'NOT_COLLECTED',kol_flows:'NOT_COLLECTED',
      developer_history:network.observations.some(o=>o.route.kind==='developer_history')?'PARTIAL_PROVIDER_SAMPLE':'NOT_COLLECTED',
      historical_candles:network.observations.some(o=>o.route.kind==='mcap_candles')?'OBSERVED_WINDOW_REQUIRES_VALIDATION':'NOT_COLLECTED',
      note:'Summary percentages and developer counts do not establish full wallet history, popular-KOL conviction or developer reputation.'}};
  return{id:hash(body),...body};
}
function tokenForPacket(evidence,sources=[],now=Date.now(),{allowHistorical=false}={}){
  const {id,...body}=evidence;
  if(body.schema!=='alphahands.token-evidence.v2'||hash(body)!==id)throw Error('TOKEN_EVIDENCE_INTEGRITY');
  const expected=coinIdentity(body.coin_id);validatePageUrl(body.source_url,expected);
  validatePageUrl(body.token.source_url,expected);
  if(body.token.coin_id!==expected.coin_id||body.token.chain!==expected.chain||body.token.address!==expected.address)throw Error('TOKEN_EVIDENCE_IDENTITY');
  const started=stamp(body.capture_started_at),completed=stamp(body.collected_at),dataAt=stamp(body.token.scraped_at);
  if(!Number.isFinite(started)||!Number.isFinite(completed)||started>completed||completed>now||
    !Number.isFinite(dataAt)||dataAt<started||dataAt>completed)throw Error('TOKEN_EVIDENCE_STALE_OR_INVALID_TIME');
  const captureAge=now-completed,fresh=captureAge<=MAX_CAPTURE_AGE_MS;
  if(!fresh&&!allowHistorical)throw Error('TOKEN_EVIDENCE_STALE_OR_INVALID_TIME');
  const missing=[],invalid=[];
  for(const field of CORE){const value=body.token[field];if(value===null||value===undefined)missing.push(field);else if(typeof value!=='number'||!Number.isFinite(value)||value<0)invalid.push(field);}
  if(invalid.length)throw Error('TOKEN_NUMERIC_FIELDS_INVALID:'+invalid.join(','));
  const native=expected.chain==='solana'?'SOL':'ETH';
  if(body.token.total_fees_native!==null&&body.token.total_fees_unit!==native)throw Error('TOKEN_NATIVE_FEE_UNIT_MISMATCH');
  const checkedSources=sources.filter(s=>s.schema==='alphahands.x-evidence.v2').map(s=>sourceForPacket(s,now));
  const network={observations:(body.network?.observations??[]).map(o=>observationForPacket(o,expected,now,body.token.dev_wallet)),
    failures:clone(body.network?.failures??[]),status:body.network?.status??'OBSERVED_PUBLIC_SAMPLE',
    depth_requests:clone(body.network?.depth_requests??[]),
    note:'Separate source observations, never silently merged into DOM values. Aggregate holder labels do not establish KOL conviction or actual wallet flows.'};
  network.dom_comparisons=compareDomFields(body.token,network.observations);
  network.holder_top20=network.observations.flatMap((o,index)=>{
    if(o.route.kind!=='holder_wallets')return[];
    const {rows,...summary}=o.depth.top20;
    return[{observation_id:o.id,coin_id:o.coin_id,...clone(summary),rows_ref:`/network/observations/${index}/depth/top20/rows`}];
  });
  const linked=Object.values(body.token.socials??{}).map(sourceLink).filter(s=>s.canonical_url);
  const linkedSources=checkedSources.filter(s=>s.request.kind==='x_link'&&linked.some(l=>sameXSource(l,s.exact_source)||
    (l.type==='PROFILE'&&s.exact_source?.type==='STATUS'&&l.author.toLowerCase()===s.exact_source.author?.toLowerCase())));
  const reasons=missing.map(f=>'MISSING:'+f);
  if(!fresh)reasons.push('STALE_TOKEN_SNAPSHOT_REQUIRES_REFRESH');
  if(!linkedSources.some(s=>s.qualified))reasons.push('LINKED_X_UNVERIFIED');
  let chart=clone(body.chart),images=[];
  if(chart.ok){
    const png=validatePng(chart.base64),at=stamp(chart.captured_at);
    const prefix=`Chart for ${expected.chain==='solana'?'sol':expected.chain}/${expected.address}/`;
    if(chart.coin_id!==expected.coin_id||chart.source_url!==expected.url||!chart.rendered_label?.startsWith(prefix)||
      png.sha256!==chart.sha256||png.width!==chart.width||png.height!==chart.height||!Number.isFinite(at)||at<started||at>completed)throw Error('CHART_IDENTITY_OR_INTEGRITY');
    delete chart.base64;
    chart.delivery='IMAGE_ATTACHMENT_REQUIRED';
    images=[{coin_id:expected.coin_id,sha256:png.sha256,content_type:'image/png',base64:body.chart.base64}];
  }else reasons.push('CHART_UNVERIFIED');
  return{packet:{evidence_id:id,coin_id:expected.coin_id,source_url:expected.url,capture_started_at:body.capture_started_at,collected_at:body.collected_at,
    capture_age_ms:captureAge,freshness_status:fresh?'FRESH':'HISTORICAL_REQUIRES_REFRESH',
    token:clone(body.token),coverage:{...clone(body.coverage),holder_top20:network.holder_top20.some(h=>h.qualified)?'QUALIFIED_OBSERVED_TOP20':network.holder_top20.length?'UNVERIFIED_TOP20':'NOT_COLLECTED'},network,chart,source_ids:linkedSources.map(s=>s.id),
    research_ready:reasons.length===0,readiness_scope:'CORE_MARKET_CHART_LINKED_X_REVIEW',deep_research_complete:false,
    reasons,execution_qualified:false},images,sources:checkedSources};
}
module.exports={collectTokenFromPage,tokenForPacket,chartFromPage,coinIdentity,validatePng,compareDomFields};
