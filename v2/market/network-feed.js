'use strict';

// Pure source adapter. No browser, requests, model, V1 state or account imports.
const crypto = require('node:crypto');
const { identity, sourceLink } = require('./gmgn');
const CHAINS = { sol: 'solana', robinhood: 'robinhood' };
const PATHS = Object.freeze({ migrated:'/trs/api/v1/trenches_rank', trending:'/rrs/api/v1/trending_multichain' });
const CHANNELS = Object.freeze({ migrated:'trenches_delta', trending:'trending_multichain_update' });
const {loadOwnerFilters}=require('./filter-config');
const {loadOwnerMigratedFilters}=require('./migrated-filter-config');
const SCOPE = {migrated:loadOwnerMigratedFilters().request,trending:loadOwnerFilters().request};
const clone = x => JSON.parse(JSON.stringify(x));
function canonical(x) {
  if (Array.isArray(x)) return '[' + x.map(canonical).join(',') + ']';
  if (x && typeof x === 'object') return '{' + Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',') + '}';
  return JSON.stringify(x);
}
const hash = x => crypto.createHash('sha256').update(canonical(x)).digest('hex');
function time(x) { const t=typeof x==='string'?Date.parse(x):NaN; if(!Number.isFinite(t))throw Error('INVALID_RECEIPT_TIME');return t; }
function version(x) { if(typeof x!=='string'||!/^[A-Fa-f0-9]{1,32}$/.test(x))throw Error('INVALID_SOURCE_VERSION');return BigInt('0x'+x); }
function id(chain,address) { if(!CHAINS[chain])throw Error('UNSUPPORTED_CHAIN');return identity(`/${chain}/token/${address}`); }
function number(raw,unit) {
  if(raw===null||raw===undefined||raw==='')return {value:null,raw:raw??null,state:'MISSING',unit};
  if(typeof raw!=='number'||!Number.isFinite(raw)||raw<0||(unit==='count'&&!Number.isSafeInteger(raw)))return {value:null,raw,state:'INVALID',unit};
  return {value:raw,raw,state:'SOURCE_OBSERVED',unit};
}
function fieldProvenance(raw,feed,reference,previous,updatedFields){
  const keys=['a',feed==='migrated'?'n':'c','s','nm','l','mc','lq','hd','m_x','ct','ot','p',
    ...(feed==='migrated'?['v24h','sw24h','b24h','s24h','f_tt']:['v','sw','bu','se','gf'])];
  const observations=[],fields={},indexes=new Map();
  for(const key of keys){
    if(!Object.hasOwn(raw,key))continue;
    const old=previous?.field_provenance;
    const source=previous&&!updatedFields.has(key)?old?.observations[old.fields[key]]:reference;
    // Historical values without their original field proof remain unverified;
    // never stamp them with the receipt time of an unrelated partial update.
    if(!source)continue;
    const fingerprint=hash(source);
    if(!indexes.has(fingerprint)){indexes.set(fingerprint,observations.length);observations.push(clone(source));}
    fields[key]=indexes.get(fingerprint);
  }
  return{fields,observations,note:'Raw-field keys reference their own collection evidence; a row patch does not refresh unchanged fields. Provider update time remains unknown.'};
}
function normalizeToken(raw,chain,feed,receivedAt,reference,{previous=null,updatedFields=new Set()}={}) {
  const tokenId=id(chain,raw.a);
  const declared=feed==='migrated'?raw.n:raw.c;
  if(declared!==chain||(raw.c!==undefined&&raw.c!==chain))throw Error('TOKEN_CHAIN_MISMATCH');
  const symbol=typeof raw.s==='string'&&raw.s.trim()?raw.s:null;
  const name=typeof raw.nm==='string'&&raw.nm.trim()?raw.nm:null;
  const rawLink=raw.m_x;
  let url=rawLink;
  if(typeof rawLink==='string'&&rawLink&&!/^https:\/\//i.test(rawLink)) url=/^(?:www\.)?(?:x|twitter)\.com\//i.test(rawLink)?'https://'+rawLink:'https://x.com/'+rawLink.replace(/^@/,'');
  const links=rawLink?[{...sourceLink(url),raw:rawLink,provided_url:url,source_field:'m_x',narrative_status:'NOT_FETCHED'}]:[];
  const metrics={ market_cap_usd:number(raw.mc,'USD'),liquidity_usd:number(raw.lq,'USD'),
    volume_usd:{...number(feed==='migrated'?raw.v24h:raw.v,'USD'),window:'24h'},
    holders:number(raw.hd,'count'),transactions:number(feed==='migrated'?raw.sw24h:raw.sw,'count'),
    buys:number(feed==='migrated'?raw.b24h:raw.bu,'count'),sells:number(feed==='migrated'?raw.s24h:raw.se,'count') };
  const fee=number(feed==='migrated'?raw.f_tt:raw.gf,chain==='sol'?'SOL':'ETH');
  const problems=Object.entries(metrics).filter(([,m])=>m.state==='INVALID').map(([k])=>'INVALID:'+k);
  if(fee.state==='INVALID')problems.push('INVALID:native_fees');
  if(problems.length)throw Error(problems.join(','));
  const missing=[...(!symbol?['symbol']:[]),...(!name?['name']:[]),...(metrics.market_cap_usd.state==='MISSING'?['market_cap_usd']:[])];
  return {...tokenId,feed,symbol,name,missing,logo_url:typeof raw.l==='string'?raw.l:null,
    metrics,native_fees:{...fee,source_field:feed==='migrated'?'f_tt':'gf',provider_label:'Total Fees',
      coverage:'PROVIDER_AGGREGATE_METHOD_UNVERIFIED',note:'Reported fees are not trading volume or invested capital; no rug verdict follows from this field alone.'},source_links:links,
    created_at:Number.isFinite(raw.ct)&&raw.ct>0?new Date(raw.ct*1000).toISOString():null,
    opened_at:Number.isFinite(raw.ot)&&raw.ot>0?new Date(raw.ot*1000).toISOString():null,
    observed_at:previous&&Date.parse(previous.observed_at)>Date.parse(receivedAt)?previous.observed_at:receivedAt,upstream_updated_at:null,evidence_ref:reference,
    observation_kind:previous?(Date.parse(receivedAt)<Date.parse(previous.observed_at)?'REPLAYED_PARTIAL_PATCH':'PARTIAL_PATCH'):'SNAPSHOT_OR_NEW_MEMBERSHIP',
    field_provenance:fieldProvenance(raw,feed,reference,previous,updatedFields),
    // A public feed price is not a qualified executable quote.
    indicative_price:{...number(raw.p,'USD'),execution_qualified:false},
    source_quality:'NETWORK_OBSERVED',raw:clone(raw)};
}
function trendingRequest() {
  return clone(SCOPE.trending);
}
function validateRequest(feed,request,expectedScopes=SCOPE) {
  if(!request||!Array.isArray(request.params)||!request.params.length)throw Error('REQUEST_SCOPE_MISSING');
  if(request.params.some(p=>!CHAINS[p.chain])||new Set(request.params.map(p=>p.chain)).size!==request.params.length)throw Error('REQUEST_CHAIN_SCOPE');
  if(feed==='trending'&&canonical(request)!==canonical(expectedScopes.trending))throw Error('TRENDING_SCOPE_MISMATCH');
  if(feed==='migrated')for(const p of request.params){
    if(!p.completed||!Number.isInteger(p.completed.limit)||p.completed.limit<1||p.completed.limit>500)throw Error('MIGRATED_SCOPE_MISSING');
    if(p.new_creation||p.near_completion)throw Error('OUT_OF_SCOPE_LANE_REQUEST');
    if(canonical(p)!==canonical(SCOPE.migrated.params.find(q=>q.chain===p.chain)))throw Error('MIGRATED_SCOPE_MISMATCH');
  }
}

class FeedBook {
  #expectedScopes;
  #replays={migrated:{entries:[],bytes:0,complete:true,floors:new Map()},trending:{entries:[],bytes:0,complete:true,floors:new Map()}};
  constructor({now=()=>Date.now(),maxSnapshotAgeMs=60000,maxTransportAgeMs=20000,maxReplayBytes=8*1024*1024,maxReplayFrames=2048,expectedScopes=SCOPE}={}) {
    // Authority is supplied by the host at construction, never by an arriving
    // response or its filter metadata. Keep an isolated copy through rebases.
    if(!expectedScopes||typeof expectedScopes!=='object'||Object.keys(expectedScopes).some(k=>!['migrated','trending'].includes(k)))throw Error('EXPECTED_SCOPE_INVALID');
    const candidate=clone({...SCOPE,...expectedScopes});
    if(canonical(candidate.migrated)!==canonical(SCOPE.migrated))throw Error('MIGRATED_SCOPE_OVERRIDE_FORBIDDEN');
    require('./trending-controller').validateTrendingRequest(candidate.trending);
    this.#expectedScopes=candidate;
    if(!Number.isInteger(maxReplayBytes)||maxReplayBytes<1||maxReplayBytes>8*1024*1024||!Number.isInteger(maxReplayFrames)||maxReplayFrames<1||maxReplayFrames>2048)throw Error('INVALID_REPLAY_BOUND');
    this.now=now;this.maxSnapshotAgeMs=maxSnapshotAgeMs;this.maxTransportAgeMs=maxTransportAgeMs;
    this.maxReplayBytes=maxReplayBytes;this.maxReplayFrames=maxReplayFrames;
    this.groups=new Map();this.connections={migrated:false,trending:false};this.faults={};this.sequence=0;
  }
  #breakReplay(feed,envelope=null){
    const history=this.#replays[feed];
    if(!history)return;
    history.entries=[];history.bytes=0;history.complete=false;
    if(envelope?.channel!==CHANNELS[feed])return;
    for(const message of Array.isArray(envelope.data)?envelope.data:[envelope.data]){
      if(!message||![...this.groups.values()].some(g=>g.feed===feed&&g.filter_id===message.fid))continue;
      try{const cursor=version(message.v),old=history.floors.get(message.fid);if(old===undefined||cursor>old)history.floors.set(message.fid,cursor);}catch{}
    }
  }
  connection(feed,connected){if(!(feed in CHANNELS))throw Error('UNKNOWN_FEED');this.connections[feed]=connected===true;if(!connected){this.faults[feed]='DISCONNECTED_REBASE_REQUIRED';this.#breakReplay(feed);}}
  fault(feed,reason){this.faults[feed]=reason;}
  snapshot(feed,body,request,receivedAt=new Date(this.now()).toISOString()) {
    try {
      validateRequest(feed,request,this.#expectedScopes);const receipt=time(receivedAt);
      if(receipt>this.now()+1000)throw Error('FUTURE_RECEIPT');
      if(body?.code!==0||!Array.isArray(body.data))throw Error('INVALID_SNAPSHOT_ENVELOPE');
      if(body.data.length!==request.params.length)throw Error('INCOMPLETE_CHAIN_RESPONSE');
      const staged=[],seen=new Set();let behind=false;
      for(const group of body.data){
        const p=request.params.find(p=>p.chain===group.chain);if(!p||seen.has(group.chain))throw Error('UNEXPECTED_CHAIN_RESPONSE');seen.add(group.chain);
        if(feed==='trending'&&group.interval!=='24h')throw Error('WRONG_WINDOW');
        const value=feed==='migrated'?group.completed:group;
        const filter=p[feed==='migrated'?'completed':'filter'];
        if(typeof value?.filter_id!=='string'||!value.filter_id.startsWith(group.chain+(feed==='migrated'?'_cp_':'_tm24h_')))throw Error('FILTER_ID_SCOPE_MISMATCH');
        version(value.version);
        const floor=this.#replays[feed].floors.get(value.filter_id);
        if(floor!==undefined&&version(value.version)<floor)throw Error('SNAPSHOT_BEFORE_FAILED_DELTA');
        const previous=this.groups.get(`${feed}:${group.chain}`);
        if(previous&&receipt<time(previous.snapshot_at))throw Error('OLD_SNAPSHOT');
        if(previous?.filter_id===value.filter_id&&version(value.version)<version(previous.version)){
          // GMGN HTTP snapshots can be cached behind the live cursor. Rebase
          // only when our complete, bounded stream history bridges the gap.
          if(!this.connections[feed]||!this.#replays[feed].complete||version(value.version)<version(previous.baseline_version))throw Error('SNAPSHOT_VERSION_REGRESSION_UNBRIDGED');
          behind=true;
        }
        if(!Array.isArray(value.tokens)||value.tokens.length>filter.limit)throw Error('INVALID_COHORT_SIZE');
        const reference={sha256:hash(body),request_sha256:hash(request),source:PATHS[feed],received_at:receivedAt};
        const tokens=new Map();for(const raw of value.tokens){const row=normalizeToken(raw,group.chain,feed,receivedAt,reference);if(tokens.has(row.address))throw Error('DUPLICATE_TOKEN');tokens.set(row.address,row);}
        staged.push({feed,chain:group.chain,filter_id:value.filter_id,version:value.version,baseline_version:value.version,
          filter:clone(filter),request_sha256:hash(request),snapshot_at:receivedAt,last_message_at:receivedAt,
          snapshot_ref:reference,tokens,events:0,added:[...tokens.keys()].filter(a=>!previous?.tokens.has(a)),
          removed:previous?[...previous.tokens.keys()].filter(a=>!tokens.has(a)):[],cohort_limit:filter.limit,
          completeness:'COMPLETE_RETURNED_RANK_COHORT',upstream_updated_at:null});
      }
      const history=this.#replays[feed];
      const candidate=new FeedBook({now:this.now,maxSnapshotAgeMs:this.maxSnapshotAgeMs,maxTransportAgeMs:this.maxTransportAgeMs,expectedScopes:this.#expectedScopes});
      for(const g of staged)candidate.groups.set(`${feed}:${g.chain}`,g);
      let replayed=0;
      if(history.complete)for(const event of history.entries){
        const result=candidate.#applyDelta(feed,event.envelope,event.received_at,true);
        if(!result.accepted)throw Error('SNAPSHOT_REPLAY_FAILED:'+result.reason);
        replayed+=result.applied;
      }
      for(const g of candidate.groups.values())this.groups.set(`${feed}:${g.chain}`,g);
      // Retain only fragments at/after the new baseline. Equal-cursor fragments
      // remain relevant because several valid updates can share one cursor.
      history.entries=history.entries.filter(event=>(Array.isArray(event.envelope.data)?event.envelope.data:[event.envelope.data]).some(m=>{
        const g=[...candidate.groups.values()].find(g=>g.filter_id===m.fid);
        return g&&version(m.v)>=version(g.baseline_version);
      }));
      history.bytes=history.entries.reduce((n,e)=>n+e.bytes,0);history.complete=true;history.floors.clear();
      delete this.faults[feed];this.sequence++;return {accepted:true,groups:staged.length,replayed,cached_snapshot_reconciled:behind};
    }catch(e){this.fault(feed,e.message);return {accepted:false,reason:e.message};}
  }
  delta(feed,envelope,receivedAt=new Date(this.now()).toISOString()) {
    const result=this.#applyDelta(feed,envelope,receivedAt,false);
    if(!result.accepted)this.#breakReplay(feed,envelope);
    const history=this.#replays[feed];
    if(result.accepted&&result.applied>0&&history?.complete){
      const serialized=JSON.stringify(envelope),bytes=Buffer.byteLength(serialized);
      if(history.entries.length>=this.maxReplayFrames||history.bytes+bytes>this.maxReplayBytes){history.entries=[];history.bytes=0;history.complete=false;}
      else{history.entries.push({envelope:JSON.parse(serialized),received_at:receivedAt,bytes});history.bytes+=bytes;}
    }
    return result;
  }
  #applyDelta(feed,envelope,receivedAt,replay) {
    try {
      if(envelope?.type==='error')throw Error(envelope.code==='version_too_old'?'VERSION_TOO_OLD':'SOURCE_ERROR');
      if(envelope?.channel!==CHANNELS[feed])throw Error('WRONG_CHANNEL');
      const messages=Array.isArray(envelope.data)?envelope.data:[envelope.data];
      const staged=new Map();let ignored=0;
      for(const message of messages){
        if(!message||typeof message.fid!=='string')throw Error('INVALID_DELTA');
        const original=[...this.groups.values()].find(g=>g.feed===feed&&g.filter_id===message.fid);
        const g=original&&(staged.get(`${feed}:${original.chain}`)??original);
        if(!g){ignored++;continue;} // Other lanes/filter subscriptions never enter this book.
        const receipt=time(receivedAt);if(receipt>this.now()+1000||(!replay&&receipt<time(g.last_message_at)))throw Error('INVALID_DELTA_RECEIPT');
        const cursor=version(message.v);if(cursor<version(g.version)){ignored++;continue;}
        if(Object.keys(message).some(k=>!['fid','v','src','a','r','t','chain'].includes(k)))throw Error('UNKNOWN_DELTA_OPERATION');
        if(message.chain!==undefined&&message.chain!==g.chain)throw Error('DELTA_CHAIN_MISMATCH');
        if(message.src!==undefined&&!['full','partial','ws','calibration'].includes(message.src))throw Error('UNKNOWN_DELTA_SOURCE');
        const additions=message.a??[],removals=message.r??[],deltas=message.t??[];
        if(!Array.isArray(additions)||!Array.isArray(removals)||!Array.isArray(deltas))throw Error('INVALID_DELTA_COLLECTION');
        const member=a=>{
          if(typeof a!=='string')throw Error('INVALID_MEMBERSHIP_ID');
          if(feed==='trending'&&a.includes(':')){const [chain,address,...rest]=a.split(':');if(chain!==g.chain||rest.length)throw Error('MEMBERSHIP_CHAIN_MISMATCH');return id(chain,address).address;}
          return id(g.chain,a).address;
        };
        const tokens=new Map(g.tokens),added=new Set(additions.map(member));
        const removed=new Set(removals.map(member));
        for(const a of added)if(removed.has(a))throw Error('CONFLICTING_MEMBERSHIP');
        for(const a of removed)tokens.delete(a);
        for(const delta of deltas){
          if(delta.c!==g.chain)throw Error('DELTA_CHAIN_MISMATCH');
          const tokenId=id(g.chain,delta.a),old=tokens.get(tokenId.address);
          const fields=feed==='migrated'?delta.f:Object.fromEntries(Object.entries(delta).filter(([k])=>!['c','a'].includes(k)));
          if(!fields||typeof fields!=='object'||Array.isArray(fields))throw Error('INVALID_DELTA_FIELDS');
          if(feed==='migrated'&&Object.keys(delta).some(k=>!['c','a','f'].includes(k)))throw Error('UNKNOWN_TOKEN_OPERATION');
          if((fields.a!==undefined&&id(g.chain,fields.a).address!==tokenId.address)||
            (fields.n!==undefined&&fields.n!==g.chain)||(fields.c!==undefined&&fields.c!==g.chain))throw Error('IDENTITY_MUTATION');
          if(removed.has(tokenId.address))throw Error('REMOVED_TOKEN_PATCH');
          if(!old&&!added.has(tokenId.address))throw Error('UNKNOWN_TOKEN_REBASE_REQUIRED');
          const raw={...(old?.raw??{}),...fields,a:tokenId.address,[feed==='migrated'?'n':'c']:g.chain};
          const ref={source:CHANNELS[feed],sha256:hash(envelope),received_at:receivedAt,version:message.v};
          tokens.set(tokenId.address,normalizeToken(raw,g.chain,feed,receivedAt,ref,{previous:old,updatedFields:new Set(Object.keys(fields))}));
        }
        if([...added].some(a=>!tokens.has(a)))throw Error('INCOMPLETE_ADDITION_REBASE_REQUIRED');
        staged.set(`${feed}:${g.chain}`,{...g,tokens,version:message.v,last_message_at:receipt<time(g.last_message_at)?g.last_message_at:receivedAt,events:g.events+1,
          added:[...new Set([...g.added,...added])],removed:[...new Set([...g.removed,...removed])]});
      }
      // No partial commit if a later message in this network frame is malformed.
      for(const [key,g] of staged)this.groups.set(key,g);
      this.sequence++;return {accepted:true,applied:staged.size,ignored};
    }catch(e){if(this.#replays[feed])this.#replays[feed].complete=false;this.fault(feed,e.message);return {accepted:false,reason:e.message,resync_required:true};}
  }
  view() {
    const now=this.now(),reasons=[],groups=[];
    for(const feed of Object.keys(CHANNELS)){
      if(!this.connections[feed])reasons.push(`${feed}:DISCONNECTED`);
      if(this.faults[feed])reasons.push(`${feed}:${this.faults[feed]}`);
      for(const chain of Object.keys(CHAINS)){
        const g=this.groups.get(`${feed}:${chain}`);
        if(!g){reasons.push(`${feed}:${chain}:SNAPSHOT_MISSING`);continue;}
        const snapshotAge=now-time(g.snapshot_at),transportAge=now-time(g.last_message_at);
        if(snapshotAge<0||snapshotAge>this.maxSnapshotAgeMs)reasons.push(`${feed}:${chain}:SNAPSHOT_STALE`);
        if(transportAge<0||transportAge>this.maxTransportAgeMs)reasons.push(`${feed}:${chain}:TRANSPORT_STALE`);
        const rows=[...g.tokens.values()].sort((a,b)=>feed==='trending'?(b.metrics.market_cap_usd.value-a.metrics.market_cap_usd.value||a.coin_id.localeCompare(b.coin_id)):(Date.parse(b.opened_at||0)-Date.parse(a.opened_at||0)||a.coin_id.localeCompare(b.coin_id)));
        const {tokens,...meta}=g;
        groups.push({...clone(meta),chain:CHAINS[chain],snapshot_age_ms:snapshotAge,transport_age_ms:transportAge,
          purpose:'DISCOVERY_AND_RESEARCH',ranking_window:feed==='trending'?'24h':null,
          age_filter:feed==='trending'?{max_created:g.filter.max_created,max_age_days:Number(g.filter.max_created.slice(0,-1))/1440,source:canonical(this.#expectedScopes.trending)===canonical(SCOPE.trending)?'OWNER_FILTER_EXPORT':'HOST_RUNTIME_SCOPE_OVERRIDE',enforcement:'PROVIDER_FILTER',row_evidence:'created_at when returned; missing creation time does not prove age'}:null,
          order_basis:feed==='trending'?'market_cap_descending':'opened_at_descending',
          rows:rows.map((row,rank)=>({...clone(row),rank,rank_kind:'NETWORK_DERIVED_NOT_UI_ROW'}))});
      }
    }
    return {schema:'alphahands.market.v2',recorded_at:new Date(now).toISOString(),sequence:this.sequence,
      mode:'READ_ONLY_RESEARCH',research_ready:reasons.length===0,execution_ready:false,reasons,groups,
      readiness_scope:'Transport, exact request and returned-cohort schema; owner accepted bounded UI-list differences on 2026-11-06. Token research/execution need separate qualification.',
      ui_equivalence:'OWNER_ACCEPTED_BOUNDED_DIFFERENCE',ui_exact_match_verified:false,
      owner_accepted_row_difference:2,strategy_ready:reasons.length===0,
      coverage_note:'All returned tokens in the declared GMGN rank cohorts; server limits remain explicit. Not all blockchain launches.',
      freshness_note:'Receipt time and live cursor are observed. Provider update timestamps remain null. row.observed_at is the latest row event; field_provenance preserves the evidence time for each reported raw field.'};
  }
}
module.exports={FeedBook,normalizeToken,validateRequest,trendingRequest,canonical,hash,PATHS,CHANNELS,SCOPE};
