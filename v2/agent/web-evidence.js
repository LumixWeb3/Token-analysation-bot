'use strict';

// Data-only public-web receipts. This module performs no navigation or DNS lookup.
const {isIP}=require('node:net');
const {hash}=require('../market/network-feed');
const {stamp,MAX_CAPTURE_AGE_MS}=require('./x-evidence');
const SCHEMA='alphahands.web-evidence.v1',MAX_BYTES=1024*1024;
const FIELDS=['schema','request','transport','capture_started_at','collected_at','source_observed_at',
  'requested_url','final_url','redirect_chain','blocks','results','coverage','error','origin'];
const clone=value=>JSON.parse(JSON.stringify(value));
function exact(value,keys,label){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...keys].sort().join(','))throw Error('WEB_EVIDENCE_SHAPE:'+label);
}
function string(value,label,limit=100000){
  if(typeof value!=='string'||value.length>limit)throw Error('WEB_EVIDENCE_TEXT:'+label);
}
function publicHttpsUrl(value){
  string(value,'url',8192);let url;try{url=new URL(value);}catch{throw Error('WEB_URL_NOT_PUBLIC_HTTPS');}
  const host=url.hostname.toLowerCase().replace(/\.$/,'');
  if(url.protocol!=='https:'||url.username||url.password||url.port||!host.includes('.')||
    isIP(host)||host.includes(':')||/^[\d.]+$/.test(host)||
    /(?:^|\.)(?:localhost|local|internal|lan|home|invalid|test|onion)$/.test(host))throw Error('WEB_URL_NOT_PUBLIC_HTTPS');
  // Receipts must not retain authentication-bearing navigation URLs.
  for(const key of url.searchParams.keys())if(/^(?:access_token|auth|authorization|api_key|apikey|password|passwd|cookie|session|sessionid|secret|token)$/i.test(key))throw Error('WEB_URL_CREDENTIAL_QUERY');
  return url.href;
}
function validate(body){
  exact(body,FIELDS,'body');
  if(body.schema!==SCHEMA)throw Error('WEB_EVIDENCE_SCHEMA_UNSUPPORTED');
  exact(body.request,['kind','input','reason'],'request');
  const page=body.request.kind==='web_page',search=body.request.kind==='web_search';
  if(!page&&!search)throw Error('WEB_EVIDENCE_REQUEST_KIND');
  string(body.request.input,'input',8192);string(body.request.reason,'reason',10000);
  if(!body.request.input.trim()||!body.request.reason.trim())throw Error('WEB_EVIDENCE_REQUEST_EMPTY');
  if((page&&body.transport!=='PLAYWRIGHT_DOM')||(search&&body.transport!=='CODEX_NATIVE_WEB_SEARCH'))throw Error('WEB_EVIDENCE_TRANSPORT');
  if(body.source_observed_at!==null&&!Number.isFinite(stamp(body.source_observed_at)))throw Error('WEB_EVIDENCE_OBSERVED_TIME');
  if(!Array.isArray(body.blocks)||!Array.isArray(body.results)||!Array.isArray(body.redirect_chain))throw Error('WEB_EVIDENCE_CONTENT_SHAPE');
  if(body.blocks.length>10000||body.results.length>1000||body.redirect_chain.length>20)throw Error('WEB_EVIDENCE_CONTENT_LIMIT');
  exact(body.coverage,['scope','status','bounded','omitted_count','note'],'coverage');
  const coverage=body.coverage;
  string(coverage.note,'coverage.note',10000);
  if(typeof coverage.bounded!=='boolean'||(coverage.omitted_count!==null&&(!Number.isSafeInteger(coverage.omitted_count)||coverage.omitted_count<0)))throw Error('WEB_EVIDENCE_COVERAGE');
  if(body.error!==null&&!/^[A-Z][A-Z0-9_]{1,100}$/.test(body.error))throw Error('WEB_EVIDENCE_ERROR_CODE');
  // Native search receipts need their original event identity, not an invented URL.
  exact(body.origin,['thread_id','item_id'],'origin');
  for(const key of ['thread_id','item_id'])if(body.origin[key]!==null){string(body.origin[key],'origin.'+key,1000);if(!body.origin[key].trim())throw Error('WEB_EVIDENCE_ORIGIN');}
  if(page){
    if(publicHttpsUrl(body.request.input)!==publicHttpsUrl(body.requested_url))throw Error('WEB_EVIDENCE_REQUEST_URL_MISMATCH');
    if(body.final_url!==null)publicHttpsUrl(body.final_url);
    for(const url of body.redirect_chain)publicHttpsUrl(url);
    const requested=publicHttpsUrl(body.requested_url),final=body.final_url&&publicHttpsUrl(body.final_url);
    if(final&&requested!==final&&(body.redirect_chain.length<2||publicHttpsUrl(body.redirect_chain[0])!==requested||publicHttpsUrl(body.redirect_chain.at(-1))!==final))throw Error('WEB_EVIDENCE_REDIRECT_PROOF_REQUIRED');
    if(body.results.length||coverage.scope!=='VISIBLE_DOM'||!['COMPLETE_VISIBLE_CAPTURE','PARTIAL_BOUNDED','UNAVAILABLE'].includes(coverage.status))throw Error('WEB_EVIDENCE_PAGE_COVERAGE');
    if(coverage.status==='COMPLETE_VISIBLE_CAPTURE'&&(coverage.bounded||coverage.omitted_count!==0))throw Error('WEB_EVIDENCE_FALSE_COMPLETE');
    if(coverage.status==='PARTIAL_BOUNDED'&&!coverage.bounded)throw Error('WEB_EVIDENCE_FALSE_COMPLETE');
    for(const block of body.blocks){
      exact(block,['type','text','url'],'block');string(block.text,'block.text');
      if(!['paragraph','heading','list_item','link','image_caption'].includes(block.type))throw Error('WEB_EVIDENCE_BLOCK_TYPE');
      if(block.url!==null)publicHttpsUrl(block.url);
      if(block.type==='link'&&block.url===null)throw Error('WEB_EVIDENCE_LINK_URL');
    }
  }else{
    if(body.requested_url!==null||body.final_url!==null||body.redirect_chain.length||body.blocks.length||coverage.scope!=='SEARCH_RESULTS'||!['SNIPPETS_ONLY','UNAVAILABLE'].includes(coverage.status)||!coverage.bounded)throw Error('WEB_EVIDENCE_SEARCH_COVERAGE');
    if(!body.origin.item_id)throw Error('WEB_EVIDENCE_SEARCH_EVENT_REQUIRED');
    for(const result of body.results){
      exact(result,['url','title','snippet','published_at'],'result');publicHttpsUrl(result.url);string(result.title,'result.title',10000);
      if(result.snippet!==null)string(result.snippet,'result.snippet');
      if(result.published_at!==null&&!Number.isFinite(stamp(result.published_at)))throw Error('WEB_EVIDENCE_PUBLICATION_TIME');
    }
  }
  if(coverage.status==='UNAVAILABLE'&&(body.error===null||body.blocks.length||body.results.length))throw Error('WEB_EVIDENCE_UNAVAILABLE_CONTENT');
  if(body.error!==null&&coverage.status!=='UNAVAILABLE')throw Error('WEB_EVIDENCE_ERROR_COVERAGE');
  if(Buffer.byteLength(JSON.stringify(body))>MAX_BYTES)throw Error('WEB_EVIDENCE_SIZE_LIMIT');
}
function webSourceForPacket(source,now=Date.now()){
  if(!source||typeof source!=='object')throw Error('WEB_EVIDENCE_SHAPE:source');
  const body=Object.fromEntries(FIELDS.map(key=>[key,source[key]]));
  if(hash(body)!==source.id)throw Error('WEB_EVIDENCE_HASH_MISMATCH');
  validate(body);
  const started=stamp(body.capture_started_at),collected=stamp(body.collected_at),observed=body.source_observed_at===null?null:stamp(body.source_observed_at);
  const timeValid=Number.isFinite(now)&&Number.isFinite(started)&&Number.isFinite(collected)&&started<=collected&&collected<=now&&
    (observed===null||observed<=collected);
  const fresh=timeValid&&now-collected<=MAX_CAPTURE_AGE_MS;
  const page=body.request.kind==='web_page',count=page?body.blocks.filter(b=>b.text.trim()).length:body.results.length;
  const qualified=fresh&&!body.error&&count>0&&(!page||body.final_url!==null);
  const reason=!timeValid?'CAPTURE_TIME_INVALID':!fresh?'CAPTURE_STALE':body.error??(!count?'NO_CONTENT_OBSERVED':page&&!body.final_url?'FINAL_URL_UNVERIFIED':null);
  return{id:source.id,...clone(body),qualified,status:qualified?(page?'QUALIFIED_VISIBLE_PAGE_CAPTURE':'QUALIFIED_SEARCH_SNIPPETS'):'UNVERIFIED',reason,
    capture_age_ms:timeValid?now-collected:null,content_count:count,source_time_known:observed!==null,
    trust:'UNTRUSTED_SOURCE_CONTENT',execution_qualified:false,x_identity_qualified:false,
    note:'Capture freshness is not publication freshness. Visible DOM excludes unseen content; search snippets do not prove page contents, token association, adoption or absent demand.'};
}
function buildWebSource({request,transport,capture_started_at,collected_at,source_observed_at=null,requested_url=null,final_url=null,
  redirect_chain=[],blocks=[],results=[],coverage,error=null,origin={thread_id:null,item_id:null}}={}){
  const body=clone({schema:SCHEMA,request,transport,capture_started_at,collected_at,source_observed_at,requested_url,final_url,redirect_chain,blocks,results,coverage,error,origin});
  validate(body);return webSourceForPacket({id:hash(body),...body},stamp(collected_at));
}
module.exports={SCHEMA,MAX_BYTES,publicHttpsUrl,buildWebSource,webSourceForPacket};
