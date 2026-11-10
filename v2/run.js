'use strict';

// Explicit paper opt-in only. No import starts Chrome, inference or an account.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {setTimeout:delay}=require('node:timers/promises');
const {collect,atomic}=require('./market/collector');
const {hash}=require('./market/network-feed');
const {runResearchSession}=require('./agent/research-session');
const {readState,watchWake}=require('./agent/research-host');
const checkpoint=require('./agent/research-checkpoint');
const {createResearchBrowser}=require('./agent/research-browser-owner');
const {createResearchBroker}=require('./agent/research-broker');
const {researchSource}=require('./agent/research-host');
const {observationCycle}=require('./agent/observation-cycle');
const {createPaperExecution}=require('./agent/paper-execution');
const {settlePaperDecision,refreshPositionMarks}=require('./agent/paper-settlement');

async function runBot({accountFile,stateDir=path.resolve(__dirname,'../v2-runtime/bot'),seconds=3600,
  headless=false,signal,collectMarket=collect,research=runResearchSession,now=()=>Date.now(),
  sleep=delay,createBrowser=createResearchBrowser,onStatus=()=>{}}={}){
  if(seconds!==null&&(!Number.isInteger(seconds)||seconds<20||seconds>3600))throw Error('BOT_DURATION_INVALID');
  const execution=createPaperExecution({filePath:accountFile,now});execution.context();
  fs.mkdirSync(stateDir,{recursive:true});
  const lockFile=path.join(stateDir,'bot.lock'),lock=fs.openSync(lockFile,'wx');
  fs.writeFileSync(lock,JSON.stringify({pid:process.pid,started_at:new Date(now()).toISOString()}));fs.fsyncSync(lock);
  const abort=new AbortController(),cancel=()=>abort.abort();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
  const browser=createBrowser({headless});let sourcePageProvider=null;
  const acquirePage=options=>options.service==='gmgn'&&sourcePageProvider?sourcePageProvider(options):browser.acquirePage(options);
  const broker=createResearchBroker({acquirePage,xApi:researchSource,now});
  let liveBook=null,sourceEnded=false,sourceFailure=null,cycle=null,pendingRun=null,lastRun=0,lastMain=0,lastCohort=null;
  const sessionDirectory=path.join(stateDir,'market-'+crypto.randomUUID());
  let source;
  function status(value){atomic(path.join(stateDir,'health.json'),{...value,at:new Date(now()).toISOString(),paper_only:true});onStatus(value);}
  try{
    if(checkpoint.exists(stateDir))throw Error('BOT_PENDING_RESEARCH_REVALIDATION_REQUIRED');
    source=Promise.resolve().then(()=>collectMarket({seconds,headless,outputDir:sessionDirectory,signal:abort.signal,
      onView:(_,book,sourceControls)=>{liveBook=book;sourcePageProvider=sourceControls?.acquirePage??null;}})).catch(error=>{sourceFailure=error;}).finally(()=>{sourceEnded=true;});
    const started=now();status({status:'STARTING'});
    while(!abort.signal.aborted&&!sourceEnded&&(seconds===null||now()-started<seconds*1000)){
      const view=liveBook?.view();
      if(!view?.research_ready&&(!liveBook||execution.context().positions.length===0)){
        status({status:'SOURCE_UNAVAILABLE',reasons:view?.reasons??['SOURCE_INITIALIZING']});
        // Source initialization is bounded by the collector's own timeouts.
        await sleep(1000,undefined,{signal:abort.signal}).catch(()=>{});continue;
      }
      const state=readState(stateDir);
      if(state.paper_decision){const outcome=await settlePaperDecision({state,stateDir,execution,broker,marketReady:()=>liveBook.view().research_ready,now});
        if(outcome?.status==='FILLED')status({status:'PAPER_ACTION_CONFIRMED',fill_id:outcome.fill_id});}
      const cohort=hash(view.groups.map(g=>({feed:g.feed,chain:g.chain,ids:g.rows.map(r=>r.coin_id).sort()})));
      const due=watchWake(state,view,now());
      const mainDue=view.research_ready&&(!lastMain||now()-lastMain>=600000||cohort!==lastCohort);
      const reviewDue=mainDue||due.wake||now()-lastRun>=300000||pendingRun;
      if(reviewDue&&(!lastRun||now()-lastRun>=60000)){
        if(!cycle||!pendingRun)cycle=view.research_ready?observationCycle(liveBook,{now}):liveBook;
        const role=view.research_ready&&(state.strategy_status==='UNINITIALIZED'||mainDue)?'main':'recal';
        const positionCoverage=await refreshPositionMarks({execution,broker,now});
        status({status:'RESEARCHING',role,position_quote_coverage:positionCoverage});
        const result=await research({book:cycle,stateDir,role,wakeReason:pendingRun?'RESEARCH_CONTINUATION':mainDue?'MARKET_OBSERVATION':'WATCH_OR_POSITION_REVIEW',
          acquirePage,accountState:execution.context(),resumeRunId:pendingRun,
          feedController:{read:async()=>liveBook.view()},signal:abort.signal,maxRounds:3});
        lastRun=now();if(role==='main'){lastMain=lastRun;lastCohort=cohort;}
        pendingRun=result.status==='RESEARCH_IN_PROGRESS'?result.run_id:null;
        status({status:result.status,role,run_id:result.run_id});
        if(pendingRun&&!cycle.view().research_ready)throw Error('BOT_PENDING_RESEARCH_REVALIDATION_REQUIRED');
        const accepted=readState(stateDir);
        if(accepted.paper_decision)await settlePaperDecision({state:accepted,stateDir,execution,broker,marketReady:()=>liveBook.view().research_ready,now});
      }
      await sleep(1000,undefined,{signal:abort.signal}).catch(()=>{});
    }
    if(sourceFailure)throw sourceFailure;
    status({status:'STOPPED',reason:abort.signal.aborted?'OWNER_STOP':'BOUNDED_RUN_ENDED'});
    return{status:'STOPPED',paper_only:true};
  }catch(error){
    if(abort.signal.aborted){status({status:'STOPPED',reason:'OWNER_STOP'});return{status:'STOPPED',paper_only:true};}
    const reason=/^[A-Z][A-Z0-9_:,.-]{1,180}$/.test(error.message)?error.message:'BOT_UNAVAILABLE';
    status({status:'BLOCKED',reason});throw Error(reason);
  }finally{
    abort.abort();signal?.removeEventListener('abort',cancel);
    try{if(source)await source;}finally{try{await browser.close();}finally{fs.closeSync(lock);fs.unlinkSync(lockFile);}}
  }
}

if(require.main===module){
  const args=process.argv.slice(2),allowed=/^(?:--paper|--continuous|--headed|--headless|--seconds=\d+|--account-file=.+)$/;
  if(!args.includes('--paper')||args.some(arg=>!allowed.test(arg))||(args.includes('--headed')&&args.includes('--headless'))||(args.includes('--continuous')&&args.some(arg=>arg.startsWith('--seconds=')))){
    process.stderr.write('Use --paper --account-file=ABSOLUTE_PATH with --seconds=3600 or --continuous.\n');process.exitCode=2;
  }else{
    const accountFile=args.find(arg=>arg.startsWith('--account-file='))?.slice(15);
    const stop=new AbortController();process.once('SIGINT',()=>stop.abort());process.once('SIGTERM',()=>stop.abort());
    runBot({accountFile,seconds:args.includes('--continuous')?null:Number(args.find(arg=>arg.startsWith('--seconds='))?.slice(10)??3600),
      headless:args.includes('--headless'),signal:stop.signal}).then(result=>console.log(JSON.stringify(result)),error=>{console.error(error.message);process.exitCode=1;});
  }
}
module.exports={runBot};
