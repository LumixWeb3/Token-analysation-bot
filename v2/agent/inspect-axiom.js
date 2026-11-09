'use strict';

// Owner-triggered visible login/research window. First pass records endpoint
// metadata only: never headers, cookies, query values, bodies or WS frames.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
async function manualLogin(){
  return require('./browser-login').openBrowserLogin({site:'axiom'});
}
async function inspect(){
  if(os.freemem()<2.25*1024**3)throw Error('AXIOM_RAM_RESERVE');
  const {chromium}=require('playwright'),{launchManagedPersistentContext}=require('../../gmgn-browser-profile');
  const output=path.resolve(__dirname,'../../v2-runtime/axiom-'+crypto.randomUUID());fs.mkdirSync(output,{recursive:true});
  const managed=await launchManagedPersistentContext({chromium,role:'v2-axiom-inspection',chain:'solana',profileName:'axiom-research',headless:false});
  const routes=new Map();let closed=false;
  function publicRoute(raw){
    let url;try{url=new URL(raw);}catch{return null;}
    if(url.protocol!=='https:'||!(url.hostname==='axiom.trade'||url.hostname.endsWith('.axiom.trade')))return null;
    if(/(?:^|\/)(?:auth|login|logout|signin|signup|session|account|accounts|user|users|me|portfolio|balance|balances|orders|settings|withdraw|deposit|transaction|transactions|trade|trades|rpc)(?:\/|$)/i.test(url.pathname))return null;
    const pathname=url.pathname.split('/').map(part=>part.length>90?'[opaque]':part).join('/');
    return{host:url.hostname,path:pathname};
  }
  managed.context.on('page',watch);function watch(page){page.on('response',response=>{
    const route=publicRoute(response.url());if(!route||routes.size>=150)return;
    const contentType=(response.headers()['content-type']??'').split(';')[0];if(!/json|event-stream/.test(contentType))return;
    const item={...route,method:response.request().method(),status:response.status(),content_type:contentType,observed_at:new Date().toISOString()};
    routes.set(route.host+route.path, item);fs.writeFileSync(path.join(output,'public-route-inventory.json'),JSON.stringify([...routes.values()],null,2));
  });}
  for(const page of managed.context.pages())watch(page);
  managed.context.once('close',()=>{closed=true;});
  try{
    await managed.page.goto('https://axiom.trade',{waitUntil:'domcontentloaded',timeout:30000}).catch(()=>{});
    process.stdout.write(JSON.stringify({status:'LOGIN_WINDOW_OPEN',profile:'axiom-research',output_dir:output,capture:'PUBLIC_ROUTE_METADATA_ONLY',trading_enabled:false})+'\n');
    // Keep the owner login window alive; close it normally to release its profile.
    while(!closed){if(os.freemem()<1*1024**3)throw Error('AXIOM_RAM_PRESSURE');await new Promise(resolve=>setTimeout(resolve,1000));}
  }finally{await managed.close();}
}
if(require.main===module){const args=process.argv.slice(2);if(args.length!==1||!['--open','--manual-login'].includes(args[0])){process.stderr.write('Explicit --open or --manual-login required.\n');process.exitCode=1;}else(args[0]==='--manual-login'?manualLogin():inspect()).catch(e=>{process.stderr.write(/^AXIOM_[A-Z_]+$/.test(e.message)?e.message+'\n':'AXIOM_WINDOW_UNAVAILABLE\n');process.exitCode=1;});}
module.exports={inspect,manualLogin};
