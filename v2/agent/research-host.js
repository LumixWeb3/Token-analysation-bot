'use strict';

// Research-only host: flexible prose, exact source/coin bookkeeping, no trades.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {FeedBook,hash}=require('../market/network-feed');
const {sourceLink}=require('../market/gmgn');
const {buildPrompt,loadStrategySeed}=require('./build-prompt');
const {runCodex}=require('./codex-runner');
const {buildXSource,sourceForPacket,stamp,MAX_CAPTURE_AGE_MS}=require('./x-evidence');
const {webSourceForPacket,publicHttpsUrl}=require('./web-evidence');
const {tokenForPacket,coinIdentity}=require('./token-evidence');
const {observationForPacket}=require('./token-network-evidence');
const checkpoint=require('./research-checkpoint');
const {actionSchema,validateAction}=require('./paper-execution');
const text={type:'string'};
const schema={type:'object',additionalProperties:false,
  properties:{notes:text,reviewed_coin_ids:{type:'array',items:text},cited_source_ids:{type:'array',items:text},
    strategy:{anyOf:[{type:'null'},{type:'object',additionalProperties:false,properties:{operation:{type:'string',enum:['KEEP','NOTE','REVISE','PAUSE']},markdown:text},required:['operation','markdown']}]},
    watches:{type:'array',items:{type:'object',additionalProperties:false,properties:{coin_id:text,thesis:text,condition:text,review_at:text},required:['coin_id','thesis','condition','review_at']}},
    research_requests:{type:'array',items:{type:'object',additionalProperties:false,properties:{kind:{type:'string',enum:['gmgn_token','x_link','x_search','browser','web_page']},input:text,reason:text},required:['kind','input','reason']}},
    next_review_at:{anyOf:[text,{type:'null'}]}},
  required:['notes','reviewed_coin_ids','cited_source_ids','strategy','watches','research_requests','next_review_at']};
const clone=x=>JSON.parse(JSON.stringify(x));
function assertKeys(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k))||keys.some(k=>!(k in value)))throw Error('RESEARCH_RESPONSE_SHAPE');}
function iso(value){if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))throw Error('RESEARCH_TIME_INVALID');return Date.parse(value);}
function checkedSource(source,now){return source?.schema==='alphahands.web-evidence.v1'?webSourceForPacket(source,now):sourceForPacket(source,now);}
function storedAudit(value){
  if(Array.isArray(value))return value.map(storedAudit);
  if(value&&typeof value==='object'){
    if(value.type==='image'&&typeof value.data==='string'){const bytes=Buffer.from(value.data,'base64');return{type:'image',mimeType:value.mimeType,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,storage:'IMAGE_BYTES_EXCLUDED_FROM_TEXT_AUDIT'};}
    return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,storedAudit(item)]));
  }
  return value;
}
function readState(directory){
  const journal=path.join(directory,'research.jsonl');
  let state={version:0,strategy_status:'UNINITIALIZED',strategy:loadStrategySeed().text,watches:[],reviewed_coin_ids:[],next_review_at:null,last_run_id:null};
  if(!fs.existsSync(journal))return state;
  const stat=fs.lstatSync(journal);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>64*1024*1024)throw Error('RESEARCH_JOURNAL_UNSAFE');
  const contents=fs.readFileSync(journal,'utf8');if(contents&&!contents.endsWith('\n'))throw Error('RESEARCH_JOURNAL_INCOMPLETE');
  for(const line of contents.trim().split('\n').filter(Boolean)){
    const e=JSON.parse(line),{sha256,...body}=e;
    if(hash(body)!==sha256||e.before_version!==state.version||e.state.version!==state.version+1)throw Error('RESEARCH_JOURNAL_INTEGRITY');
    state=e.state;
  }
  return state;
}
function sourceCatalogue(packet,now=Date.now()){
  const refs=(packet.sources??[]).map(s=>s.schema?checkedSource(s,now):s)
    .map(s=>({id:s.id,kind:s.schema==='alphahands.web-evidence.v1'?(s.request.kind==='web_page'?'WEB_PAGE':'WEB_SEARCH_SNIPPETS'):'X_SOURCE',qualified:s.qualified===true,status:s.status??'UNVERIFIED'}));
  const feedRefs=new Map();
  for(const group of packet.market?.groups??[])for(const row of group.rows??[])
    for(const observation of row.field_provenance?.observations??[]){
      const at=stamp(observation.received_at),fresh=Number.isFinite(at)&&at<=now&&now-at<=MAX_CAPTURE_AGE_MS;
      if(!/^[a-f0-9]{64}$/.test(observation.sha256??''))continue;
      const qualified=packet.market.research_ready===true&&fresh;
      const previous=feedRefs.get(observation.sha256);
      if(previous&&(previous.qualified&&!qualified||previous.qualified===qualified&&stamp(previous.received_at)>=at))continue;
      feedRefs.set(observation.sha256,{id:observation.sha256,kind:'DISCOVERY_FEED_RECORD',qualified,
        status:qualified?'QUALIFIED_DISCOVERY_OBSERVATION':'UNVERIFIED_DISCOVERY_OBSERVATION',
        source:observation.source,received_at:observation.received_at,
        scope:'Observed discovery fields only. This does not qualify linked X, a chart or an execution quote.'});
    }
  refs.push(...feedRefs.values());
  for(const token of packet.token_research??[]){
    const at=stamp(token.collected_at),fresh=Number.isFinite(at)&&at<=now&&now-at<=MAX_CAPTURE_AGE_MS;
    refs.push({id:token.evidence_id,kind:'GMGN_TOKEN_SNAPSHOT',coin_id:token.coin_id,qualified:fresh,
      status:fresh?'IDENTITY_VALIDATED_SNAPSHOT_WITH_EXPLICIT_COVERAGE':'UNVERIFIED_TIME'});
    for(const o of token.network.observations){
      const checked=observationForPacket(o,coinIdentity(token.coin_id),now,token.token.dev_wallet);
      refs.push({id:checked.id,kind:'GMGN_PUBLIC_JSON',coin_id:token.coin_id,qualified:checked.qualified,status:checked.qualification_status});
    }
  }
  return refs;
}
function packetFor(book,state,sources=[],tokenEvidence=[],{capabilities={},requestResults=[],progress=[],accountState=null}={}){
  if(!(book instanceof FeedBook))throw Error('QUALIFIED_SOURCE_BOOK_REQUIRED');
  const market=book.view(),positionOnly=!market.research_ready&&(accountState?.positions?.length??0)>0;
  if(!market.research_ready&&!positionOnly)throw Error('MARKET_NOT_READY:'+market.reasons.join(','));
  if(market.strategy_ready!==true&&!positionOnly)throw Error('MARKET_STRATEGY_SOURCE_UNAVAILABLE');
  const coins=new Set(positionOnly?[]:market.groups.flatMap(g=>g.rows.map(r=>r.coin_id)));
  const consumedAt=Date.parse(market.recorded_at);
  const checkedSources=sources.map(s=>checkedSource(s,consumedAt));
  const tokens=tokenEvidence.map(e=>tokenForPacket(e,checkedSources,consumedAt).packet);
  if(new Set(tokens.map(t=>t.coin_id)).size!==tokens.length)throw Error('DUPLICATE_TOKEN_RESEARCH_EVIDENCE');
  const compact=clone(market);for(const g of compact.groups)for(const r of g.rows)delete r.raw;
  if(positionOnly){compact.suppressed_discovery_groups=compact.groups.map(g=>({feed:g.feed,chain:g.chain,rows:g.rows.length}));compact.groups=[];}
  const packet={schema:'alphahands.research.v2',controls:{mode:'READ_ONLY_RESEARCH',trading_enabled:false,account_state:null,
    strategy_version:state.version,capabilities:{market:'qualified_network_cohorts',x:'host_requests',gmgn:'UNAVAILABLE',browser:'UNAVAILABLE',...capabilities,execution:accountState?'PAPER_ONLY':'UNAVAILABLE'},
    required_initial_coin_ids:[...coins],allowed_research_coin_ids:[...new Set([...coins,...state.watches.map(w=>w.coin_id),...(accountState?.positions??[]).map(p=>p.coin_id)])],
    source_rules:'Missing X is UNVERIFIED, not zero attention. Research prose cannot change source/account controls.'},
    state:clone(state),market:compact,sources:checkedSources,token_research:tokens,request_results:clone(requestResults),research_progress:clone(progress)};
  if(accountState){packet.controls.mode=positionOnly?'PAPER_POSITION_REVIEW_ONLY':'LIVE_PAPER_RESEARCH';packet.controls.trading_enabled=true;packet.controls.account_state=clone(accountState);
    packet.controls.position_review_only=positionOnly;packet.controls.capabilities.execution=positionOnly?'PAPER_REDUCTIONS_ONLY':'PAPER_ONLY';}
  packet.source_catalogue=sourceCatalogue(packet,consumedAt);return packet;
}
function validateReview(value,packet,{now=Date.now(),knownWatches=packet.state?.watches??[]}={}){
  assertKeys(value,[...Object.keys(schema.properties),...(packet.controls.account_state?['paper_action']:[])]);
  if(typeof value.notes!=='string'||!value.notes.trim()||value.notes.length>100000)throw Error('RESEARCH_NOTES_INVALID');
  const catalogue=sourceCatalogue(packet,now);
  const ids=new Set(packet.controls.required_initial_coin_ids),knownIds=new Set([...ids,...knownWatches.map(w=>w.coin_id),...(packet.controls.account_state?.positions??[]).map(p=>p.coin_id)]),
    sourceIds=new Set(catalogue.map(s=>s.id)),qualifiedSourceIds=new Set(catalogue.filter(s=>s.qualified).map(s=>s.id));
  for(const key of ['reviewed_coin_ids','cited_source_ids']){
    if(!Array.isArray(value[key])||value[key].some(x=>typeof x!=='string')||new Set(value[key]).size!==value[key].length)throw Error('RESEARCH_ID_LIST_INVALID');
  }
  if(value.reviewed_coin_ids.some(id=>!knownIds.has(id)))throw Error('UNKNOWN_REVIEWED_COIN');
  if(value.cited_source_ids.some(id=>!sourceIds.has(id)))throw Error('UNVERIFIED_SOURCE_CITATION');
  if(!Array.isArray(value.watches)||value.watches.length>1000)throw Error('WATCH_LIST_INVALID');
  const watchIds=new Set();for(const w of value.watches){
    assertKeys(w,['coin_id','thesis','condition','review_at']);
    if(!knownIds.has(w.coin_id)||watchIds.has(w.coin_id)||typeof w.thesis!=='string'||!w.thesis.trim()||typeof w.condition!=='string'||!w.condition.trim())throw Error('WATCH_INVALID');
    iso(w.review_at);watchIds.add(w.coin_id);
  }
  if(!Array.isArray(value.research_requests)||value.research_requests.length>4)throw Error('RESEARCH_REQUEST_LIMIT');
  for(const r of value.research_requests){assertKeys(r,['kind','input','reason']);if(!['gmgn_token','x_link','x_search','browser','web_page'].includes(r.kind)||typeof r.input!=='string'||!r.input.trim()||r.input.length>1000||typeof r.reason!=='string'||!r.reason.trim())throw Error('RESEARCH_REQUEST_INVALID');
    if(r.kind==='gmgn_token'&&!knownIds.has(coinIdentity(r.input).coin_id))throw Error('UNKNOWN_RESEARCH_COIN');
    if(r.kind==='web_page')publicHttpsUrl(r.input);
  }
  if(value.research_requests.filter(r=>r.kind==='gmgn_token').length>1)throw Error('ONE_TOKEN_RESEARCH_REQUEST_PER_ROUND');
  if(value.next_review_at!==null)iso(value.next_review_at);
  if(value.strategy!==null){assertKeys(value.strategy,['operation','markdown']);
    if(packet.controls.position_review_only&&value.strategy.operation==='REVISE')throw Error('STRATEGY_MARKET_COVERAGE_UNAVAILABLE');
    if(!['KEEP','NOTE','REVISE','PAUSE'].includes(value.strategy.operation)||typeof value.strategy.markdown!=='string'||value.strategy.markdown.length>100000)throw Error('STRATEGY_OPERATION_INVALID');
    if(value.strategy.operation==='REVISE'&&!value.strategy.markdown.trim())throw Error('EMPTY_STRATEGY');
    const covered=new Set([...packet.state.reviewed_coin_ids,...value.reviewed_coin_ids].filter(id=>ids.has(id)));
    if(value.strategy.operation==='REVISE'&&packet.state.strategy_status==='UNINITIALIZED'&&covered.size!==ids.size)throw Error('INITIAL_COHORT_NOT_FULLY_REVIEWED');
    if(['REVISE','NOTE'].includes(value.strategy.operation)&&!value.cited_source_ids.length)throw Error('STRATEGY_SOURCE_EVIDENCE_REQUIRED');
    if(['REVISE','NOTE'].includes(value.strategy.operation)&&!value.cited_source_ids.some(id=>qualifiedSourceIds.has(id)))throw Error('UNVERIFIED_SOURCE_CITATION');
  }
  if(packet.controls.account_state&&value.paper_action!==null){
    const action=validateAction(value.paper_action);
    if(!knownIds.has(action.coin_id)||action.expected_account_revision!==packet.controls.account_state.revision)throw Error('V2_PAPER_ACTION_STATE_MISMATCH');
    if(value.research_requests.length)throw Error('V2_PAPER_ACTION_WITH_UNFINISHED_RESEARCH');
    if(value.strategy&&value.strategy.operation!=='KEEP')throw Error('V2_PAPER_ACTION_REQUIRES_ACCEPTED_STRATEGY');
    if(['BUY','ADD'].includes(action.action)){
      if(packet.controls.position_review_only)throw Error('V2_PAPER_ENTRY_NOT_QUALIFIED');
      const token=packet.token_research.find(t=>t.coin_id===action.coin_id);
      if(packet.state.strategy_status!=='RESEARCHED'||!token?.research_ready||!value.cited_source_ids.includes(token.evidence_id))throw Error('V2_PAPER_ENTRY_EVIDENCE_REQUIRED');
    }
  }
  return value;
}
function xClient(){
  if(process.env.TWSCRAPE_URL){const u=new URL(process.env.TWSCRAPE_URL);if(!['127.0.0.1','localhost'].includes(u.hostname)||u.username||u.password||u.protocol!=='http:')throw Error('X_SERVICE_DESTINATION_NOT_ALLOWED');}
  return require('../../twscrape-client'); // Existing read-only/cleanup-qualified client; starts no service.
}
async function researchSource(request,{client,now=()=>Date.now()}={}){
  const started=new Date(now()).toISOString();let raw=null,expected=null;
  try{
    if(request.kind==='browser')return buildXSource({request,raw:null,capture_started_at:started,collected_at:new Date(now()).toISOString()});
    client=client??xClient();
    if(request.kind==='x_search'){
      raw=await client.xSearch(request.input,{limit:15,product:'Top'});
    }else if(request.kind==='x_link'){
      expected=sourceLink(request.input);if(!expected.canonical_url)throw Error('UNSUPPORTED_X_SOURCE');
      if(expected.type==='STATUS')raw=await client.xTweet(expected.canonical_url);
      else if(expected.type==='PROFILE')raw=await client.xUserTweets(expected.author,{limit:15});
      else raw=await client.xCommunity(expected.canonical_url,{limit:15});
    }else throw Error('UNKNOWN_RESEARCH_TOOL');
    return buildXSource({request,raw,capture_started_at:started,collected_at:new Date(now()).toISOString()});
  }catch{
    return buildXSource({request,raw:null,capture_started_at:started,collected_at:new Date(now()).toISOString()});
  }
}
function researchLock(directory){
  fs.mkdirSync(directory,{recursive:true});const stat=fs.lstatSync(directory);if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('RESEARCH_STATE_DIRECTORY_UNSAFE');
  const lock=path.join(directory,'research.lock'),fd=fs.openSync(lock,'wx');return()=>{fs.closeSync(fd);fs.unlinkSync(lock);};
}
function commitReview(directory,runId,expectedVersion,packet,response){
  const release=researchLock(directory);try{return commitReviewCore(directory,runId,expectedVersion,packet,response);}finally{release();}
}
function projectStrategy(directory,strategy){const temporary=path.join(directory,'STRATEGY.md.'+crypto.randomUUID()+'.tmp');fs.writeFileSync(temporary,strategy);fs.renameSync(temporary,path.join(directory,'STRATEGY.md'));}
function commitReviewCore(directory,runId,expectedVersion,packet,response){
  const project=strategy=>projectStrategy(directory,strategy);
  {
    const state=readState(directory),commitHash=hash({expectedVersion,packet,response});
    if(state.last_run_id===runId){if(state.last_commit_sha256!==commitHash)throw Error('RESEARCH_RUN_ID_CONFLICT');project(state.strategy);return{status:'ALREADY_COMMITTED',version:state.version};}
    if(state.version!==expectedVersion)throw Error('STRATEGY_VERSION_CHANGED');
    if(packet.controls.strategy_version!==expectedVersion||packet.state.version!==expectedVersion)throw Error('PACKET_VERSION_MISMATCH');
    // Packet progress can add reviewed feed IDs, but only journal state can
    // authorize retaining an off-feed watch at the durable write boundary.
    validateReview(response,packet,{knownWatches:state.watches});const next={...state,version:state.version+1,last_run_id:runId,
      last_commit_sha256:commitHash,notes:response.notes,watches:clone(response.watches),reviewed_coin_ids:[...new Set([...state.reviewed_coin_ids,...packet.state.reviewed_coin_ids,...response.reviewed_coin_ids])],
      next_review_at:response.next_review_at,based_on_market_at:packet.market.recorded_at,source_ids:response.cited_source_ids};
    const operation=response.strategy?.operation;
    next.paper_decision=response.paper_action?{run_id:runId,action:clone(response.paper_action),strategy_version:state.version,
      decided_at:packet.market.recorded_at,evidence_qualified:packet.token_research.some(t=>t.coin_id===response.paper_action.coin_id&&t.research_ready)}:null;
    if(operation==='REVISE'){next.strategy=response.strategy.markdown;next.strategy_status='RESEARCHED';}
    if(operation==='NOTE')next.strategy+='\n\n'+response.strategy.markdown;
    if(operation==='PAUSE')next.strategy_status='PAUSED';
    const event={run_id:runId,before_version:state.version,packet_sha256:hash(packet),state:next};
    const bytes=Buffer.from(JSON.stringify({...event,sha256:hash(event)})+'\n','utf8');
    const journal=fs.openSync(path.join(directory,'research.jsonl'),'a');try{
      for(let offset=0;offset<bytes.length;){
        const written=fs.writeSync(journal,bytes,offset,bytes.length-offset,null);
        if(!Number.isInteger(written)||written<=0||written>bytes.length-offset)throw Error('RESEARCH_JOURNAL_WRITE_INCOMPLETE');
        offset+=written;
      }
      fs.fsyncSync(journal);
    }finally{fs.closeSync(journal);}
    // The fsynced append-only journal is authority; this Markdown is a projection.
    project(next.strategy);
    return{status:'COMMITTED',version:next.version,strategy_status:next.strategy_status,watches:next.watches.length};
  }
}
async function runResearch({book,stateDir,execute=runCodex,source=researchSource,broker=null,maxRounds=3,initialSources=[],tokenEvidence=[],resumeRunId=null,runtime=null,accountState=null}={}){
  if(!(book instanceof FeedBook))throw Error('QUALIFIED_SOURCE_BOOK_REQUIRED');
  if(!Number.isInteger(maxRounds)||maxRounds<1||maxRounds>4)throw Error('RESEARCH_ROUND_BOUND');
  if(broker&&(typeof broker.collect!=='function'||!broker.capabilities))throw Error('RESEARCH_BROKER_INVALID');
  const release=researchLock(stateDir);try{
    const accepted=readState(stateDir),policy=buildPrompt();
    const hasPending=checkpoint.exists(stateDir);if(hasPending&&!resumeRunId)throw Error('RESEARCH_RESUME_REQUIRED');
    let state=clone(accepted),sources=clone(initialSources),tokens=clone(tokenEvidence),requestResults=[],progress=[],runId=crypto.randomUUID(),startRound=0,pending=[];
    // Capture the declared cohort once; metric/rank/receipt changes do not alter it.
    const responseSchema=accountState?{...schema,properties:{...schema.properties,paper_action:{anyOf:[{type:'null'},actionSchema]}},required:[...schema.required,'paper_action']}:schema;
    const makePacket=(...args)=>{const [b,s,src=[],tok=[],options={}]=args;return packetFor(b,s,src,tok,{...options,accountState});};
    const initialPacket=makePacket(book,state),binding=checkpoint.cohortBinding(initialPacket.market),baseHash=hash(accepted),policyHash=hash(policy.text),schemaHash=hash(responseSchema);
    if(hasPending){
      let saved;try{saved=checkpoint.load(stateDir,{hydrate:false});}catch{throw Error('RESEARCH_REVALIDATION_REQUIRED:CHECKPOINT_INVALID');}
      if(saved.run_id!==resumeRunId)throw Error('RESEARCH_REVALIDATION_REQUIRED:RUN_ID');
      // A committed journal remains authority even if earlier pending cleanup failed.
      if(accepted.last_run_id===resumeRunId){projectStrategy(stateDir,accepted.strategy);let cleanup=null;try{checkpoint.clear(stateDir,resumeRunId);}catch{cleanup='PENDING_CLEANUP_FAILED';}return{run_id:resumeRunId,status:'ALREADY_COMMITTED',version:accepted.version,pending_cleanup:cleanup};}
      try{
        if(saved.phase!=='PAUSED')throw Error('INTERRUPTED_ACTIVE_CONTINUATION');
        saved=checkpoint.load(stateDir);
        if(saved.base_state_sha256!==baseHash||saved.base_version!==accepted.version||saved.policy_sha256!==policyHash||saved.response_schema_sha256!==schemaHash||hash(saved.cohort_binding)!==hash(binding))throw Error('BINDING_CHANGED');
        if(!Number.isInteger(saved.next_round)||saved.next_round<1||!Array.isArray(saved.progress)||!Array.isArray(saved.sources)||!Array.isArray(saved.request_results)||!Array.isArray(saved.pending_requests)||!saved.pending_requests.length)throw Error('CHECKPOINT_SHAPE');
        const now=Date.parse(initialPacket.market.recorded_at);
        for(const s of saved.sources){const checked=checkedSource(s,now);if(!Number.isFinite(checked.capture_age_ms)||checked.capture_age_ms<0||checked.capture_age_ms>MAX_CAPTURE_AGE_MS)throw Error('STALE_SOURCE');}
        for(const e of saved.tokens)tokenForPacket(e,saved.sources,now);
        state=saved.state;sources=saved.sources;tokens=saved.tokens;requestResults=saved.request_results;progress=saved.progress;runId=saved.run_id;startRound=saved.next_round;pending=saved.pending_requests;
        if(state.version!==accepted.version||hash({...state,reviewed_coin_ids:accepted.reviewed_coin_ids})!==baseHash)throw Error('STATE_CHANGED');
        const known=new Set([...initialPacket.controls.required_initial_coin_ids,...accepted.watches.map(w=>w.coin_id)]);
        if(progress.length!==startRound||progress.some((p,i)=>p.round!==i||!Number.isFinite(Date.parse(p.recorded_at))||!Array.isArray(p.reviewed_coin_ids)||p.reviewed_coin_ids.some(id=>!known.has(id))))throw Error('PROGRESS_INVALID');
        if(hash(state.reviewed_coin_ids)!==hash([...new Set([...accepted.reviewed_coin_ids,...progress.flatMap(p=>p.reviewed_coin_ids)])]))throw Error('COVERAGE_INVALID');
        const requestReview={notes:'Validate saved requests.',reviewed_coin_ids:[],cited_source_ids:[],strategy:null,watches:[],research_requests:pending,next_review_at:null};
        if(accountState)requestReview.paper_action=null;
        validateReview(requestReview,makePacket(book,state,sources,tokens.slice(-1)),{knownWatches:accepted.watches});
        checkpoint.save(stateDir,{...saved,phase:'ACTIVE'});
      }catch{throw Error('RESEARCH_REVALIDATION_REQUIRED');}
    }else if(resumeRunId)throw Error('RESEARCH_REVALIDATION_REQUIRED:CHECKPOINT_MISSING');
    function acceptCollected(collected,request){
        if(hash(collected.request)!==hash(request)||!Array.isArray(collected.sources)||!Array.isArray(collected.token_evidence))throw Error('RESEARCH_TOOL_RESULT_INVALID');
        const consumedAt=Date.parse(book.view().recorded_at),sourceIds=[],tokenIds=[],superseded=[];
        for(const s of collected.sources){const checked=checkedSource(s,consumedAt);
          if(checked.schema==='alphahands.web-evidence.v1'){
            if(!['web_page','web_search'].includes(request.kind)||checked.request.kind!==request.kind||checked.request.input!==request.input)throw Error('RESEARCH_TOOL_SOURCE_MISMATCH');
            sources.push(checked);sourceIds.push(checked.id);continue;
          }
          const unavailableBrowser=request.kind==='browser'&&checked.request.kind==='browser'&&!checked.qualified&&checked.request.input===request.input;
          if(request.kind==='gmgn_token'||(request.kind==='x_search'?checked.request.kind!=='x_search'||checked.request.input!==request.input:
            !unavailableBrowser&&(checked.request.kind!=='x_link'||hash(sourceLink(checked.request.input))!==hash(sourceLink(request.input)))))throw Error('RESEARCH_TOOL_SOURCE_MISMATCH');
          sources.push(checked);sourceIds.push(checked.id);
        }
        for(const e of collected.token_evidence){
          if(request.kind!=='gmgn_token'||e.coin_id!==coinIdentity(request.input).coin_id)throw Error('RESEARCH_TOOL_TOKEN_MISMATCH');
          tokenForPacket(e,sources,consumedAt);const index=tokens.findIndex(t=>t.coin_id===e.coin_id);
          if(index>=0){superseded.push(tokens[index].id);tokens.splice(index,1);}tokens.push(e);tokenIds.push(e.id);
        }
        requestResults.push({request:clone(request),status:collected.status,reason:collected.reason??null,attempts:clone(collected.attempts??[]),source_ids:sourceIds,token_evidence_ids:tokenIds,supersedes_evidence_ids:superseded});
    }
    async function collectRequests(requests){
      for(const request of requests){
        try{
          const collected=broker?await broker.collect(request):['gmgn_token','web_page'].includes(request.kind)?{request,status:'UNVERIFIED',reason:'OWNED_BROWSER_NOT_CONFIGURED',sources:[],token_evidence:[]}:
            {request,status:'OBSERVED',reason:null,sources:[await source(request)],token_evidence:[]};
          acceptCollected(collected,request);
        }catch(error){
          const reason=/^[A-Z][A-Z0-9_:,]+$/.test(error.message)?error.message:'RESEARCH_SOURCE_PROCESSING_FAILED';
          const root=path.resolve(__dirname,'../..');
          const frames=String(error.stack).split('\n').slice(1).filter(line=>line.includes(root)).map(line=>line.replaceAll(root,'<repo>')).slice(0,6);
          fs.appendFileSync(path.join(stateDir,'turns.jsonl'),JSON.stringify({run_id:runId,status:'SOURCE_PROCESSING_FAILED',request,reason,error_type:error.name,frames})+'\n');
          throw Error(reason);
        }
      }

    }
    function requireBinding(){if(hash(checkpoint.cohortBinding(makePacket(book,state).market))!==hash(binding))throw Error('RESEARCH_REVALIDATION_REQUIRED:COHORT_CHANGED');}
    if(pending.length)await collectRequests(pending);
    for(let step=0;step<maxRounds;step++){
      requireBinding();
      const round=startRound+step,active=tokens.slice(-1);
      const packet=makePacket(book,state,sources,active,{capabilities:broker?.capabilities??{},requestResults,progress});packet.controls.run_id=runId;packet.controls.round=round;packet.controls.rounds_remaining=maxRounds-step;
      packet.controls.max_token_research_requests_per_round=1;
      if(runtime)packet.controls.agent=clone(runtime);
      packet.available_token_evidence=tokens.map(e=>({coin_id:e.coin_id,evidence_id:e.id,collected_at:e.collected_at,selected:active.includes(e)}));
      const images=active.flatMap(e=>tokenForPacket(e,sources,Date.parse(packet.market.recorded_at)).images);
      let output;
      try{output=await execute({policy:policy.text,packet,schema:responseSchema,images});}
      catch(error){
        fs.appendFileSync(path.join(stateDir,'turns.jsonl'),JSON.stringify({run_id:runId,round,status:'MODEL_EXECUTION_FAILED',
          reason:/^[A-Z][A-Z0-9_:,]+$/.test(error.message)?error.message:'RESEARCH_EXECUTION_FAILED',
          input_packet:packet,input_bytes:Buffer.byteLength(JSON.stringify(packet)),policy_manifest:policy.manifest})+'\n');
        throw error;
      }
      if(output.scope_changed===true){
        fs.appendFileSync(path.join(stateDir,'turns.jsonl'),JSON.stringify({run_id:runId,round,status:'SCOPE_CHANGED_REOBSERVATION_REQUIRED',packet,raw_response:output.text,tool_results:(output.tool_results??[]).map(r=>({status:r.status,reason:r.reason??null,source_ids:(r.sources??[]).map(s=>s.id),token_evidence_ids:(r.token_evidence??[]).map(t=>t.id)})),policy_manifest:policy.manifest})+'\n');
        return{run_id:runId,status:'REOBSERVATION_REQUIRED',reason:'TRENDING_FILTER_SCOPE_CHANGED',version:accepted.version};
      }
      const direct=output.tool_results??[];if(!Array.isArray(direct))throw Error('RESEARCH_DIRECT_TOOL_RESULTS_INVALID');
      for(const collected of direct){if((collected.sources?.length??0)||(collected.token_evidence?.length??0))acceptCollected(collected,collected.request);}
      // Only host-owned tool receipts join the packet, never model-authored evidence.
      const finalPacket=makePacket(book,state,sources,tokens.slice(-1),{capabilities:broker?.capabilities??{},requestResults,progress});
      Object.assign(finalPacket.controls,packet.controls);finalPacket.available_token_evidence=tokens.map(e=>({coin_id:e.coin_id,evidence_id:e.id,collected_at:e.collected_at,selected:e===tokens.at(-1)}));
      let response;
      try{response=validateReview(JSON.parse(output.text),finalPacket);}
      catch(error){
        fs.appendFileSync(path.join(stateDir,'turns.jsonl'),JSON.stringify({run_id:runId,round,status:'REJECTED_REVIEW',
          validation_error:/^[A-Z][A-Z0-9_:,]+$/.test(error.message)?error.message:'RESEARCH_RESPONSE_INVALID',input_packet:packet,packet:finalPacket,
          raw_response:output.text,model:output.model??null,model_audit:storedAudit({items:output.items??[],native_search:output.native_search??[],sdk_events:output.sdk_events??[]}),policy_manifest:policy.manifest})+'\n');
        throw error;
      }
      fs.appendFileSync(path.join(stateDir,'turns.jsonl'),JSON.stringify({run_id:runId,round,input_packet:packet,packet:finalPacket,response,model:output.model??null,input_transport:output.input_transport??null,cache:output.cache??null,model_audit:storedAudit({items:output.items??[],native_search:output.native_search??[],sdk_events:output.sdk_events??[]}),policy_manifest:policy.manifest})+'\n');
      state.reviewed_coin_ids=[...new Set([...state.reviewed_coin_ids,...response.reviewed_coin_ids])];
      progress.push({round,recorded_at:packet.market.recorded_at,notes:response.notes,reviewed_coin_ids:clone(response.reviewed_coin_ids),research_requests:clone(response.research_requests)});
      requireBinding();
      if(response.research_requests.length){
        if(step+1===maxRounds){
          // Only ordinary round exhaustion produces a resumable checkpoint.
          for(const e of tokens)tokenForPacket(e,sources,Date.parse(packet.market.recorded_at));
          checkpoint.save(stateDir,{schema:'alphahands.research-pending.v1',phase:'PAUSED',run_id:runId,recorded_at:packet.market.recorded_at,next_round:round+1,
            base_state_sha256:baseHash,base_version:accepted.version,policy_sha256:policyHash,response_schema_sha256:schemaHash,cohort_binding:binding,
            state,sources,tokens,request_results:requestResults,progress,pending_requests:response.research_requests});
          return{run_id:runId,status:'RESEARCH_IN_PROGRESS',reason:'RESEARCH_ROUND_BOUND',outstanding_requests:response.research_requests,sources:sources.length};
        }
        await collectRequests(response.research_requests);continue;
      }
      if(!book.view().research_ready&&!finalPacket.controls.position_review_only)throw Error('MARKET_CHANGED_OR_UNAVAILABLE_DURING_RESEARCH');
      const result=commitReviewCore(stateDir,runId,state.version,finalPacket,response);let cleanup=null;
      try{checkpoint.clear(stateDir,runId);}catch{cleanup='PENDING_CLEANUP_FAILED';}
      return{run_id:runId,...result,sources:sources.length,pending_cleanup:cleanup};
    }
  }finally{release();}
}
function watchWake(state,view,now=Date.now()){
  if(!view.research_ready)return{wake:false,reason:'MARKET_UNAVAILABLE'};
  const due=state.watches.filter(w=>iso(w.review_at)<=now).map(w=>w.coin_id);
  return{wake:due.length>0||(state.next_review_at!==null&&iso(state.next_review_at)<=now),reason:due.length?'WATCH_REVIEW_DUE':'STRATEGY_REVIEW_TIME',coin_ids:due,
    note:'A wake requests fresh judgement; it never executes an old trade plan.'};
}
module.exports={schema,packetFor,validateReview,researchSource,readState,commitReview,runResearch,watchWake,sourceCatalogue};
