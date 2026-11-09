'use strict';

const {spawn}=require('node:child_process'),{StringDecoder}=require('node:string_decoder');
const {DISABLED,isolatedHome,assertIsolatedHome,environment,command}=require('./codex-sdk-config');
function controlRead({home=isolatedHome(),timeoutMs=20000,spawnImpl=spawn,signal,models=false}={}){
  home=assertIsolatedHome(home);
  const cmd=command(['app-server','--stdio','-c','forced_login_method="chatgpt"','-c','model_provider="openai"','-c','mcp_servers={}',...DISABLED.flatMap(f=>['--disable',f])]);
  return new Promise((resolve,reject)=>{
    const controller=new AbortController(),decoder=new StringDecoder('utf8');let child,buffer='',bytes=0,errors=0,settled=false,id=0,pages=0;
    const entries=[],cursors=new Set();let accountType;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);
      if(child){child.stdin.end();child.kill();}if(error)reject(error);else resolve(value);};
    const cancel=()=>{finish(Error('CODEX_CONTROL_ABORTED'));controller.abort();};
    const timer=setTimeout(()=>{finish(Error('CODEX_CONTROL_TIMEOUT'));controller.abort();},timeoutMs);
    if(signal?.aborted){cancel();return;}signal?.addEventListener('abort',cancel,{once:true});
    try{child=spawnImpl(cmd.file,cmd.args,{stdio:['pipe','pipe','pipe'],windowsHide:true,env:environment(home),signal:controller.signal});}
    catch{finish(Error('CODEX_CONTROL_PROCESS_FAILED'));return;}
    const send=(method,params={})=>child.stdin.write(JSON.stringify({method,id:id++,params})+'\n');
    const list=cursor=>send('model/list',{includeHidden:true,limit:100,...(cursor?{cursor}:{})});
    child.on('error',()=>finish(Error('CODEX_CONTROL_PROCESS_FAILED')));child.on('exit',()=>finish(Error('CODEX_CONTROL_UNAVAILABLE')));
    child.stdin.on('error',()=>finish(Error('CODEX_CONTROL_PROCESS_FAILED')));
    child.stderr.on('data',chunk=>{errors+=chunk.length;if(errors>65536)finish(Error('CODEX_CONTROL_DIAGNOSTICS_OVERSIZE'));});
    child.stdout.on('data',chunk=>{
      bytes+=chunk.length;if(bytes>4*1024*1024){finish(Error('CODEX_CONTROL_RESPONSE_OVERSIZE'));return;}
      buffer+=decoder.write(chunk);let newline;
      while(!settled&&(newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);let m;
        try{m=JSON.parse(line);}catch{finish(Error('CODEX_CONTROL_RESPONSE_INVALID'));return;}
        if(m.id===undefined)continue;
        if(m.error){finish(Error('CODEX_CONTROL_RPC_FAILED'));return;}
        if(m.id===0){child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');send('account/read',{refreshToken:false});}
        else if(m.id===1){accountType=m.result?.account?.type;
          if(accountType!=='chatgpt'){finish(Error('CODEX_CHATGPT_LOGIN_REQUIRED'));return;}
          if(models)list();else send('account/rateLimits/read');
        }else if(models){
          const result=m.result;if(!Array.isArray(result?.data)){finish(Error('CODEX_MODEL_CATALOG_UNAVAILABLE'));return;}
          for(const row of result.data){if(typeof row.model!=='string'||!Array.isArray(row.supportedReasoningEfforts)){finish(Error('CODEX_MODEL_CATALOG_INVALID'));return;}
            entries.push({model:row.model,id:row.id,efforts:row.supportedReasoningEfforts.map(x=>x.reasoningEffort),input_modalities:row.inputModalities??['text','image']});}
          if(entries.length>10000||++pages>128){finish(Error('CODEX_MODEL_CATALOG_OVERSIZE'));return;}
          if(result.nextCursor){if(typeof result.nextCursor!=='string'||cursors.has(result.nextCursor)){finish(Error('CODEX_MODEL_CATALOG_PAGINATION_INVALID'));return;}cursors.add(result.nextCursor);list(result.nextCursor);}
          else finish(null,{auth_method:accountType,observed_at:new Date().toISOString(),models:entries});
        }else finish(null,m.result);
      }
    });
    send('initialize',{clientInfo:{name:'alphahands_v2_research',title:'AlphaHands V2 research',version:'0.2.0'}});
  });
}
function readModelAvailability(options={}){return controlRead({...options,models:true});}
function assertModelAvailable(catalog,selection,{images=false}={}){
  if(catalog?.auth_method!=='chatgpt'||!Array.isArray(catalog.models))throw Error('CODEX_CHATGPT_MODEL_CATALOG_REQUIRED');
  const model=catalog.models.find(m=>m.model===selection.model);
  if(!model)throw Error('CODEX_REQUESTED_MODEL_UNAVAILABLE');
  if(!Array.isArray(model.efforts)||!model.efforts.includes(selection.effort))throw Error('CODEX_REQUESTED_EFFORT_UNAVAILABLE');
  if(images&&(!Array.isArray(model.input_modalities)||!model.input_modalities.includes('image')))throw Error('CODEX_REQUESTED_MODEL_IMAGE_UNAVAILABLE');
  return{observed_at:catalog.observed_at,auth_method:'chatgpt',model:selection.model,effort:selection.effort};
}
module.exports={controlRead,readModelAvailability,assertModelAvailable};
