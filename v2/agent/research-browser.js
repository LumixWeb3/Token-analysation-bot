'use strict';
// Browser operations are fixed host code, never model-supplied JavaScript.
// The caller owns the dedicated persistent Playwright context and its lifetime.
const dns=require('node:dns').promises,crypto=require('node:crypto'),{isIP}=require('node:net');
const {publicHttpsUrl,buildWebSource}=require('./web-evidence');
const EXPAND=/^(?:show more|read more|view more|show replies|more replies|show this thread)$/i;
function publicAddress(ip){
  if(isIP(ip)===4){const [a,b,c]=ip.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===2)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);}
  // Conservative global-unicast IPv6 only; deny documentation and transition ranges.
  return isIP(ip)===6&&/^[23][0-9a-f]{3}:/i.test(ip)&&!/^2001:(?:0:|db8:|10:|20:)/i.test(ip)&&!/^2002:/i.test(ip);
}
function researchUrl(raw){
  const url=new URL(publicHttpsUrl(raw));let pathname=url.pathname;
  try{for(let i=0;i<3;i++)pathname=decodeURIComponent(pathname);}catch{throw Error('BROWSER_ROUTE_NOT_ALLOWED');}
  if(/(?:^|\/)(?:account|accounts|admin|settings|messages|notifications|compose|login|logout|signin|signup|wallet|wallets|trade|swap|connect)(?:\/|$)/i.test(pathname))throw Error('BROWSER_ROUTE_NOT_ALLOWED');
  return url.href;
}
function createOwnedBrowserController({acquirePage,now=()=>Date.now(),lookup=(host)=>dns.lookup(host,{all:true,verbatim:true}),acquireTimeoutMs=30000}={}){
  if(typeof acquirePage!=='function')throw Error('OWNED_BROWSER_ACQUIRE_REQUIRED');
  if(!Number.isInteger(acquireTimeoutMs)||acquireTimeoutMs<1||acquireTimeoutMs>45000)throw Error('BROWSER_ACQUIRE_TIMEOUT_INVALID');
  let busy=false,faulted=false,snapshot=null;
  async function destination(raw){const url=researchUrl(raw),addresses=await lookup(new URL(url).hostname);if(!Array.isArray(addresses)||!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw Error('BROWSER_DESTINATION_NOT_PUBLIC');return url;}
  async function perform(args){
    if(busy||faulted)throw Error(faulted?'BROWSER_LEASE_UNRESOLVED':'RESEARCH_BROWSER_BUSY');busy=true;
    let lease,owned=false,route,routeOwner,expired=false,timer;const started=new Date(now()).toISOString(),redirects=[];
    const result={request:{kind:'web_page',input:args.url??snapshot?.url??'',reason:args.reason},status:'UNVERIFIED',reason:null,sources:[],token_evidence:[],attempts:[]};
    try{
      if(!['navigate','read','follow','expand','scroll'].includes(args.action)||typeof args.reason!=='string'||!args.reason.trim())throw Error('RESEARCH_BROWSER_ARGUMENTS');
      const acquisition=Promise.resolve().then(()=>acquirePage({service:'web'}));
      acquisition.then(late=>{if(expired&&late?.owned===true&&typeof late.release==='function')Promise.resolve().then(()=>late.release()).catch(()=>{});},()=>{});
      try{lease=await Promise.race([acquisition,new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(Error('BROWSER_ACQUIRE_TIMEOUT'));},acquireTimeoutMs);})]);}
      catch{faulted=true;throw Error('BROWSER_LEASE_ACQUIRE_FAILED');}finally{clearTimeout(timer);}
      if(lease?.owned!==true||!lease.page||typeof lease.release!=='function'){faulted=true;throw Error('NAVIGATION_OWNED_PAGE_REQUIRED');}owned=true;
      const page=lease.page;
      route=async intercepted=>{try{
        const request=intercepted.request(),url=request.url();
        if(url.startsWith('data:')||url.startsWith('blob:')){await intercepted.abort();return;}
        // Guard every request, including redirect destinations and subresources.
        await destination(url);if(!['GET','HEAD','OPTIONS'].includes(request.method()))throw Error('BROWSER_WRITE_REQUEST_BLOCKED');
        if(request.isNavigationRequest()&&request.frame()===page.mainFrame())redirects.push(url);
        await intercepted.continue();
      }catch{await intercepted.abort().catch(()=>{});}};
      // Context routing also covers new popup requests. The dedicated context
      // must disable service workers; those can bypass Playwright routing.
      routeOwner=typeof page.context==='function'?page.context():page;
      await routeOwner.route('**/*',route);
      if(args.action==='navigate'){
        const url=await destination(args.url);result.request.input=url;redirects.push(url);
        await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});snapshot=null;
      }else{
        if(!snapshot||args.snapshot_id!==snapshot.id||page!==snapshot.page||page.url()!==snapshot.url)throw Error('BROWSER_SNAPSHOT_STALE');
        result.request.input=snapshot.url;
        if(args.action==='follow'){
          const link=snapshot.links.find(l=>l.node_id===args.node_id);if(!link)throw Error('BROWSER_NODE_INVALID');
          const url=await destination(link.url);result.request.input=url;redirects.push(url);
          await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
        }else if(args.action==='expand'){
          const button=snapshot.expanders.find(b=>b.node_id===args.node_id);if(!button)throw Error('BROWSER_NODE_INVALID');
          const locator=page.locator('button').nth(button.index),text=await locator.innerText({timeout:3000});
          if(text.trim()!==button.text||!EXPAND.test(text.trim()))throw Error('BROWSER_NODE_STALE');
          await locator.click({timeout:5000});
        }else if(args.action==='scroll')await page.evaluate(()=>window.scrollBy({top:Math.min(window.innerHeight,1200),behavior:'instant'}));
      }
      const final=await destination(page.url());
      const capture=await page.evaluate(()=>{
        const text=(document.body?.innerText??'');
        return{text:text.slice(0,60000),text_bounded:text.length>60000,
          links:Array.from(document.querySelectorAll('a[href]')).slice(0,200).map((a,index)=>({index,text:a.innerText??'',url:a.href})),
          links_bounded:document.querySelectorAll('a[href]').length>200,
          buttons:Array.from(document.querySelectorAll('button')).map((b,index)=>({index,text:(b.innerText??'').trim()}))};
      });
      const links=[];for(const link of capture.links){try{const url=researchUrl(link.url);links.push({node_id:'link-'+link.index,text:link.text.slice(0,10000),url});}catch{}}
      const expanders=capture.buttons.filter(b=>EXPAND.test(b.text)).slice(0,30).map(b=>({node_id:'expand-'+b.index,...b}));
      const id=crypto.randomUUID(),bounded=capture.text_bounded||capture.links_bounded;
      const requested=result.request.input;
      if(page.url()!==final)throw Error('BROWSER_CHANGED_DURING_CAPTURE');
      if(requested!==final){
        if(redirects[0]!==requested)redirects.unshift(requested);
        if(redirects.at(-1)!==final)throw Error('BROWSER_FINAL_URL_CHANGED_WITHOUT_REQUEST');
      }
      const source=buildWebSource({request:result.request,transport:'PLAYWRIGHT_DOM',capture_started_at:started,collected_at:new Date(now()).toISOString(),
        requested_url:requested,final_url:final,redirect_chain:redirects,
        blocks:[{type:'paragraph',text:capture.text,url:null},...links.map(l=>({type:'link',text:l.text,url:l.url}))],
        coverage:{scope:'VISIBLE_DOM',status:bounded?'PARTIAL_BOUNDED':'COMPLETE_VISIBLE_CAPTURE',bounded,omitted_count:bounded?null:0,
          note:'Visible body text and public links only. Hidden content, media, network JSON and replies are not asserted complete; unsafe links are excluded from controls.'}});
      snapshot={id,url:final,page,links,expanders};
      result.sources.push(source);result.status=source.qualified?'COLLECTED':'UNVERIFIED';result.reason=source.reason;
      result.snapshot={id,url:final,links,expanders};result.attempts.push({transport:'PLAYWRIGHT_DOM',source_id:source.id,status:source.status});
    }catch(e){result.reason=/^[A-Z][A-Z0-9_:]{1,100}$/.test(e.message)?e.message:'PUBLIC_BROWSER_SOURCE_UNAVAILABLE';}
    finally{
      if(owned){if(route&&routeOwner)try{await routeOwner.unroute('**/*',route);}catch{faulted=true;}
        try{await lease.release();}catch{faulted=true;}
        if(faulted){result.status='UNVERIFIED';result.reason='BROWSER_LEASE_RELEASE_FAILED';snapshot=null;}}
      result.collected_at=new Date(now()).toISOString();busy=false;
    }
    return result;
  }
  return{perform};
}
module.exports={createOwnedBrowserController,publicAddress,researchUrl};
