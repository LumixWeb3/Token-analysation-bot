'use strict';
// Explicit ordinary-round continuation only. An abandoned lock is never reclaimed.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {hash}=require('../market/network-feed');
const {validatePng}=require('./token-evidence');
const MAX=32*1024*1024,FILE='research-pending.json',CACHE='research-cache';
function safe(target,directory=false){
  const s=fs.lstatSync(target);
  if(s.isSymbolicLink()||(directory?!s.isDirectory():!s.isFile())||(!directory&&s.size>MAX))throw Error('RESEARCH_CHECKPOINT_UNSAFE');
  return s;
}
function exists(directory){safe(directory,true);try{safe(path.join(directory,FILE));return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
function writeAll(fd,bytes){for(let offset=0;offset<bytes.length;){const n=fs.writeSync(fd,bytes,offset,bytes.length-offset,null);if(!Number.isInteger(n)||n<=0||n>bytes.length-offset)throw Error('RESEARCH_CHECKPOINT_WRITE_INCOMPLETE');offset+=n;}fs.fsyncSync(fd);}
function atomic(target,bytes){
  if(bytes.length>MAX)throw Error('RESEARCH_CHECKPOINT_SIZE_LIMIT');
  try{safe(target);}catch(e){if(e.code!=='ENOENT')throw e;}
  const tmp=target+'.'+crypto.randomUUID()+'.tmp',fd=fs.openSync(tmp,'wx');
  try{writeAll(fd,bytes);}finally{fs.closeSync(fd);}
  // Failed writes/renames deliberately retain their evidence rather than hiding it.
  fs.renameSync(tmp,target);
}
function cohortBinding(market){
  return market.groups.map(g=>({feed:g.feed,chain:g.chain,filter_id:g.filter_id,filter:g.filter,request_sha256:g.request_sha256,
    coin_ids:g.rows.map(r=>r.coin_id).sort()})).sort((a,b)=>(a.feed+':'+a.chain).localeCompare(b.feed+':'+b.chain));
}
function save(directory,body){
  safe(directory,true);const cache=path.join(directory,CACHE);
  try{fs.mkdirSync(cache);}catch(e){if(e.code!=='EEXIST')throw e;}safe(cache,true);
  const copy=JSON.parse(JSON.stringify(body));let size=0;
  for(const token of copy.tokens){if(!token.chart?.ok)continue;
    const png=validatePng(token.chart.base64);if(png.sha256!==token.chart.sha256)throw Error('RESEARCH_CHECKPOINT_IMAGE_HASH');
    const target=path.join(cache,png.sha256+'.png');size+=png.bytes.length;
    if(size>MAX)throw Error('RESEARCH_CHECKPOINT_SIZE_LIMIT');
    try{safe(target);if(!fs.readFileSync(target).equals(png.bytes))throw Error('RESEARCH_CHECKPOINT_IMAGE_HASH');}
    catch(e){if(e.code!=='ENOENT')throw e;atomic(target,png.bytes);}
    delete token.chart.base64;
  }
  const bytes=Buffer.from(JSON.stringify({sha256:hash(copy),body:copy})+'\n');
  if(size+bytes.length>MAX)throw Error('RESEARCH_CHECKPOINT_SIZE_LIMIT');
  atomic(path.join(directory,FILE),bytes);
}
function load(directory,{hydrate=true}={}){
  safe(directory,true);const target=path.join(directory,FILE);safe(target);
  const envelope=JSON.parse(fs.readFileSync(target,'utf8'));
  const keys=['schema','phase','run_id','recorded_at','next_round','base_state_sha256','base_version','policy_sha256','response_schema_sha256','cohort_binding','state','sources','tokens','request_results','progress','pending_requests'];
  if(Object.keys(envelope).sort().join(',')!=='body,sha256'||!envelope.body||Object.keys(envelope.body).sort().join(',')!==keys.sort().join(',')||hash(envelope.body)!==envelope.sha256||envelope.body.schema!=='alphahands.research-pending.v1')throw Error('RESEARCH_CHECKPOINT_INTEGRITY');
  const body=envelope.body;let size=fs.statSync(target).size;
  if(!['PAUSED','ACTIVE'].includes(body.phase)||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(body.run_id)||!Number.isSafeInteger(body.next_round)||body.next_round<1||body.next_round>10000||!Number.isSafeInteger(body.base_version)||body.base_version<0||!Number.isFinite(Date.parse(body.recorded_at))||!Array.isArray(body.tokens))throw Error('RESEARCH_CHECKPOINT_INTEGRITY');
  if(!hydrate)return body;
  for(const token of body.tokens){if(token.chart?.ok){
    if(!/^[a-f0-9]{64}$/.test(token.chart.sha256)||Object.hasOwn(token.chart,'base64'))throw Error('RESEARCH_CHECKPOINT_IMAGE_HASH');
    const cache=path.join(directory,CACHE);safe(cache,true);const pngPath=path.join(cache,token.chart.sha256+'.png');
    const stat=safe(pngPath);size+=stat.size;if(size>MAX)throw Error('RESEARCH_CHECKPOINT_SIZE_LIMIT');
    const bytes=fs.readFileSync(pngPath),png=validatePng(bytes.toString('base64'));
    if(png.sha256!==token.chart.sha256)throw Error('RESEARCH_CHECKPOINT_IMAGE_HASH');token.chart.base64=bytes.toString('base64');
    }
    const {id,...evidence}=token;if(hash(evidence)!==id)throw Error('RESEARCH_CHECKPOINT_TOKEN_INTEGRITY');
  }
  return body;
}
function clear(directory,runId){
  if(!exists(directory))return;
  const body=load(directory,{hydrate:false});if(body.run_id!==runId)throw Error('RESEARCH_CHECKPOINT_RUN_ID_MISMATCH');
  fs.unlinkSync(path.join(directory,FILE));
}
function preservePausedResearch(directory,accepted){
  const body=load(directory);
  if(body.phase!=='PAUSED')throw Error('RESEARCH_ACTIVE_CHECKPOINT_REQUIRES_RECONCILIATION');
  if(body.base_version!==accepted.version||body.base_state_sha256!==hash(accepted))throw Error('RESEARCH_ACCEPTED_STATE_CHANGED');
  const root=fs.realpathSync(directory),archive=path.join(root,'research-archive');
  fs.mkdirSync(archive,{recursive:true});
  if(path.dirname(fs.realpathSync(archive))!==root)throw Error('RESEARCH_ARCHIVE_PATH_UNSAFE');
  const file=body.run_id+'-round-'+body.next_round+'.json',target=path.join(archive,file);
  if(fs.existsSync(target))throw Error('RESEARCH_ARCHIVE_CONFLICT');
  const historical={status:'HISTORICAL_REVALIDATION_REQUIRED',run_id:body.run_id,recorded_at:body.recorded_at,
    archive:'research-archive/'+file,shared_image_cache:CACHE,
    notes:body.progress.map(p=>({recorded_at:p.recorded_at,notes:p.notes,review:p.response??null})),pending_questions:body.pending_requests,
    sources:body.sources.map(s=>({id:s.id,request:s.request,collected_at:s.collected_at,qualified:false})),
    coverage_note:'Previous partial research preserved. Every coin in the current observation cycle requires fresh consideration. Historical sources confer no current source or entry qualification.'};
  fs.renameSync(path.join(root,FILE),target);
  return historical;
}
module.exports={exists,save,load,clear,cohortBinding,preservePausedResearch};
