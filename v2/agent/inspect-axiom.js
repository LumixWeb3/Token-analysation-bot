'use strict';

// Owner-triggered visible login/research window. First pass records endpoint
// metadata only: never headers, cookies, query values, bodies or WS frames.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
async function manualLogin(){
  return require('./browser-login').openBrowserLogin({site:'axiom'});
}
async function inspect({mint=null,seconds=null}={}){
  const {publicTokenRoute,observeAxiomTokenResponses}=require('./axiom-token-evidence');
  if(mint!==null)publicTokenRoute('https://sol-api1.axiom.trade/token-info-v2?tokenAddress='+mint,mint);
  if(seconds!==null&&(!Number.isInteger(seconds)||seconds<5||seconds>60))throw Error('AXIOM_DURATION_INVALID');
  if(os.freemem()<2.25*1024**3)throw Error('AXIOM_RAM_RESERVE');
  const {chromium}=require('playwright'),{launchManagedPersistentContext}=require('../../gmgn-browser-profile');
  const output=path.resolve(__dirname,'../../v2-runtime/axiom-'+crypto.randomUUID());fs.mkdirSync(output,{recursive:true});
  const managed=await launchManagedPersistentContext({chromium,role:'v2-axiom-inspection',chain:'solana',profileName:'axiom-research',headless:false});
  const routes=new Map();let closed=false,metadataFailure=false;
  const tokenCapture=mint?observeAxiomTokenResponses(managed.page,mint):null;
  function publicRoute(raw){
    let url;try{url=new URL(raw);}catch{return null;}
    if(url.protocol!=='https:'||!/^sol-api\d*\.axiom\.trade$/.test(url.hostname))return null;
    if(!['/token-and-best-pair-info','/token-info-v2','/token-chart','/token-stats','/dev-transfers','/dev-tokens','/kol-transactions'].includes(url.pathname))return null;
    const pathname=url.pathname.split('/').map(part=>part.length>90?'[opaque]':part).join('/');
    return{host:url.hostname,path:pathname};
  }
  managed.context.on('page',watch);function watch(page){page.on('response',response=>{
    try{
    const route=publicRoute(response.url());if(!route||routes.size>=150)return;
    const contentType=(response.headers()['content-type']??'').split(';')[0];if(!/json|event-stream/.test(contentType))return;
    const item={...route,method:response.request().method(),status:response.status(),content_type:contentType,observed_at:new Date().toISOString()};
    routes.set(route.host+route.path, item);fs.writeFileSync(path.join(output,'public-route-inventory.json'),JSON.stringify([...routes.values()],null,2));
    }catch{metadataFailure=true;}
  });}
  for(const page of managed.context.pages())watch(page);
  managed.context.once('close',()=>{closed=true;});
  try{
    const target=mint?'https://axiom.trade/token/'+mint+'?chain=sol':'https://axiom.trade';
    await managed.page.goto(target,{waitUntil:'domcontentloaded',timeout:30000}).catch(()=>{});
    process.stdout.write(JSON.stringify({status:mint?'TOKEN_PROBE_RUNNING':'INSPECTION_WINDOW_OPEN',profile:'axiom-research',output_dir:output,capture:mint?'EXPLICIT_PUBLIC_TOKEN_FIELDS':'PUBLIC_ROUTE_METADATA_ONLY',trading_enabled:false})+'\n');
    // Keep the owner login window alive; close it normally to release its profile.
    const deadline=seconds===null?Infinity:Date.now()+seconds*1000;
    while(!closed&&Date.now()<deadline){if(metadataFailure)throw Error('AXIOM_INVENTORY_WRITE_FAILED');if(os.freemem()<1.5*1024**3)throw Error('AXIOM_RAM_PRESSURE');await new Promise(resolve=>setTimeout(resolve,500));}
    if(tokenCapture){
      const captured=await tokenCapture.finish();
      fs.writeFileSync(path.join(output,'token-public-evidence.json'),JSON.stringify(captured,null,2));
      const result={output_dir:output,observations:captured.observations.length,failures:captured.failures,
        token_identity_verified:captured.observations.some(o=>o.identity_basis==='EXACT_REQUEST_AND_RESPONSE_TOKEN'),
        holder_aggregates_observed:captured.observations.some(o=>o.raw_public.holderStats),
        qualified_scope:'PUBLIC_TOKEN_METADATA_AND_HOLDER_AGGREGATES_ONLY',top20:'UNVERIFIED',trading_enabled:false};
      process.stdout.write(JSON.stringify(result)+'\n');
      return result;
    }
  }finally{if(tokenCapture)await tokenCapture.finish();await managed.close();}
}
if(require.main===module){
  const args=process.argv.slice(2),arg=args[0];
  if(args.length!==1||!['--open','--manual-login'].includes(arg)&&!arg?.startsWith('--probe-token=')){
    process.stderr.write('Explicit --open, --manual-login or --probe-token=SOLANA_MINT required.\n');process.exitCode=1;
  }else{
    const action=arg==='--manual-login'?manualLogin():inspect(arg.startsWith('--probe-token=')?{mint:arg.slice(14),seconds:20}:{});
    action.then(result=>{if(arg.startsWith('--probe-token=')&&(!result?.token_identity_verified||!result?.holder_aggregates_observed))process.exitCode=1;})
      .catch(e=>{process.stderr.write(/^AXIOM_[A-Z_]+$/.test(e.message)?e.message+'\n':'AXIOM_WINDOW_UNAVAILABLE\n');process.exitCode=1;});
  }
}
module.exports={inspect,manualLogin};
