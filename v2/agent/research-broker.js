'use strict';

// Caller supplies navigation-owned pages. Imports never launch a browser/service.
const {sourceLink}=require('../market/gmgn');
const {coinIdentity,collectTokenFromPage,tokenForPacket}=require('./token-evidence');
const {collectXFromPage}=require('./x-browser-source');
const {sourceForPacket,sameXSource}=require('./x-evidence');
const {observeTokenResponses,requestTokenDepthFromPage}=require('./token-network-evidence');
const clone=x=>JSON.parse(JSON.stringify(x));
function validateRequest(request){
  if(!request||!['gmgn_token','x_link','x_search','browser'].includes(request.kind)||typeof request.input!=='string'||
    !request.input.trim()||request.input.length>1000||typeof request.reason!=='string'||!request.reason.trim())throw Error('RESEARCH_REQUEST_INVALID');
  if(request.kind==='gmgn_token')return{service:'gmgn',coin:coinIdentity(request.input)};
  if(request.kind==='x_search')return{service:'x',url:'https://x.com/search?q='+encodeURIComponent(request.input)+'&f=live',request:clone(request)};
  const privateRoutes=new Set(['notifications','messages','compose','account','bookmarks','premium','premium_sign_up','logout','subscriptions','monetization','verified_orgs']);
  let pathname;try{pathname=new URL(request.input).pathname;}catch{throw Error('UNSUPPORTED_RESEARCH_SOURCE');}
  if(privateRoutes.has(pathname.split('/')[1]?.toLowerCase()))throw Error('PRIVATE_X_ROUTE_NOT_ALLOWED');
  const link=sourceLink(request.input);if(!link.canonical_url)throw Error('UNSUPPORTED_RESEARCH_SOURCE');
  return{service:'x',url:link.canonical_url,request:{...request,kind:'x_link'}};
}
function createResearchBroker({acquirePage=null,xApi=null,now=()=>Date.now(),collectToken=collectTokenFromPage,acquireTimeoutMs=30000}={}){
  if(!Number.isInteger(acquireTimeoutMs)||acquireTimeoutMs<1||acquireTimeoutMs>45000)throw Error('BROWSER_ACQUIRE_TIMEOUT_INVALID');
  let busy=false,faulted=false;
  const capabilities={gmgn:acquirePage?'CALLER_OWNED_PAGE':'UNAVAILABLE',x_api:xApi?'CALLER_CONFIGURED':'UNAVAILABLE',
    x_browser:acquirePage?'CALLER_OWNED_PAGE':'UNAVAILABLE',browser:acquirePage?'CALLER_OWNED_X_PAGE':'UNAVAILABLE',execution:'UNAVAILABLE'};
  const fault=()=>{faulted=true;for(const key of ['gmgn','x_api','x_browser','browser'])capabilities[key]='UNAVAILABLE_LEASE_UNRESOLVED';};
  async function collect(request){
    const result={request:clone(request??null),status:'UNVERIFIED',reason:null,sources:[],token_evidence:[],attempts:[],collected_at:null};
    let target;try{target=validateRequest(request);}catch{result.reason='UNSUPPORTED_OR_INVALID_REQUEST';return result;}
    if(faulted||busy){result.reason=faulted?'BROWSER_LEASE_UNRESOLVED':'RESEARCH_BROKER_BUSY';return result;}
    busy=true;let lease,network,owned=false;
    try{
      if(target.service==='x'&&request.kind!=='browser'&&xApi){
        try{const source=sourceForPacket(await xApi(target.request),now());
          const matches=target.request.kind==='x_search'?source.request.kind==='x_search'&&source.request.input===target.request.input:
            source.request.kind==='x_link'&&sameXSource(sourceLink(source.request.input),sourceLink(target.request.input));
          if(!matches){result.reason='X_API_SOURCE_MISMATCH';result.attempts.push({transport:'LOCAL_X_API',status:'UNVERIFIED',reason:result.reason,source_id:source.id});return result;}
          result.sources.push(source);
          result.attempts.push({transport:'LOCAL_X_API',status:source.status,reason:source.reason,source_id:source.id});
          if(source.qualified){result.status='COLLECTED';return result;}
        }catch{result.reason='X_API_UNAVAILABLE';result.attempts.push({transport:'LOCAL_X_API',status:'UNVERIFIED',reason:result.reason});}
      }
      if(!acquirePage){result.reason='OWNED_BROWSER_NOT_CONFIGURED';result.attempts.push({transport:'OWNED_BROWSER',status:'UNAVAILABLE',reason:result.reason});return result;}
      let expired=false,timer;
      const acquisition=Promise.resolve().then(()=>acquirePage({service:target.service,coin_id:target.coin?.coin_id??null}));
      acquisition.then(late=>{
        if(expired&&late?.owned===true&&typeof late.release==='function')Promise.resolve().then(()=>late.release()).catch(()=>{});
      },()=>{});
      try{lease=await Promise.race([acquisition,new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(Error('ACQUIRE_TIMEOUT'));},acquireTimeoutMs);})]);}
      catch(error){
        fault();result.reason='BROWSER_LEASE_ACQUIRE_FAILED_OR_TIMED_OUT';
        result.attempts.push({transport:'OWNED_BROWSER',status:'UNAVAILABLE',reason:/^[A-Z][A-Z0-9_]{1,100}$/.test(error.message)?error.message:'BROWSER_LEASE_ACQUISITION_FAILED'});
        return result;
      }
      finally{clearTimeout(timer);}
      if(lease?.owned!==true||!lease.page||typeof lease.release!=='function'){
        fault();result.reason='NAVIGATION_OWNED_PAGE_REQUIRED';return result;
      }
      owned=true;const page=lease.page;
      if(target.service==='gmgn'){
        const coin=target.coin;network=observeTokenResponses(page,coin,{now});
        if(page.url()===coin.url)await page.reload({waitUntil:'domcontentloaded',timeout:30000});
        else await page.goto(coin.url,{waitUntil:'domcontentloaded',timeout:30000});
        await page.waitForFunction(({address,evm})=>{
          const rendered=document.querySelector('#token-base-address')?.getAttribute('data-addr');
          return(evm?rendered?.toLowerCase():rendered)===address;
        },{address:coin.address,evm:coin.chain==='robinhood'},{timeout:15000});
        await page.waitForFunction(()=>Array.from(document.querySelectorAll('[data-sentry-component="BaseInfoBar"] .info-item-value'))
          .some(e=>e.textContent.includes('$')),{}, {timeout:8000});
        const evidence=await collectToken({page,coinId:coin.coin_id,now,networkCapture:()=>network.finish(),
          prepareDepth:async({creatorAddress})=>{
            if(creatorAddress)network.setCreator(creatorAddress);
            return requestTokenDepthFromPage(page,coin,creatorAddress,{reuse:(kind,query)=>network.hasObservation(kind,query)});
          }});
        tokenForPacket(evidence,[],now());result.token_evidence.push(evidence);result.status='COLLECTED';result.reason=null;
        result.attempts.push({transport:'OWNED_GMGN_PAGE',status:'COLLECTED',evidence_id:evidence.id});
      }else{
        if(page.url()===target.url)await page.reload({waitUntil:'domcontentloaded',timeout:30000});
        else await page.goto(target.url,{waitUntil:'domcontentloaded',timeout:30000});
        const expected=sourceLink(target.request.input);
        await page.waitForFunction(({author,postId})=>Array.from(document.querySelectorAll('article[data-testid="tweet"]')).some(a=>{
          const href=a.querySelector('time')?.closest('a[href]')?.getAttribute('href')??'';
          const m=/\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/.exec(href);
          return m&&(!author||m[1].toLowerCase()===author.toLowerCase())&&(!postId||m[2]===postId)&&a.querySelector('[data-testid="tweetText"]')?.textContent?.trim();
        }),{author:expected.author??null,postId:expected.post_id??null},{timeout:12000});
        const source=await collectXFromPage({page,request:target.request,now});result.sources.push(source);
        result.attempts.push({transport:'OWNED_X_PAGE',status:source.status,reason:source.reason,source_id:source.id});
        result.status=source.qualified?'COLLECTED':'UNVERIFIED';result.reason=source.reason;
      }
    }catch(e){result.reason=/^[A-Z][A-Z0-9_]{1,100}$/.test(e.message)?e.message:'RESEARCH_SOURCE_UNAVAILABLE';}
    finally{
      if(network)await network.finish().catch(()=>{});
      if(owned)try{await lease.release();}catch{fault();result.status='UNVERIFIED';result.reason='BROWSER_LEASE_RELEASE_FAILED';}
      result.collected_at=new Date(now()).toISOString();busy=false;
    }
    return result;
  }
  return{capabilities,collect};
}
module.exports={createResearchBroker,validateRequest};
