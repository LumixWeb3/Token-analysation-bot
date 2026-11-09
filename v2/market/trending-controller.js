'use strict';

// Runtime-only filter authority. It never launches a source or edits the owner
// exports. A host-supplied verifier owns all bounded browser/UI collection.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {compileImport}=require('./filter-config');
const clone=x=>JSON.parse(JSON.stringify(x));
const canonical=x=>Array.isArray(x)?'['+x.map(canonical).join(',')+']':x&&typeof x==='object'?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}':JSON.stringify(x);
const hash=x=>crypto.createHash('sha256').update(canonical(x)).digest('hex');
const CHAINS=['sol','robinhood'],MAX_BYTES=2*1024*1024;
function validateTrendingRequest(request){
  if(!request||canonical(Object.keys(request).sort())!==canonical(['meta','params'])||canonical(request.meta)!=='{}'||
    !Array.isArray(request.params)||request.params.length!==2)throw Error('TRENDING_EXPECTED_SCOPE_INVALID');
  for(const chain of CHAINS){
    const rows=request.params.filter(p=>p?.chain===chain);if(rows.length!==1)throw Error('TRENDING_FIXED_CHAIN_SCOPE');
    const p=rows[0],f=p.filter;
    if(Object.keys(p).some(k=>!['chain','interval','filter'].includes(k))||p.interval!=='24h'||!f||
      Object.keys(f).some(k=>!['filters','max_created','min_gas_fee','limit','launchpad_platform','min_marketcap'].includes(k))||
      f.limit!==500||canonical(f.launchpad_platform)!=='[]'||
      !['[]',...(chain==='sol'?['["renounced"]']:[])].includes(canonical(f.filters))||
      typeof f.max_created!=='string'||!/^\d+(?:\.\d+)?m$/.test(f.max_created)||
      !Number.isFinite(Number(f.max_created.slice(0,-1)))||Number(f.max_created.slice(0,-1))<=0||Number(f.max_created.slice(0,-1))>Number.MAX_SAFE_INTEGER||
      typeof f.min_gas_fee!=='number'||!Number.isFinite(f.min_gas_fee)||f.min_gas_fee<=0||f.min_gas_fee>Number.MAX_SAFE_INTEGER||
      (Object.hasOwn(f,'min_marketcap')&&(typeof f.min_marketcap!=='number'||!Number.isFinite(f.min_marketcap)||f.min_marketcap<=0||f.min_marketcap>Number.MAX_SAFE_INTEGER)))throw Error('TRENDING_EXPECTED_FILTER_INVALID');
  }
  return request;
}
function compile(configs){
  if(!Array.isArray(configs)||configs.length!==2||configs.some((c,i)=>c.network!==CHAINS[i]))throw Error('TRENDING_FIXED_CHAIN_SCOPE');
  return validateTrendingRequest({meta:{},params:configs.map(c=>compileImport(c,{platformScope:'ALL_CURRENT_GMGN'}))});
}
function publicReceipt(receipt,expected,now){
  const at=typeof receipt?.verified_at==='string'?Date.parse(receipt.verified_at):NaN;
  if(receipt?.qualified!==true||receipt.chain!==expected.chain||receipt.ui_verified!==true||receipt.query_verified!==true||
    receipt.request_sha256!==expected.request_sha256||receipt.config_sha256!==expected.config_sha256||
    !Number.isFinite(now)||!Number.isFinite(at)||new Date(at).toISOString()!==receipt.verified_at||at>now||now-at>60000||!Array.isArray(receipt.evidence_refs)||!receipt.evidence_refs.length||receipt.evidence_refs.length>32||
    receipt.evidence_refs.some(r=>typeof r!=='string'||!r.length||r.length>256||!/^[A-Za-z0-9_.:/-]+$/.test(r)||r.includes('..')))throw Error('TRENDING_CHANGE_VERIFICATION_FAILED');
  return{qualified:true,chain:receipt.chain,verified_at:receipt.verified_at,ui_verified:true,query_verified:true,
    request_sha256:receipt.request_sha256,config_sha256:receipt.config_sha256,evidence_refs:clone(receipt.evidence_refs)};
}
class TrendingController{
  #busy=false;
  #cleanupFault=false;
  constructor({stateDir,verifyChange=null,onScopeChange=null,now=()=>Date.now()}={}){
    if(typeof stateDir!=='string'||!path.isAbsolute(stateDir))throw Error('TRENDING_STATE_DIRECTORY_REQUIRED');
    this.directory=path.resolve(stateDir);this.file=path.join(this.directory,'trending-state.json');this.lock=path.join(this.directory,'trending-state.lock');
    // The caller supplies an ignored runtime directory. Refuse all source-tree
    // locations even if a caller accidentally passes the repository itself.
    const root=path.resolve(__dirname,'../..'),relative=path.relative(root,this.directory);
    if(relative===''||(!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative)&&!['v2-runtime','tmp'].includes(relative.split(path.sep)[0])))throw Error('TRENDING_RUNTIME_DIRECTORY_REQUIRED');
    fs.mkdirSync(this.directory,{recursive:true});
    for(let current=this.directory;;current=path.dirname(current)){
      const stat=fs.lstatSync(current);if(stat.isSymbolicLink())throw Error('TRENDING_STATE_SYMLINK');if(path.dirname(current)===current)break;
    }
    this.verifyChange=verifyChange;this.onScopeChange=onScopeChange;this.now=now;
    this.initial=CHAINS.map(c=>JSON.parse(fs.readFileSync(path.join(__dirname,'filters',c+'.json'),'utf8')));
    compile(this.initial);this.baseline=hash(this.initial);
  }
  #load(){
    if(!fs.existsSync(this.file))return{schema:'alphahands.trending-state.v2',baseline_sha256:this.baseline,version:0,configs:clone(this.initial),audit:[]};
    const stat=fs.lstatSync(this.file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_BYTES)throw Error('TRENDING_STATE_INVALID');
    const {id,...state}=JSON.parse(fs.readFileSync(this.file,'utf8'));
    if(hash(state)!==id||state.schema!=='alphahands.trending-state.v2'||state.baseline_sha256!==this.baseline||
      !Number.isSafeInteger(state.version)||state.version<0||!Array.isArray(state.audit)||state.audit.length!==state.version)throw Error('TRENDING_STATE_INVALID');
    compile(state.configs);let before=this.initial;
    for(let i=0;i<state.audit.length;i++){
      const {id,...record}=state.audit[i];
      if(hash(record)!==id||record.version!==i+1||hash(record.before_configs)!==hash(before)||
        record.before_config_sha256!==hash(record.before_configs)||record.after_config_sha256!==hash(record.after_configs)||
        record.before_request_sha256!==hash(compile(record.before_configs))||record.after_request_sha256!==hash(compile(record.after_configs)))throw Error('TRENDING_AUDIT_INVALID');
      publicReceipt(record.receipt,{chain:record.chain,request_sha256:record.after_request_sha256,config_sha256:record.after_config_sha256},Date.parse(record.recorded_at));
      before=record.after_configs;
    }
    if(hash(before)!==hash(state.configs))throw Error('TRENDING_AUDIT_INVALID');return state;
  }
  read(){
    const state=this.#load(),request=compile(state.configs);
    return{available:true,update_available:!this.#cleanupFault&&typeof this.verifyChange==='function',update_blocker:this.#cleanupFault?'LOCK_CLEANUP_FAILED':typeof this.verifyChange!=='function'?'BOUNDED_UI_AND_QUERY_VERIFIER_REQUIRED':null,
      feed:'trending',version:state.version,configs:clone(state.configs),request,
      config_sha256:hash(state.configs),request_sha256:hash(request),audit_count:state.audit.length,
      active_chain_scope:clone(CHAINS),ranking_window:'24h',runtime_only:true,requires_fresh_observation:true};
  }
  #save(state){
    const bytes=Buffer.from(JSON.stringify({id:hash(state),...state}));if(bytes.length>MAX_BYTES)throw Error('TRENDING_STATE_BOUND');
    const temporary=path.join(this.directory,'.trending-'+crypto.randomUUID()+'.tmp');let fd;
    try{fd=fs.openSync(temporary,'wx');let offset=0;while(offset<bytes.length){const count=fs.writeSync(fd,bytes,offset,bytes.length-offset);if(!Number.isInteger(count)||count<=0||count>bytes.length-offset)throw Error('TRENDING_STATE_WRITE_FAILED');offset+=count;}
      fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temporary,this.file);
    }finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  }
  async update({feed,expected_version,chain,patch,reason,source_ids}={}){
    if(this.#cleanupFault)return{changed:false,scope_changed:false,status:'UNAVAILABLE',reason:'LOCK_CLEANUP_FAILED'};
    if(this.#busy)return{changed:false,scope_changed:false,status:'BUSY'};
    this.#busy=true;let lockFd,scopeChanged=false;
    try{
      try{lockFd=fs.openSync(this.lock,'wx');}catch(e){if(e.code==='EEXIST')return{changed:false,scope_changed:false,status:'BUSY'};throw e;}
      const state=this.#load();
      if(feed!=='trending'||!CHAINS.includes(chain))throw Error('TRENDING_FIXED_CHAIN_SCOPE');
      if(!Number.isSafeInteger(expected_version)||expected_version!==state.version)return{changed:false,scope_changed:false,status:'VERSION_CONFLICT',version:state.version};
      if(typeof reason!=='string'||!reason.trim()||reason.length>4096||!Array.isArray(source_ids)||!source_ids.length||source_ids.length>64||source_ids.some(s=>typeof s!=='string'||!s.length||s.length>256))throw Error('TRENDING_CHANGE_REASON_AND_SOURCES_REQUIRED');
      if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).length!==1||Object.keys(patch)[0]!=='filterQuery'||!patch.filterQuery||
        typeof patch.filterQuery!=='object'||Array.isArray(patch.filterQuery)||!Object.keys(patch.filterQuery).length||
        Object.keys(patch.filterQuery).some(k=>!Object.hasOwn(state.configs[CHAINS.indexOf(chain)].filterQuery,k)))throw Error('TRENDING_PATCH_UNSUPPORTED');
      const after=clone(state.configs),target=after[CHAINS.indexOf(chain)];target.filterQuery={...target.filterQuery,...clone(patch.filterQuery)};
      const request=compile(after),configHash=hash(after),requestHash=hash(request);
      if(configHash===hash(state.configs))return{changed:false,scope_changed:false,status:'UNCHANGED',version:state.version};
      if(typeof this.verifyChange!=='function')return{changed:false,scope_changed:false,status:'UNAVAILABLE',reason:'BOUNDED_UI_AND_QUERY_VERIFIER_REQUIRED',version:state.version};
      const expected={chain,before_configs:clone(state.configs),after_configs:clone(after),request:clone(request),config_sha256:configHash,request_sha256:requestHash,version:state.version+1};
      // Invalidate any frozen research cohort BEFORE a callback can touch the
      // live filter. Verification failures remain indeterminate scope changes.
      if(this.onScopeChange){const result=this.onScopeChange(clone(expected));if(result&&typeof result.then==='function')throw Error('TRENDING_SCOPE_CALLBACK_MUST_BE_SYNCHRONOUS');}
      scopeChanged=true;
      const receipt=publicReceipt(await this.verifyChange(clone(expected)),expected,this.now());
      const record={version:state.version+1,chain,recorded_at:new Date(this.now()).toISOString(),reason,source_ids:clone(source_ids),
        before_configs:clone(state.configs),after_configs:clone(after),before_config_sha256:hash(state.configs),after_config_sha256:configHash,
        before_request_sha256:hash(compile(state.configs)),after_request_sha256:requestHash,receipt};
      const next={...state,version:record.version,configs:after,audit:[...state.audit,{id:hash(record),...record}]};
      this.#save(next);
      return{changed:true,scope_changed:true,status:'VERIFIED_AND_COMMITTED',version:next.version,config_sha256:configHash,request_sha256:requestHash,audit_id:hash(record),receipt,requires_fresh_observation:true};
    }catch(e){return{changed:false,scope_changed:scopeChanged,status:scopeChanged?'INDETERMINATE_SCOPE_CHANGE':'REJECTED',reason:/^(?:TRENDING_|INVALID_FILTER|UNSUPPORTED_FILTER|UNAPPROVED_SCREENING|PARTIAL_LAUNCHPAD|UNKNOWN_FILTER|EMPTY_LAUNCHPAD)[A-Za-z0-9_:.-]*$/.test(e.message)?e.message:'TRENDING_CHANGE_FAILED'};
    }finally{
      if(lockFd!==undefined){
        // Cleanup cannot erase the original verification/persistence result.
        // A broken lease disables future writes instead of reacquiring blindly.
        try{fs.closeSync(lockFd);}catch{this.#cleanupFault=true;}
        try{fs.unlinkSync(this.lock);}catch{this.#cleanupFault=true;}
      }
      this.#busy=false;
    }
  }
}
module.exports={TrendingController,validateTrendingRequest};
