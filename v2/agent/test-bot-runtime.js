'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {FeedBook,SCOPE}=require('../market/network-feed');
const fixture=require('../market/fixtures/gmgn-network-2026-10-27.json');
const {observationCycle}=require('./observation-cycle');
const {runBot}=require('../run');
const {PaperAccount}=require('../../paper-ledger-core');
function book(now){const b=new FeedBook({now});for(const feed of ['migrated','trending']){assert(b.snapshot(feed,fixture[feed],SCOPE[feed]).accepted);b.connection(feed,true);}return b;}
test('observation cycle preserves source times and identities while live transport and cycle expiry still block',()=>{
  let clock=Date.now();const b=book(()=>clock),cycle=observationCycle(b,{now:()=>clock,maxAgeMs:5000}),before=cycle.view();
  b.groups.get('migrated:sol').tokens.clear();clock+=1000;
  assert.equal(cycle.view().groups[0].rows.length,before.groups[0].rows.length);assert.equal(cycle.view().groups[0].snapshot_at,before.groups[0].snapshot_at);
  b.connection('trending',false);assert.equal(cycle.view().research_ready,false);b.connection('trending',true);clock+=5001;
  assert(cycle.view().reasons.includes('OBSERVATION_CYCLE_EXPIRED'));
});
test('runtime joins live book, account and main/recal scheduling, closes resources and never resets the account',async()=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'v2-runtime-unit-')),accountFile=path.join(root,'fixture-account.json');
  const stateDir=path.join(root,'state'),ledger=new PaperAccount({filePath:accountFile});ledger.initialize(30);
  let clock=Date.now(),closed=0,calls=0;const abort=new AbortController();
  try{
    const result=await runBot({accountFile,stateDir,seconds:20,now:()=>clock,signal:abort.signal,
      sleep:async()=>{clock+=1000;},createBrowser:()=>({acquirePage:async()=>{throw Error('UNEXPECTED_BROWSER');},close:async()=>{closed++;}}),
      collectMarket:async({onView,signal})=>{const b=book(()=>clock);onView(b.view(),b);await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));},
      research:async options=>{calls++;assert.equal(options.role,'main');assert.equal(options.accountState.cash_usd,30);assert(options.book.view().research_ready);return{status:'COMMITTED'};}});
    assert.equal(result.status,'STOPPED');assert.equal(calls,1);assert.equal(closed,1);assert.equal(ledger.read().fills.length,0);
    assert(!fs.existsSync(path.join(stateDir,'bot.lock')));assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir,'health.json'))).status,'STOPPED');
  }finally{
    // Only exact fixture files are removed, using one filesystem API end to end.
    for(const name of fs.readdirSync(stateDir))fs.unlinkSync(path.join(stateDir,name));fs.rmdirSync(stateDir);fs.unlinkSync(accountFile);fs.rmdirSync(root);
  }
});
