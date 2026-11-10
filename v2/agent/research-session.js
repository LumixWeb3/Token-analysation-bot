'use strict';

// Composition only: no service, model, profile or browser starts at import.
const {runResearch,researchSource}=require('./research-host');
const {runCodex}=require('./codex-runner');
const {createResearchBroker}=require('./research-broker');
const {createResearchTools}=require('./research-tools');
const {createOwnedBrowserController}=require('./research-browser');
const {startResearchMcpServer}=require('./research-mcp');
const {createResearchBrowser}=require('./research-browser-owner');

async function runResearchSession({book,stateDir,role='main',wakeReason='OWNER_RESEARCH',acquirePage=null,
  xApi=researchSource,feedController=null,execute=runCodex,startServer=startResearchMcpServer,now=()=>Date.now(),
  maxRounds=3,initialSources=[],tokenEvidence=[],resumeRunId=null,browserOptions={},accountState=null,...transportOptions}={}){
  if(!['main','recal'].includes(role))throw Error('RESEARCH_AGENT_ROLE_INVALID');
  if(typeof wakeReason!=='string'||!wakeReason.trim())throw Error('RESEARCH_WAKE_REASON_REQUIRED');
  const ownedBrowser=!acquirePage&&browserOptions!==false?createResearchBrowser(browserOptions):null;
  const pageProvider=acquirePage??ownedBrowser?.acquirePage??null;
  const broker=createResearchBroker({acquirePage:pageProvider,xApi,now});
  const browserController=pageProvider?createOwnedBrowserController({acquirePage:pageProvider,now}):null;
  const routedBroker={capabilities:{...broker.capabilities,web_search:'CODEX_NATIVE_LIVE_SEARCH',public_web:browserController?'OWNED_PUBLIC_BROWSER':'UNAVAILABLE',filter_updates:typeof feedController?.update==='function'?'VERSIONED_TRENDING_ONLY':'UNAVAILABLE'},
    collect:request=>request.kind==='web_page'?browserController?browserController.perform({action:'navigate',url:request.input,reason:request.reason}):Promise.resolve({request,status:'UNVERIFIED',reason:'OWNED_BROWSER_NOT_CONFIGURED',sources:[],token_evidence:[]}):broker.collect(request)};
  try{return await runResearch({book,stateDir,maxRounds,initialSources,tokenEvidence,resumeRunId,broker:routedBroker,accountState,
    runtime:{role,wake_reason:wakeReason,shared_strategy:true,execution:accountState?'PAPER_ONLY':'UNAVAILABLE'},
    execute:async input=>{
      const tools=createResearchTools({broker,feedController,browserController,now,allowedCoinIds:input.packet.controls.allowed_research_coin_ids});
      const endpoint=await startServer({tools});
      try{
        const output=await execute({...transportOptions,...input,role,toolEndpoint:{url:endpoint.url,enabledTools:endpoint.enabledTools}});
        const receipts=tools.sources({drain:true});
        return{...output,tool_results:receipts.request_results,scope_changed:receipts.scope_changed};
      }finally{await endpoint.close();}
    }});}finally{if(ownedBrowser)await ownedBrowser.close();}
}
module.exports={runResearchSession};
