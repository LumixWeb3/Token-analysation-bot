'use strict';

// Public source validation only. No browser, service, authentication or model startup.
const {sourceLink}=require('../market/gmgn');
const {hash}=require('../market/network-feed');
const MAX_CAPTURE_AGE_MS=5*60*1000, CURRENT_POST_AGE_MS=10*24*60*60*1000;
const clone=value=>JSON.parse(JSON.stringify(value));
const BODY_FIELDS=['schema','request','capture_started_at','collected_at','transport','source_page_url','exact_source','source_identity_qualified','source_error','unchecked_count','raw'];
function stamp(value){
  if(typeof value!=='string')return NaN;
  const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if(!m)return NaN;
  const [,year,month,day,hour,minute,second,,offsetHour,offsetMinute]=m;
  const days=new Date(Date.UTC(Number(year),Number(month),0)).getUTCDate();
  if(+month<1||+month>12||+day<1||+day>days||+hour>23||+minute>59||+second>59||+(offsetHour??0)>23||+(offsetMinute??0)>59)return NaN;
  return Date.parse(value);
}
function sameXSource(a,b){
  if(!a?.canonical_url||!b?.canonical_url||a.type!==b.type)return false;
  if(a.type==='PROFILE')return a.author?.toLowerCase()===b.author?.toLowerCase();
  if(a.type==='STATUS')return a.post_id===b.post_id&&(a.author??'').toLowerCase()===(b.author??'').toLowerCase();
  return a.canonical_url===b.canonical_url;
}
function sourceIdentity({request,raw,transport,source_page_url}){
  const expected=request.kind==='x_link'?sourceLink(request.input):null;
  let error=null;
  if(request.kind==='browser')error='BROWSER_TOOL_NOT_CONNECTED';
  else if(!['LOCAL_X_API','BROWSER_DOM'].includes(transport))error='X_TRANSPORT_UNVERIFIED';
  else if(raw?.ok!==true)error='X_SOURCE_UNAVAILABLE';
  else if(request.kind==='x_link'&&!expected.canonical_url)error='UNSUPPORTED_X_SOURCE';
  else if(!['x_link','x_search'].includes(request.kind))error='UNSUPPORTED_X_REQUEST';
  else if(request.kind==='x_search'&&raw.query!==request.input)error='SEARCH_QUERY_MISMATCH';
  else if(expected?.type==='COMMUNITY'&&String(raw.community_id??raw.info?.id??'')!==/\d+$/.exec(expected.canonical_url)?.[0])error='COMMUNITY_ID_MISMATCH';
  if(transport==='BROWSER_DOM'){
    if(expected&&!sameXSource(sourceLink(source_page_url),expected))error='BROWSER_SOURCE_PAGE_MISMATCH';
    if(request.kind==='x_search'){
      let u;try{u=new URL(source_page_url);}catch{}
      if(!u||u.protocol!=='https:'||u.username||u.password||!['x.com','twitter.com'].includes(u.hostname)||u.pathname!=='/search'||u.searchParams.get('q')!==request.input)error='BROWSER_SEARCH_PAGE_MISMATCH';
    }
  }
  return{expected,error};
}
function checkPost(post,expected,now){
  const reasons=[],id=typeof post?.id==='string'?post.id:null,handle=post?.author?.handle;
  if(!id||!/^\d+$/.test(id))reasons.push('POST_ID_INVALID');
  if(typeof handle!=='string'||!/^[A-Za-z0-9_]{1,15}$/.test(handle))reasons.push('AUTHOR_INVALID');
  if(typeof post?.text!=='string'||!post.text.trim())reasons.push('TEXT_EMPTY');
  if(post?.text_complete===false)reasons.push('POST_TEXT_COLLAPSED');
  const date=stamp(post?.date);
  if(!Number.isFinite(date))reasons.push('POST_TIME_UNVERIFIED');
  else if(date>now)reasons.push('POST_TIME_FUTURE');
  if(expected?.type==='STATUS'&&id!==expected.post_id)reasons.push('POST_ID_MISMATCH');
  if(expected?.author&&handle?.toLowerCase()!==expected.author.toLowerCase())reasons.push('AUTHOR_MISMATCH');
  const permalink=id&&handle?`https://x.com/${handle}/status/${id}`:null;
  if(post?.url!==undefined&&post.url!==null){
    const link=sourceLink(post.url);
    if(link.type!=='STATUS'||link.post_id!==id||link.author?.toLowerCase()!==handle?.toLowerCase())reasons.push('PERMALINK_MISMATCH');
  }
  return{qualified:reasons.length===0,reasons,permalink,post_age_ms:Number.isFinite(date)?now-date:null,
    recency:reasons.length?'UNVERIFIED':now-date>CURRENT_POST_AGE_MS?'ARCHIVAL':'CURRENT'};
}
function assessSource(source,now=Date.now()){
  const body=Object.fromEntries(BODY_FIELDS.map(k=>[k,source[k]]));
  if(hash(body)!==source.id)throw Error('X_EVIDENCE_HASH_MISMATCH');
  const identity=sourceIdentity(source);
  if(hash(identity.expected)!==hash(source.exact_source)||source.source_identity_qualified!==(identity.error===null)||source.source_error!==identity.error)throw Error('X_EVIDENCE_SOURCE_IDENTITY');
  const started=stamp(source.capture_started_at),completed=stamp(source.collected_at);
  const timeValid=Number.isFinite(started)&&Number.isFinite(completed)&&started<=completed&&completed<=now;
  const captureFresh=timeValid&&now-completed<=MAX_CAPTURE_AGE_MS;
  const observed=source.raw?.tweets??(source.raw?.tweet?[source.raw.tweet]:source.raw?.posts??[]);
  const posts=Array.isArray(observed)?observed:[];
  const checks=posts.map((p,index)=>({index,...checkPost(p,source.exact_source,now)}));
  const qualified_count=checks.filter(p=>p.qualified).length,current_count=checks.filter(p=>p.qualified&&p.recency==='CURRENT').length;
  const qualified=source.source_identity_qualified&&captureFresh&&qualified_count>0;
  return{qualified,status:!qualified?'UNVERIFIED':current_count?'QUALIFIED_SAMPLE':'QUALIFIED_ARCHIVAL_SAMPLE',
    reason:!timeValid?'CAPTURE_TIME_INVALID':!captureFresh?'CAPTURE_STALE':!source.source_identity_qualified?source.source_error:!qualified_count?'NO_QUALIFIED_POSTS':null,
    checked_count:posts.length,qualified_count,unverified_count:posts.length-qualified_count,current_count,
    archival_count:qualified_count-current_count,unchecked_count:source.unchecked_count,
    post_checks:checks,capture_age_ms:timeValid?now-completed:null,
    note:'An exact-source sample, not total X demand, token ownership or proof of profit. ARCHIVAL posts describe history, not current attention. Unknown engagement stays null.'};
}
function buildXSource({request,raw,capture_started_at,collected_at,transport='LOCAL_X_API',source_page_url=null,unchecked_count=null}){
  const retainedRaw=raw?.ok===true?clone(raw):null;
  const {expected,error}=sourceIdentity({request,raw:retainedRaw,transport,source_page_url});
  const body={schema:'alphahands.x-evidence.v2',request:clone(request),capture_started_at,collected_at,transport,source_page_url,
    exact_source:expected,source_identity_qualified:error===null,source_error:error,
    unchecked_count:Number.isInteger(unchecked_count)&&unchecked_count>=0?unchecked_count:null,raw:retainedRaw};
  const source={id:hash(body),...body};return sourceForPacket(source,stamp(collected_at));
}
function sourceForPacket(source,now=Date.now()){
  if(source.schema!=='alphahands.x-evidence.v2')throw Error('X_EVIDENCE_SCHEMA_UNSUPPORTED');
  return{id:source.id,...clone(Object.fromEntries(BODY_FIELDS.map(k=>[k,source[k]]))),...assessSource(source,now)};
}
module.exports={buildXSource,assessSource,sourceForPacket,checkPost,stamp,sameXSource,MAX_CAPTURE_AGE_MS};
