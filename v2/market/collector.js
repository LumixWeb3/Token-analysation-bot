'use strict';

// One normal saved-profile Chrome, one page, public market endpoints only.
// Explicit live opt-in. No V1 scanner, model, account, cookie export or trade API.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {FeedBook,PATHS,CHANNELS,SCOPE,hash}=require('./network-feed');
const {containsPrivateKeys,route}=require('./network-probe');

function atomic(file,value){const temporary=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temporary,JSON.stringify(value),{flag:'wx'});fs.renameSync(temporary,file);}
function safeBody(bytes){
  if(bytes.length>4*1024*1024)throw Error('PUBLIC_RESPONSE_OVERSIZE');
  let b;try{b=JSON.parse(bytes.toString('utf8'));}catch{throw Error('PUBLIC_RESPONSE_MALFORMED_JSON');}
  if(!b||typeof b!=='object'||Array.isArray(b))throw Error('PUBLIC_RESPONSE_INVALID_SHAPE');
  if(containsPrivateKeys(b))throw Error('PRIVATE_RESPONSE_REJECTED');return b;
}
function stripImages(raw){
  if(Array.isArray(raw))return raw.map(stripImages);
  if(raw&&typeof raw==='object')return Object.fromEntries(Object.entries(raw).filter(([k])=>!['ls_b64','ri_p','ri_a','ri_b','ri_ma','ri_mb'].includes(k)).map(([k,v])=>[k,stripImages(v)]));
  return raw;
}
function retryAllowed(reason,failures){
  return failures<3&&!/^PUBLIC_HTTP_(?:401|403|429)|BROWSER_PAGE_BLOCKED|RETRY_BUDGET_EXHAUSTED/.test(reason??'');
}

function createFatalBoundary(onFatal){
  let failure=null;
  return{get failure(){return failure;},wrap:work=>(...args)=>{
    if(failure)return;
    try{return work(...args);}catch(error){failure=error instanceof Error?error:Error('COLLECTOR_CALLBACK_FAILED');onFatal();}
  }};
}
async function closeCollectorResources(actions,primaryError=null){
  let first=primaryError===null?null:primaryError instanceof Error?primaryError:Error('COLLECTOR_FAILED');
  // A failed projection/journal close must not skip the owned browser or lock.
  for(const close of actions)try{await close();}catch(error){first??=error instanceof Error?error:Error('COLLECTOR_CLEANUP_FAILED');}
  if(first)throw first;
}

// Several website sockets can share the same public URL. Own only the socket
// which actually sends our exact subscription, and ignore obsolete generations.
function attachMarketSocket(socket,feed,{book,currentSockets,receive,unavailable,stopped=()=>false}){
  let state=currentSockets.get(feed);
  if(!state){state={nextGeneration:0,claimedGeneration:0,socket:null};currentSockets.set(feed,state);}
  const generation=++state.nextGeneration;let closed=false;
  const current=()=>state.socket===socket&&state.claimedGeneration===generation;
  socket.on('framesent',event=>{
    if(stopped()||closed||generation<state.claimedGeneration)return;
    let message;try{message=safeBody(Buffer.from(event.payload));}catch{return;}
    if(message.action!=='subscribe'||message.id!=='v2-'+feed||message.channel!==CHANNELS[feed]||!Array.isArray(message.data))return;
    const groups=[...book.groups.values()].filter(g=>g.feed===feed);
    const seen=new Set();
    if(!groups.length||message.data.length!==groups.length||message.data.some(s=>{
      if(!s||typeof s!=='object'||Array.isArray(s))return true;
      const g=groups.find(g=>g.chain===s.chain);
      if(!g||seen.has(s.chain)||s.filter_id!==g.filter_id||s.version!==g.baseline_version)return true;
      seen.add(s.chain);return false;
    }))return;
    state.socket=socket;state.claimedGeneration=generation;book.connection(feed,true);
  });
  socket.on('framereceived',event=>{if(!stopped()&&!closed&&current())receive(feed,event.payload);});
  const ended=reason=>{const notify=!stopped()&&!closed&&current();closed=true;if(notify){book.connection(feed,false);unavailable(feed,reason);}};
  socket.on('close',()=>ended('SOCKET_CLOSED'));
  socket.on('socketerror',()=>ended('SOCKET_ERROR'));
}

async function collect({seconds=60,headless=false,outputDir=path.resolve(__dirname,'../../v2-runtime/market'),signal,onView=()=>{}}={}){
  if(!Number.isInteger(seconds)||seconds<20||seconds>3600)throw Error('LIVE_DURATION_OUT_OF_BOUNDS');
  if(typeof headless!=='boolean')throw Error('INVALID_BROWSER_MODE');
  const {chromium}=require('playwright');
  const {launchManagedPersistentContext}=require('../../gmgn-browser-profile');
  const book=new FeedBook();let managed,cdp,stopping=false,terminalError=null;
  let eventIndex=0,writeAt=0;
  const templates=new Map(),socketEndpoints=new Map(),currentSockets=new Map(),diagnostics=[];
  const active=new Set(),workerRequests=new Map(),refreshFailures={migrated:0,trending:0};
  fs.mkdirSync(outputDir,{recursive:true});
  const evidenceFile=path.join(outputDir,'events.jsonl');
  // Refuse to append an unrelated/restarted session to an old journal.
  const fd=fs.openSync(evidenceFile,'wx');
  const record=(kind,data)=>{
    const event={sequence:++eventIndex,recorded_at:new Date().toISOString(),kind,data:stripImages(data),
      omitted_source_fields:['ls_b64','ri_p','ri_a','ri_b','ri_ma','ri_mb']};
    const line=JSON.stringify({...event,sha256:hash(event)})+'\n';
    fs.writeSync(fd,line);return eventIndex;
  };
  const persist=(force=false)=>{
    if(!force&&Date.now()-writeAt<1000)return;
    writeAt=Date.now();const view=book.view();view.evidence={file:'events.jsonl',last_sequence:eventIndex};
    atomic(path.join(outputDir,'market.json'),view);onView(view);
  };
  const fail=(feed,reason)=>{book.fault(feed,reason);record('source_failure',{feed,reason});persist(true);};
  const sourceFeed=url=>Object.keys(PATHS).find(feed=>route(url)?.path===PATHS[feed]);
  const learn=(url,body)=>{
    const feed=sourceFeed(url);if(!feed||!body?.params||containsPrivateKeys(body))return;
    templates.set(feed,url); // URL stays in memory; telemetry/auth values never enter evidence.
  };
  const receive=(feed,payload)=>{
    if(stopping)return;
    const receivedAt=new Date().toISOString();
    try{
      const bytes=Buffer.isBuffer(payload)?payload:Buffer.from(payload);
      const original=safeBody(bytes),body=stripImages(original);
      if(body.channel!==CHANNELS[feed]&&body.type!=='error')return; // Heartbeat never refreshes token data.
      record('stream',{feed,envelope:body,received_at:receivedAt,source_payload_sha256:hash(original)});const r=book.delta(feed,body,receivedAt);
      if(!r.accepted)diagnostics.push({feed,reason:r.reason});persist();
    }catch(e){fail(feed,e.message);}
  };
  const boundary=createFatalBoundary(()=>{stopping=true;});
  const guardedReceive=boundary.wrap(receive),guardedFail=boundary.wrap(fail);
  try{
    managed=await launchManagedPersistentContext({chromium,role:'v2-network-collector',chain:'solana',profileName:'gmgn-login',headless});
    const {context,page}=managed;
    page.on('websocket',socket=>{
      const r=route(socket.url());const feed=r?.path==='/rrs_ws'?'trending':r?.path==='/trs_ws'?'migrated':null;
      if(feed)socketEndpoints.set(feed,'wss://'+r.host+r.path);
      if(feed)attachMarketSocket(socket,feed,{book,currentSockets,receive:guardedReceive,unavailable:guardedFail,stopped:()=>stopping});
    });
    context.on('request',request=>{
      if(!sourceFeed(request.url()))return;
      try{learn(request.url(),request.postDataJSON());}catch{}
    });
    // Completed Feed requests originate in GMGN's own SharedWorker.
    cdp=await context.newCDPSession(page);let commandId=1;
    cdp.on('Target.attachedToTarget',e=>{
      if(!['worker','shared_worker'].includes(e.targetInfo.type)||!/^https:\/\/gmgn\.ai\/|^blob:https:\/\/gmgn\.ai\//.test(e.targetInfo.url))return;
      cdp.send('Target.sendMessageToTarget',{sessionId:e.sessionId,message:JSON.stringify({id:commandId++,method:'Network.enable',params:{}})}).catch(()=>{});
    });
    cdp.on('Target.receivedMessageFromTarget',e=>{
      try{
        const m=JSON.parse(e.message),p=m.params,key=e.sessionId+':'+p?.requestId;
        if(m.method==='Network.requestWillBeSent'&&sourceFeed(p.request.url)){
          const body=p.request.postData?JSON.parse(p.request.postData):null;learn(p.request.url,body);
          if(workerRequests.size<128)workerRequests.set(key,true);
        }else if(m.method==='Network.webSocketCreated'){
          const r=route(p.url);if(r?.path==='/trs_ws')socketEndpoints.set('migrated','wss://'+r.host+r.path);
        }else if(['Network.loadingFinished','Network.loadingFailed'].includes(m.method))workerRequests.delete(key);
      }catch{}
    });
    await cdp.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:false});
    const shared=new Set();
    for(const [feed,url] of [['migrated','https://gmgn.ai/'],['trending','https://gmgn.ai/trend?chain=sol']]){
      const navigation=await page.goto(url,{waitUntil:'domcontentloaded',timeout:20000});
      if(navigation?.status()!==200||/just a moment|attention required|verify you are human/i.test(await page.title()))throw Error('BROWSER_PAGE_BLOCKED');
      const targets=await cdp.send('Target.getTargets');
      for(const target of targets.targetInfos.filter(t=>t.type==='shared_worker'&&/^https:\/\/gmgn\.ai\//.test(t.url)).slice(0,4)){
        if(shared.has(target.targetId))continue;
        await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:false});shared.add(target.targetId);
      }
      const deadline=Date.now()+15000;
      while((!templates.has(feed)||!socketEndpoints.has(feed))&&Date.now()<deadline)await page.waitForTimeout(100);
      if(!templates.has(feed)||!socketEndpoints.has(feed))throw Error('NORMAL_MARKET_TRANSPORT_MISSING:'+feed);
    }
    const refresh=async feed=>{
      if(active.has(feed)||stopping)return;
      active.add(feed);
      try{
        const body=SCOPE[feed];
        // Only the observed public endpoint; normal browser same-origin auth.
        // No exported headers/cookies, spoofed fingerprint or access workaround.
        const response=await page.evaluate(async({url,body})=>{
          const target=new URL(url);if(target.origin!==location.origin||!['/rrs/api/v1/trending_multichain','/trs/api/v1/trenches_rank'].includes(target.pathname))throw Error('OUT_OF_SCOPE_REQUEST');
          const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000);
          try{const r=await fetch(target.href,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:abort.signal});
            if(r.status!==200)return{status:r.status,text:null};
            return{status:r.status,text:await r.text()};
          }finally{clearTimeout(timer);}
        },{url:templates.get(feed),body});
        const at=new Date().toISOString();
        if(response.status!==200)throw Error('PUBLIC_HTTP_'+response.status);
        const original=safeBody(Buffer.from(response.text)),payload=stripImages(original);
        record('snapshot',{feed,request:body,response:payload,received_at:at,source_payload_sha256:hash(original)});
        const result=book.snapshot(feed,payload,body,at);
        record('snapshot_applied',{feed,...result});
        if(!result.accepted)throw Error(result.reason);
        // A new subscription starts from this exact snapshot cursor. Never reuse
        // the old cursor after reconnect or a version_too_old response.
        const groups=[...book.groups.values()].filter(g=>g.feed===feed);
        const url=socketEndpoints.get(feed);
        const subscriptions=groups.map(g=>({chain:g.chain,filter_id:g.filter_id,version:g.baseline_version}));
        await page.evaluate(async({feed,url,channel,subscriptions})=>{
          const store=window.__alphahandsV2MarketSockets??(window.__alphahandsV2MarketSockets={});
          let entry=store[feed];
          if(entry&&entry.socket.readyState===WebSocket.OPEN){
            entry.socket.send(JSON.stringify({action:'unsubscribe',channel,id:'v2-'+feed,data:entry.subscriptions}));
          }else{
            if(entry){clearInterval(entry.timer);entry.socket.close();}
            const socket=new WebSocket(url);entry=store[feed]={socket,subscriptions:[],timer:null};
            await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{socket.close();reject(Error('SOCKET_OPEN_TIMEOUT'));},10000);
              socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});socket.addEventListener('error',()=>{clearTimeout(timer);reject(Error('SOCKET_OPEN_FAILED'));},{once:true});});
            entry.timer=setInterval(()=>{if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({action:'heartbeat',client_ts:Date.now(),srv_ts:Date.now()}));},5000);
            socket.addEventListener('close',()=>clearInterval(entry.timer),{once:true});
          }
          entry.subscriptions=subscriptions;
          entry.socket.send(JSON.stringify({action:'subscribe',channel,f:'w',id:'v2-'+feed,data:subscriptions}));
        },{feed,url,channel:CHANNELS[feed],subscriptions});
        refreshFailures[feed]=0;persist(true);
      }catch(e){
        const reason=e.message.startsWith('PUBLIC_HTTP_')?e.message:'REFRESH_FAILED:'+e.message.slice(0,100);
        refreshFailures[feed]++;fail(feed,(refreshFailures[feed]>=3?'RETRY_BUDGET_EXHAUSTED:':'')+reason);
      }
      finally{active.delete(feed);}
    };
    await refresh('migrated');await refresh('trending');
    const started=Date.now(),lastRefresh={migrated:started,trending:started};
    while(Date.now()-started<seconds*1000&&!signal?.aborted&&!stopping){
      for(const feed of Object.keys(PATHS)){
        if(Date.now()-lastRefresh[feed]>15000||(book.faults[feed]&&Date.now()-lastRefresh[feed]>5000)){
          // Auth/external failures do not trigger restart or an unbounded retry loop.
          if(!retryAllowed(book.faults[feed],refreshFailures[feed]))continue;
          lastRefresh[feed]=Date.now();await refresh(feed);
        }
      }
      persist();await page.waitForTimeout(250);
    }
    if(boundary.failure)throw Error('COLLECTOR_EVENT_CALLBACK_FAILED');
    persist(true);
    return {output_dir:outputDir,events:eventIndex,view:book.view(),diagnostics};
  }catch(error){terminalError=error instanceof Error?error:Error('COLLECTOR_FAILED');
  }finally{
    stopping=true;
    for(const feed of Object.keys(PATHS))book.connection(feed,false);
    await closeCollectorResources([
      ()=>persist(true),()=>fs.closeSync(fd),
      async()=>{if(cdp)await cdp.detach();},async()=>{if(managed)await managed.close();}
    ],terminalError);
  }
}

if(require.main===module){
  if(!process.argv.includes('--live-read-only')){console.error('Inert by default. --live-read-only is required.');process.exitCode=2;}
  else{
    const seconds=Number(process.argv.find(a=>a.startsWith('--seconds='))?.split('=')[1]??60);
    const out=path.resolve(__dirname,'../../v2-runtime/market-'+crypto.randomUUID());
    collect({seconds,headless:process.argv.includes('--headless'),outputDir:out}).then(r=>console.log(JSON.stringify({output_dir:r.output_dir,events:r.events,
      research_ready_before_stop:r.view.research_ready,reasons:r.view.reasons,groups:r.view.groups.map(g=>({feed:g.feed,chain:g.chain,rows:g.rows.length,events:g.events})),
      note:'Bounded read-only run stopped; saved market.json is now disconnected, not a live fallback.'}))).catch(e=>{console.error(JSON.stringify({error:e.name,message:e.message.slice(0,180)}));process.exitCode=1;});
  }
}
module.exports={collect,atomic,safeBody,stripImages,retryAllowed,attachMarketSocket,createFatalBoundary,closeCollectorResources};
