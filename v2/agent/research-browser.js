'use strict';
// Browser operations are fixed host code, never model-supplied JavaScript.
// The caller owns the dedicated persistent Playwright context and its lifetime.
const dns=require('node:dns').promises,crypto=require('node:crypto'),{isIP}=require('node:net');
const {publicHttpsUrl,buildWebSource}=require('./web-evidence');
const EXPAND=/^(?:show more|read more|view more|show replies|more replies|show this thread)$/i;
const READING_CONTROL=/^(?:menu|open menu|close|search|filters?|next(?: page)?|previous(?: page)?|load more|show more|read more|view more|show replies|more replies|show this thread|holders(?:\s*\(\d+\))?|top traders|early buyers|dev tokens(?:\s*\(\d+\))?|trades|all|trending|discover|pulse|24h|7d)$/i;
async function hasCaptcha(page){
  const result=await page.evaluate(()=>({challenge:Array.from(document.querySelectorAll('iframe[src*="challenges.cloudflare.com"],iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="arkoselabs"],.cf-turnstile')).some(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';})}));
  return result?.challenge===true;
}
function publicAddress(ip){
  if(isIP(ip)===4){const [a,b,c]=ip.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0&&(c===0||c===2))||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);}
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
    let lease,owned=false,route,routeOwner,navigationListener,frameListener,expired=false,timer;const started=new Date(now()).toISOString(),redirects=[];
    const result={request:{kind:'web_page',input:args.url??snapshot?.url??'',reason:args.reason},status:'UNVERIFIED',reason:null,sources:[],token_evidence:[],attempts:[]};
    try{
      if(!['navigate','read','follow','expand','scroll','click','fill'].includes(args.action)||typeof args.reason!=='string'||!args.reason.trim())throw Error('RESEARCH_BROWSER_ARGUMENTS');
      const acquisition=Promise.resolve().then(()=>acquirePage({service:'web'}));
      acquisition.then(late=>{if(expired&&late?.owned===true&&typeof late.release==='function')Promise.resolve().then(()=>late.release()).catch(()=>{});},()=>{});
      try{lease=await Promise.race([acquisition,new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(Error('BROWSER_ACQUIRE_TIMEOUT'));},acquireTimeoutMs);})]);}
      catch{faulted=true;throw Error('BROWSER_LEASE_ACQUIRE_FAILED');}finally{clearTimeout(timer);}
      if(lease?.owned!==true||!lease.page||typeof lease.release!=='function'){faulted=true;throw Error('NAVIGATION_OWNED_PAGE_REQUIRED');}owned=true;
      const page=lease.page;
      // Playwright route handlers can skip later hops of a redirect. Record
      // actual main-frame requests separately so the source chain stays exact.
      navigationListener=request=>{try{
        if(request.isNavigationRequest()&&request.frame()===page.mainFrame())redirects.push(researchUrl(request.url()));
      }catch{}};
      frameListener=frame=>{try{if(frame===page.mainFrame())redirects.push(researchUrl(frame.url()));}catch{}};
      if(typeof page.on==='function'){page.on('request',navigationListener);page.on('framenavigated',frameListener);}
      route=async intercepted=>{try{
        const request=intercepted.request(),url=request.url();
        if(url.startsWith('data:')||url.startsWith('blob:')){await intercepted.abort();return;}
        // Screen intercepted requests. Final destinations are checked again
        // before capture; deployment still needs an independent network boundary.
        const parsed=new URL(url),method=request.method();
        const authRefresh=method==='POST'&&/^api\d*\.axiom\.trade$/.test(parsed.hostname)&&parsed.pathname==='/refresh-access-token';
        await destination(url);if(!['GET','HEAD','OPTIONS'].includes(method)&&!authRefresh)throw Error('BROWSER_WRITE_REQUEST_BLOCKED');
        if(request.isNavigationRequest()&&request.frame()===page.mainFrame())redirects.push(url);
        await intercepted.continue();
      }catch{await intercepted.abort().catch(()=>{});}};
      // Context routing also covers new popup requests. The dedicated context
      // must disable service workers; those can bypass Playwright routing.
      routeOwner=typeof page.context==='function'?page.context():page;
      await routeOwner.route('**/*',route);
      if(await hasCaptcha(page)){snapshot=null;result.status='ACTION_REQUIRED';result.reason='CAPTCHA_CONFIRMATION_REQUIRED';return result;}
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
        }else if(args.action==='click'){
          const button=snapshot.controls.find(b=>b.node_id===args.node_id);if(!button||!READING_CONTROL.test(button.text))throw Error('BROWSER_NODE_INVALID');
          const locator=page.locator('button').nth(button.index);
          const label=(await locator.innerText({timeout:3000})).trim()||(await locator.getAttribute('aria-label')??'').trim();
          if(label!==button.text)throw Error('BROWSER_NODE_STALE');
          await locator.scrollIntoViewIfNeeded({timeout:3000});
          const box=await locator.boundingBox();if(!box)throw Error('BROWSER_NODE_NOT_VISIBLE');
          if(page.mouse)await page.mouse.move(box.x+box.width/2,box.y+box.height/2,{steps:8});
          await locator.click({timeout:5000});
        }else if(args.action==='fill'){
          const input=snapshot.search_fields.find(field=>field.node_id===args.node_id);
          if(!input||typeof args.text!=='string'||!args.text.trim()||args.text.length>1000)throw Error('BROWSER_SEARCH_FIELD_INVALID');
          const locator=page.locator('input').nth(input.index);
          const type=(await locator.getAttribute('type')??'text').toLowerCase();
          const label=[await locator.getAttribute('role'),await locator.getAttribute('aria-label'),await locator.getAttribute('placeholder')].join(' ');
          if(!['text','search'].includes(type)||type!=='search'&&!/search/i.test(label))throw Error('BROWSER_NODE_STALE');
          await locator.fill(args.text,{timeout:5000});await locator.press('Enter',{timeout:5000});
        }else if(args.action==='expand'){
          const button=snapshot.expanders.find(b=>b.node_id===args.node_id);if(!button)throw Error('BROWSER_NODE_INVALID');
          const locator=page.locator('button').nth(button.index),text=await locator.innerText({timeout:3000});
          if(text.trim()!==button.text||!EXPAND.test(text.trim()))throw Error('BROWSER_NODE_STALE');
          await locator.click({timeout:5000});
        }else if(args.action==='scroll')await page.evaluate(()=>window.scrollBy({top:Math.min(window.innerHeight,1200),behavior:'instant'}));
      }
      const final=await destination(page.url());
      if(await hasCaptcha(page)){snapshot=null;result.status='ACTION_REQUIRED';result.reason='CAPTCHA_CONFIRMATION_REQUIRED';return result;}
      const host=new URL(final).hostname;
      if(typeof page.waitForSelector==='function'&&['x.com','www.x.com','twitter.com','www.twitter.com'].includes(host))
        await page.waitForSelector('main',{state:'attached',timeout:15000});
      if(typeof page.waitForFunction==='function'&&host==='axiom.trade')
        await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(e=>/^Holders\s*\(/.test(e.textContent.trim())),{},{timeout:15000});
      const capture=await page.evaluate(()=>{
        let root=document.body,scoped=false;
        if(/^(?:www\.)?(?:x|twitter)\.com$/.test(location.hostname)){
          root=document.querySelector('main');scoped=true;
        }else if(location.hostname==='axiom.trade'){
          const holders=Array.from(document.querySelectorAll('button')).find(e=>/^Holders\s*\(/.test(e.textContent.trim()));
          root=holders?.parentElement;scoped=true;
          while(root&&root!==document.body){
            const text=root.innerText??'';
            if(['Wallet','Funding','Remaining'].every(label=>text.includes(label))&&!/Advanced Trading Strategy|Make a callout/.test(text))break;
            root=root.parentElement;
          }
          if(root===document.body)root=null;
        }
        if(!root)throw Error('BROWSER_PUBLIC_SCOPE_UNAVAILABLE');
        const text=(root.innerText??'');
        const allButtons=Array.from(document.querySelectorAll('button'));
        return{text:text.slice(0,60000),text_bounded:scoped||text.length>60000,scoped,
          links:Array.from(root.querySelectorAll('a[href]')).slice(0,200).map((a,index)=>({index,text:a.innerText??'',url:a.href})),
          links_bounded:root.querySelectorAll('a[href]').length>200,
          buttons:allButtons.map((b,index)=>({index,text:(b.innerText??'').trim()||(b.getAttribute('aria-label')??'').trim(),included:root.contains(b)})).filter(b=>b.included),
          search_fields:Array.from(document.querySelectorAll('input')).map((input,index)=>({index,type:(input.type||'text').toLowerCase(),label:[input.getAttribute('role'),input.getAttribute('aria-label'),input.getAttribute('placeholder')].join(' '),included:root.contains(input)})).filter(input=>input.included&&['search','text'].includes(input.type)&&(input.type==='search'||/search/i.test(input.label)))};
      });
      const links=[];for(const link of capture.links){try{const url=researchUrl(link.url);links.push({node_id:'link-'+link.index,text:link.text.slice(0,10000),url});}catch{}}
      const expanders=capture.buttons.filter(b=>EXPAND.test(b.text)).slice(0,30).map(b=>({node_id:'expand-'+b.index,...b}));
      const controls=capture.buttons.filter(b=>READING_CONTROL.test(b.text)).slice(0,40).map(b=>({node_id:'button-'+b.index,...b}));
      const search_fields=(capture.search_fields??[]).slice(0,10).map(input=>({node_id:'search-'+input.index,...input}));
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
          note:capture.scoped?'Selected public research content only. X uses its main content and Axiom its holders panel. Coverage is partial; wallet balances, account menus and trading panels are outside this capture.':
            'Visible body text and public links only. Hidden content, media, network JSON and replies are not asserted complete; unsafe links are excluded from controls.'}});
      snapshot={id,url:final,page,links,expanders,controls,search_fields};
      result.sources.push(source);result.status=source.qualified?'COLLECTED':'UNVERIFIED';result.reason=source.reason;
      result.snapshot={id,url:final,links,expanders,controls,search_fields};result.attempts.push({transport:'PLAYWRIGHT_DOM',source_id:source.id,status:source.status});
    }catch(e){
      if(owned&&await hasCaptcha(lease.page).catch(()=>false)){snapshot=null;result.status='ACTION_REQUIRED';result.reason='CAPTCHA_CONFIRMATION_REQUIRED';}
      else result.reason=/^[A-Z][A-Z0-9_:]{1,100}$/.test(e.message)?e.message:'PUBLIC_BROWSER_SOURCE_UNAVAILABLE';
    }
    finally{
      if(owned){if(route&&routeOwner)try{await routeOwner.unroute('**/*',route);}catch{faulted=true;}
        if(navigationListener&&typeof lease.page.off==='function')lease.page.off('request',navigationListener);
        if(frameListener&&typeof lease.page.off==='function')lease.page.off('framenavigated',frameListener);
        try{await lease.release();}catch{faulted=true;}
        if(faulted){result.status='UNVERIFIED';result.reason='BROWSER_LEASE_RELEASE_FAILED';snapshot=null;}}
      result.collected_at=new Date(now()).toISOString();busy=false;
    }
    return result;
  }
  return{perform};
}
module.exports={createOwnedBrowserController,publicAddress,researchUrl};
