'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {runResearchSession,createResearchCache}=require('./research-session');
const {FeedBook,SCOPE}=require('../market/network-feed');
const fixture=require('../market/fixtures/gmgn-network-2026-10-27.json');
const {buildWebSource}=require('./web-evidence');
const {readState}=require('./research-host');
function directory(t){const root=fs.realpathSync(os.tmpdir()),d=fs.mkdtempSync(path.join(root,'alphahands-session-unit-'));t.after(()=>{assert.equal(path.dirname(fs.realpathSync(d)),root);for(const name of fs.readdirSync(d)){assert(['turns.jsonl','research.jsonl','STRATEGY.md'].includes(name));fs.unlinkSync(path.join(d,name));}fs.rmdirSync(d);});return d;}
function book(){const b=new FeedBook();for(const f of ['migrated','trending']){assert(b.snapshot(f,fixture[f],SCOPE[f]).accepted);b.connection(f,true);}return b;}
function reply(){return{notes:'Connection-only fixture, no account or trade actions.',reviewed_coin_ids:[],cited_source_ids:[],strategy:null,watches:[],research_requests:[],next_review_at:null};}
test('same-turn owned web evidence reaches validation and journal without becoming linked X',async t=>{
  const stateDir=directory(t),at=new Date().toISOString(),request={kind:'web_page',input:'https://example.com/',reason:'Inspect the project origin'};
  const source=buildWebSource({request,transport:'PLAYWRIGHT_DOM',capture_started_at:at,collected_at:at,requested_url:request.input,final_url:request.input,
    blocks:[{type:'paragraph',text:'Visible original source, not an X identity proof.',url:null}],coverage:{scope:'VISIBLE_DOM',status:'COMPLETE_VISIBLE_CAPTURE',bounded:false,omitted_count:0,note:'Fixture visible text only'}});
  let closed=0;
  const result=await runResearchSession({book:book(),stateDir,role:'recal',startServer:async({tools})=>{
    tools.recordResult({request,status:'COLLECTED',sources:[source],token_evidence:[]});return{url:'http://127.0.0.1:1/mcp/fixture',enabledTools:['discovery_read'],close:async()=>{closed++;}};
  },execute:async({role,packet})=>{assert.equal(role,'recal');assert.equal(packet.controls.agent.role,'recal');const r=reply();r.cited_source_ids=[source.id];return{text:JSON.stringify(r)};}});
  assert.equal(result.status,'COMMITTED');assert.equal(closed,1);assert.equal(readState(stateDir).version,1);
  const journal=JSON.parse(fs.readFileSync(path.join(stateDir,'turns.jsonl'),'utf8').trim());assert.equal(journal.packet.source_catalogue.find(s=>s.id===source.id).kind,'WEB_PAGE');assert.equal(journal.input_packet.sources.length,0);
});
test('verified or indeterminate filter mutation ends old scope without accepting strategy',async t=>{
  const stateDir=directory(t);let closed=0;
  const result=await runResearchSession({book:book(),stateDir,startServer:async({tools})=>{
    tools.recordResult({status:'INDETERMINATE_SCOPE_CHANGE',scope_changed:true});return{url:'http://127.0.0.1:1/mcp/fixture',enabledTools:['discovery_read'],close:async()=>{closed++;}};
  },execute:async()=>({text:JSON.stringify(reply())})});
  assert.equal(result.status,'REOBSERVATION_REQUIRED');assert.equal(readState(stateDir).version,0);assert.equal(closed,1);assert(!fs.existsSync(path.join(stateDir,'research.lock')));
});
test('model failure closes ephemeral tools and never commits a fabricated completed review',async t=>{
  const stateDir=directory(t);let closed=0;
  await assert.rejects(runResearchSession({book:book(),stateDir,startServer:async()=>({url:'http://127.0.0.1:1/mcp/fixture',enabledTools:['discovery_read'],close:async()=>{closed++;}}),execute:async()=>{throw Error('FIXTURE_MODEL_FAILED');}}),/FIXTURE_MODEL_FAILED/);
  assert.equal(closed,1);assert.equal(readState(stateDir).version,0);assert(!fs.existsSync(path.join(stateDir,'research.lock')));
  const failed=JSON.parse(fs.readFileSync(path.join(stateDir,'turns.jsonl'),'utf8').trim());
  assert.equal(failed.status,'MODEL_EXECUTION_FAILED');assert.equal(failed.reason,'FIXTURE_MODEL_FAILED');
  assert.equal(failed.input_bytes,Buffer.byteLength(JSON.stringify(failed.input_packet)));
});

test('queued website research accepts canonical trailing slashes while rejecting a changed destination',async t=>{
  const {runResearch}=require('./research-host');
  for(const changed of [false,true]){
    const stateDir=directory(t),at=new Date().toISOString();
    const request={kind:'web_page',input:'https://example.com',reason:'Read the project site'};
    const normalized={...request,input:changed?'https://other.example.com/':'https://example.com/'};
    const source=buildWebSource({request:normalized,transport:'PLAYWRIGHT_DOM',capture_started_at:at,collected_at:at,
      requested_url:normalized.input,final_url:normalized.input,blocks:[{type:'paragraph',text:'Original source text',url:null}],
      coverage:{scope:'VISIBLE_DOM',status:'COMPLETE_VISIBLE_CAPTURE',bounded:false,omitted_count:0,note:'Fixture only'}});
    let turns=0;
    const pending=runResearch({book:book(),stateDir,broker:{capabilities:{},collect:async()=>({request:normalized,status:'COLLECTED',sources:[source],token_evidence:[]})},
      execute:async()=>{const r=reply();if(turns++===0)r.research_requests=[request];else r.cited_source_ids=[source.id];return{text:JSON.stringify(r)};}});
    if(changed)await assert.rejects(pending,/RESEARCH_TOOL_RESULT_INVALID/);
    else{assert.equal((await pending).status,'COMMITTED');assert.equal(turns,2);}
  }
});

test('role cache keeps one tool endpoint across reviews and rejects idle or cross-role access',async t=>{
  const stateDir=directory(t),cache=createResearchCache();let starts=0,closed=0,proxy,conversation;
  const options={book:book(),stateDir,cacheSession:cache,browserOptions:false,
    startServer:async({tools})=>{starts++;proxy=tools;return{url:'http://127.0.0.1:1/mcp/cache',enabledTools:['discovery_read'],close:async()=>{closed++;}};},
    execute:async input=>{if(conversation)assert.equal(input.conversation,conversation);conversation=input.conversation;return{text:JSON.stringify(reply())};}};
  await runResearchSession(options);await runResearchSession(options);
  assert.equal(starts,1);assert.equal(closed,0);assert.throws(()=>proxy.callTool('discovery_read',{}),/NO_ACTIVE_TURN/);
  await assert.rejects(runResearchSession({...options,role:'recal'}),/CACHE_ROLE_MISMATCH/);
  await cache.close();assert.equal(closed,1);
});

test('persistent role cache restores the same owned MCP address and exact recovery tool',async t=>{
  const {hash}=require('../market/network-feed');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'alphahands-persistent-session-'));
  t.after(()=>{assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});});
  const stateDir=path.join(root,'research'),cacheDir=path.join(root,'sdk-main');
  let url,expected;
  async function execute(input){
    expected=hash(input.packet);
    const endpoint=input.toolEndpoint;
    if(url)assert.equal(endpoint.url,url);url=endpoint.url;
    assert(endpoint.enabledTools.includes('research_input_read'));
    const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',
      params:{name:'research_input_read',arguments:{packet_sha256:expected,path:['controls','strategy_version']}}})});
    const result=(await response.json()).result;assert.equal(result.structuredContent.status,'EXACT');
    assert.equal(result.structuredContent.value,input.packet.controls.strategy_version);
    return{text:JSON.stringify(reply())};
  }
  let cache=createResearchCache({directory:cacheDir});
  try{await runResearchSession({book:book(),stateDir,cacheSession:cache,browserOptions:false,execute});}finally{await cache.close();}
  cache=createResearchCache({directory:cacheDir});
  try{await runResearchSession({book:book(),stateDir,cacheSession:cache,browserOptions:false,execute});}finally{await cache.close();}
});
