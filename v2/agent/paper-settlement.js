'use strict';
const fs=require('node:fs'),path=require('node:path');
const {atomic}=require('../market/collector');
const {coinIdentity}=require('./token-evidence');
const {hash}=require('../market/network-feed');
function quoteFromEvidence(evidence,coinId,now=Date.now()){
  const {tokenForPacket}=require('./token-evidence');tokenForPacket(evidence,[],now);
  const identity=coinIdentity(coinId),token=evidence.token;
  if(evidence.coin_id!==coinId)throw Error('V2_PAPER_QUOTE_IDENTITY_MISMATCH');
  return{ok:true,coin_id:identity.coin_id,chain:identity.chain,address:identity.address,
    scraped_at:token.scraped_at,price_usd:token.price_usd,market_cap_usd:token.market_cap_usd};
}

async function refreshPositionMarks({execution,broker,now=()=>Date.now()}){
  const coverage={checked:0,unchecked:0,failures:[]};
  for(const position of execution.context().positions){
    try{
      const result=await broker.collect({kind:'gmgn_token',input:position.coin_id,reason:'Refresh held-position USD valuation before agent review'});
      const evidence=result.token_evidence?.find(item=>item.coin_id===position.coin_id);
      if(result.status!=='COLLECTED'||!evidence)throw Error('V2_PAPER_FRESH_QUOTE_UNAVAILABLE');
      execution.mark(position.trade_id,quoteFromEvidence(evidence,position.coin_id,now()));coverage.checked++;
    }catch{
      coverage.unchecked++;coverage.failures.push({coin_id:position.coin_id,status:'UNVERIFIED'});
    }
  }
  return coverage;
}

async function settlePaperDecision({state,stateDir,execution,broker,marketReady,now=()=>Date.now()}){
  const decision=state.paper_decision;if(!decision)return null;
  if(!/^[a-f0-9-]{36}$/.test(decision.run_id))throw Error('V2_PAPER_DECISION_INVALID');
  const directory=path.join(stateDir,'paper-outcomes');fs.mkdirSync(directory,{recursive:true});
  const file=path.join(directory,decision.run_id+'.json'),decisionHash=hash(decision);
  if(fs.existsSync(file)){
    const saved=JSON.parse(fs.readFileSync(file,'utf8'));
    if(saved.decision_sha256!==decisionHash||!['FILLED','REJECTED'].includes(saved.status))throw Error('V2_PAPER_RECONCILIATION_REQUIRED');
    return saved;
  }
  const outcome={run_id:decision.run_id,decision_sha256:decisionHash,status:'REJECTED',reason:null,fill_id:null};
  let attempted=false;
  try{
    let receipt=execution.receipt(decision.run_id);
    if(receipt){
      receipt=execution.execute({runId:decision.run_id,action:decision.action,
        strategy:{version:decision.strategy_version,strategy_status:state.strategy_status}});
    }else{
      const at=Date.parse(decision.decided_at);
      if(!Number.isFinite(at)||now()<at||now()-at>120000)throw Error('V2_PAPER_DECISION_EXPIRED');
      const result=await broker.collect({kind:'gmgn_token',input:decision.action.coin_id,reason:'Refresh exact USD quote immediately before a paper action'});
      const evidence=result.token_evidence?.find(item=>item.coin_id===decision.action.coin_id);
      if(result.status!=='COLLECTED'||!evidence)throw Error('V2_PAPER_FRESH_QUOTE_UNAVAILABLE');
      // Verify the captured envelope again. No feed MC or chart peak is a fill.
      const quote=quoteFromEvidence(evidence,decision.action.coin_id,now());
      attempted=true;
      receipt=execution.execute({runId:decision.run_id,action:decision.action,
        quote,
        strategy:{version:decision.strategy_version,strategy_status:state.strategy_status},
        evidenceQualified:decision.evidence_qualified,marketReady:marketReady()});
    }
    outcome.status='FILLED';outcome.fill_id=receipt.fill_id;
  }catch(error){
    const code=/^(?:PAPER|V2_PAPER|TOKEN|CHART)_[A-Z0-9_:,]+$/.test(error.message)?error.message:'V2_PAPER_SETTLEMENT_UNAVAILABLE';
    // An I/O error after entering the transaction needs reconciliation. Preserve
    // the decision and any account receipt instead of writing a false rejection.
    if(error.message.includes('RECONCILIATION')||attempted&&!/^(?:PAPER|V2_PAPER)_[A-Z0-9_]+$/.test(error.message))throw Error('V2_PAPER_RECONCILIATION_REQUIRED');
    outcome.reason=code;
  }
  outcome.recorded_at=new Date(now()).toISOString();atomic(file,outcome);return outcome;
}
module.exports={settlePaperDecision,refreshPositionMarks,quoteFromEvidence};
