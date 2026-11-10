'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {PaperAccount,initialEntryFill}=require('../../paper-ledger-core');
const {createPaperExecution}=require('./paper-execution');
const {settlePaperDecision,refreshPositionMarks}=require('./paper-settlement');
const {coinIdentity,collectTokenFromPage}=require('./token-evidence');
const COIN='solana:8rHoAfpdE89bi1SRRKaYUWfng3YpntoxZQyEQy9GPmZV';
function setup(t){
  const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'v2-paper-unit-'));
  t.after(()=>{for(const name of fs.readdirSync(directory)){
    const target=path.join(directory,name);
    if(name==='paper-outcomes'){for(const file of fs.readdirSync(target))fs.unlinkSync(path.join(target,file));fs.rmdirSync(target);}
    else fs.unlinkSync(target);
  }fs.rmdirSync(directory);});
  let clock=Date.now();const filePath=path.join(directory,'fixture-account.json'),ledger=new PaperAccount({filePath,now:()=>clock});ledger.initialize(30);
  const execution=createPaperExecution({filePath,now:()=>clock});
  const quote=()=>({ok:true,...coinIdentity(COIN),scraped_at:new Date(clock).toISOString(),price_usd:0.001,market_cap_usd:100000});
  function order(action='BUY',percent=20){return{action,coin_id:COIN,expected_account_revision:execution.context().revision,percent,
    entry_low_mc:['BUY','ADD'].includes(action)?80000:null,entry_high_mc:['BUY','ADD'].includes(action)?120000:null,reason:'Synthetic paper-ledger regression'};}
  function submit(action=order(),runId=crypto.randomUUID(),patch={}){return execution.execute({runId,action,quote:quote(),strategy:{version:4,strategy_status:'RESEARCHED'},evidenceQualified:true,marketReady:true,...patch});}
  return{directory,execution,ledger,order,submit,quote,advance:ms=>{clock+=ms;},now:()=>clock};
}
test('V2 uses the existing costs and ledger, preserves V1 entry history and deduplicates retries',t=>{
  const f=setup(t),action=f.order(),runId=crypto.randomUUID(),fill=f.submit(action,runId);
  assert.equal(f.execution.context().cash_usd,24);assert.equal(fill.costs.fee_bps,100);assert.equal(fill.costs.slippage_bps,100);
  assert.equal(initialEntryFill(f.ledger.read(),fill.trade_id).fill_id,fill.fill_id);
  const revision=f.execution.context().revision;f.advance(300000);
  assert.deepEqual(f.submit(action,runId,{quote:null,marketReady:false,evidenceQualified:false}),fill);
  assert.equal(f.execution.context().revision,revision);assert.equal(f.ledger.read().fills.length,1);
  assert.throws(()=>f.submit({...action,percent:21},runId),/ACTION_ID_CONFLICT/);
});
test('stale state, missing strategy/evidence, changed quote and duplicate positions fail without fills',t=>{
  const f=setup(t),bytes=()=>fs.readFileSync(f.ledger.filePath,'utf8'),before=bytes();
  for(const patch of [{evidenceQualified:false},{marketReady:false},{strategy:{version:4,strategy_status:'PAUSED'}},
    {quote:{...f.quote(),price_usd:null}},{quote:{...f.quote(),market_cap_usd:200000}},
    {quote:{...f.quote(),scraped_at:new Date(f.now()-120001).toISOString()}}])assert.throws(()=>f.submit(f.order(),crypto.randomUUID(),patch));
  assert.throws(()=>f.submit({...f.order(),expected_account_revision:55}),/REVISION_CHANGED/);
  assert.equal(bytes(),before);f.submit();assert.throws(()=>f.submit(),/DUPLICATE_POSITION/);
});
test('partial sells use remaining holdings and full exit remains available during source/strategy gaps',t=>{
  const f=setup(t),buy=f.submit();assert.throws(()=>f.submit(f.order('TRIM',25)),/COOLDOWN/);f.advance(300000);
  const trim=f.submit(f.order('TRIM',25));assert.equal(trim.remaining_quantity,buy.quantity*0.75);
  const exit=f.submit(f.order('EXIT',100),crypto.randomUUID(),{marketReady:false,evidenceQualified:false,strategy:{version:5,strategy_status:'PAUSED'}});
  assert.equal(exit.remaining_quantity,0);assert.equal(f.execution.context().positions.length,0);
  assert.equal(f.ledger.read().fills.length,3);assert(Number.isFinite(f.execution.context().realized_pnl_usd));
});
test('missing account is never silently initialized',t=>{
  const f=setup(t),filePath=path.join(f.directory,'absent.json'),execution=createPaperExecution({filePath});
  assert.throws(()=>execution.context(),/NOT_INITIALIZED/);assert(!fs.existsSync(filePath));
});

test('unavailable held-position quotes remain unverified and never become zero value or a fill',async t=>{
  const f=setup(t);f.submit();f.advance(300000);const before=f.ledger.read();
  const coverage=await refreshPositionMarks({execution:f.execution,now:f.now,broker:{collect:async()=>({status:'UNVERIFIED',token_evidence:[]})}});
  assert.equal(coverage.checked,0);assert.equal(coverage.unchecked,1);assert.deepEqual(f.ledger.read(),before);
  assert.equal(f.execution.context().valuation_complete,false);assert.equal(f.execution.context().positions[0].unrealized_pnl_usd,null);
});
test('settlement refreshes exact price, persists outcome and reconciles an acknowledged fill without collecting again',async t=>{
  const f=setup(t),identity=coinIdentity(COIN),runId=crypto.randomUUID();let calls=0;
  const evidence=await collectTokenFromPage({coinId:COIN,now:f.now,page:{url:()=>identity.url,evaluate:async()=>[identity.address]},
    readData:async()=>({address:identity.address,price_usd:0.001,market_cap_usd:100000,total_fees_native:null}),readChart:async()=>({ok:false,reason:'FIXTURE'})});
  const state={strategy_status:'RESEARCHED',paper_decision:{run_id:runId,action:f.order(),strategy_version:4,decided_at:new Date(f.now()).toISOString(),evidence_qualified:true}};
  const options={state,stateDir:f.directory,execution:f.execution,now:f.now,marketReady:()=>true,
    broker:{collect:async()=>{calls++;return{status:'COLLECTED',token_evidence:[evidence]};}}};
  const first=await settlePaperDecision(options);assert.equal(first.status,'FILLED');assert.equal(calls,1);
  fs.unlinkSync(path.join(f.directory,'paper-outcomes',runId+'.json'));f.advance(1000000);
  assert.equal((await settlePaperDecision(options)).fill_id,first.fill_id);assert.equal(calls,1);assert.equal(f.ledger.read().fills.length,1);
});
