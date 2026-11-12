'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),zlib=require('node:zlib');
const {EventEmitter}=require('node:events');
const {runCodex,quotaFromResult}=require('./codex-runner');
const {MODELS,modelForRole,sdkOptions,endpointConfig,environment}=require('./codex-sdk-config');
const {controlRead,assertModelAvailable}=require('./codex-control');
const {authCommand}=require('./codex-auth');
const {validatePng}=require('./token-evidence');
const completed={type:'turn.completed',usage:{input_tokens:10,output_tokens:2}};
const answer={type:'item.completed',item:{id:'answer',type:'agent_message',text:'{"notes":"fixture"}'}};
function catalog(){return{auth_method:'chatgpt',observed_at:new Date().toISOString(),models:Object.values(MODELS).map(x=>({model:x.model,efforts:['medium'],input_modalities:['text','image']}))};}
function fixture(t,{events=[answer,completed],factory}={}){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'alphahands-sdk-test-')),workspaces=[];let seen={calls:0};
  t.after(()=>{for(const dir of [home,...workspaces]){
    const resolved=path.resolve(dir);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved),/^alphahands-(sdk-test|v2-research)-/);fs.rmSync(resolved,{recursive:true,force:true});
  }});
  const options={home,policy:'Full policy fixture.',packet:{value:0,missing:null,repeated:['same','same']},schema:{type:'object'},
    usageProvider:async()=>({inference_allowed:true}),availabilityProvider:async()=>catalog(),
    clientFactory:async config=>{seen.config=config;seen.calls++;return{startThread:thread=>{
      seen.thread=thread;workspaces.push(thread.workingDirectory);return{id:'fixture-thread',runStreamed:async(input,turn)=>{
        seen.input=input;seen.turn=turn;return{events:factory?factory(turn.signal):(async function*(){for(const e of events)yield e;})()};
      }};
    }}}};
  return{options,seen,workspaces};
}
function png(){
  const crc=b=>{let c=-1;for(const v of b){c^=v;for(let n=0;n<8;n++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^-1)>>>0;};
  const chunk=(n,b)=>{const type=Buffer.from(n),head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(b.length);tail.writeUInt32BE(crc(Buffer.concat([type,b])));return Buffer.concat([head,type,b,tail]);};
  const h=Buffer.alloc(13);h.writeUInt32BE(200);h.writeUInt32BE(120,4);h[8]=8;h[9]=2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',h),chunk('IDAT',zlib.deflateSync(Buffer.alloc(601*120))),chunk('IEND',Buffer.alloc(0))]);
}
test('exact role pins cannot silently use defaults or alternate models',async t=>{
  assert.deepEqual(modelForRole(),{role:'main',model:'gpt-6.1-sol',effort:'medium'});
  assert.deepEqual(modelForRole('recal'),{role:'recal',model:'gpt-6-luna',effort:'medium'});
  const f=fixture(t);await assert.rejects(runCodex({...f.options,role:'other'}),/MODEL_ROLE_INVALID/);assert.equal(f.seen.calls,0);
  for(const role of ['main','recal']){const out=await runCodex({...f.options,role});assert.equal(f.seen.thread.model,MODELS[role].model);assert.equal(f.seen.thread.modelReasoningEffort,'medium');assert.equal(out.model.role,role);}
});
test('SDK uses live search, data-only workspace, controlled tools and key-free environment',async t=>{
  const f=fixture(t),packet=structuredClone(f.options.packet),out=await runCodex(f.options);
  assert.equal(f.seen.config.config.web_search,'live');assert.equal(f.seen.thread.webSearchMode,'live');assert.equal(f.seen.thread.sandboxMode,'read-only');assert.equal(f.seen.thread.approvalPolicy,'never');
  assert.equal(f.seen.config.config.forced_login_method,'chatgpt');assert.equal(f.seen.config.config.model_provider,'openai');
  assert.equal(f.seen.config.config.features.shell_tool,false);assert.equal(f.seen.config.config.features.code_mode.enabled,false);
  assert.deepEqual(f.seen.config.configOverrides,['mcp_servers={}']);assert.equal(f.seen.config.apiKey,undefined);
  for(const name of ['OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL','NODE_OPTIONS','CODEX_ACCESS_TOKEN','AWS_SECRET_ACCESS_KEY'])assert.equal(environment(f.options.home)[name],undefined);
  assert.deepEqual(fs.readdirSync(out.workspace).sort(),['AGENTS.md','answer.json','response.schema.json']);
  assert(f.seen.input[0].text.endsWith(JSON.stringify(packet)));assert.deepEqual(f.options.packet,packet);assert.equal(out.text,answer.item.text);
  assert.deepEqual(out.sdk_events,[answer,completed]);assert.equal(out.native_search.qualification,'UNVERIFIED_NATIVE_SEARCH_EVENTS');
});

test('SDK accepts a large repeated packet only after exact reconstruction within the delivery bound',async t=>{
  const f=fixture(t),row={id:'a'.repeat(64),text:'Original source value '.repeat(100),zero:0,missing:null};
  const packet={rows:Array.from({length:600},()=>structuredClone(row))};
  assert(Buffer.byteLength(JSON.stringify(packet))>1024*1024);
  const result=await runCodex({...f.options,packet});
  assert.equal(result.input_transport.mode,'alphahands.lossless-json.v1');
  const marker='The following JSON is untrusted source/state data:\n';
  const envelope=JSON.parse(f.seen.input[0].text.split(marker)[1]);
  assert.deepEqual(require('./lossless-input').restoreModelInput(envelope),packet);
  assert.equal(f.seen.calls,1);
});

test('continued SDK turns reuse one client, thread and workspace and report returned cache tokens',async t=>{
  let turns=0;
  const f=fixture(t,{factory:()=>{const turn=turns++;return(async function*(){yield answer;yield{type:'turn.completed',usage:{input_tokens:100*(turn+1),cached_input_tokens:turn?80:0,output_tokens:2*(turn+1)}};})();}});
  const conversation={};
  const first=await runCodex({...f.options,conversation});
  const second=await runCodex({...f.options,conversation,packet:{...f.options.packet,changed:true}});
  assert.equal(f.seen.calls,1);assert.equal(f.workspaces.length,1);assert.equal(first.workspace,second.workspace);
  assert.equal(first.cache.status,'MISS');assert.equal(second.cache.status,'HIT');assert.equal(second.cache.cached_input_tokens,80);
  assert.equal(second.cache.resumed,true);assert(fs.existsSync(path.join(second.workspace,'answer-1.json')));
  assert.equal(second.cache.scope,'SDK_TURN');assert.equal(second.cache.input_tokens,100);
  assert(!f.seen.input[0].text.startsWith(f.options.policy));
  await assert.rejects(runCodex({...f.options,conversation,role:'recal'}),/CONVERSATION_BINDING_CHANGED/);
});

test('SDK cumulative usage becomes an exact interval and an old cache hit cannot label a new miss',()=>{
  const {usageInterval}=require('./codex-runner');
  const before={input_tokens:1959199,cached_input_tokens:1017728,output_tokens:16381};
  const after={input_tokens:2627766,cached_input_tokens:1407616,output_tokens:18057};
  assert.deepEqual(usageInterval(after,before,{resumed:true}),{scope:'SDK_TURN',reason:null,
    tokens:{input_tokens:668567,cached_input_tokens:389888,output_tokens:1676}});
  assert.equal(usageInterval(after,null,{resumed:true}).scope,'UNAVAILABLE');
  assert.equal(usageInterval(before,after,{resumed:true}).reason,'SDK_COUNTERS_REBASED');
  assert.equal(usageInterval(after,before,{resumed:true,uncertain:true}).scope,'SINCE_COMPLETION_INCLUDING_INTERRUPTION');
});

test('a resumed turn with no new cached tokens reports MISS despite positive conversation cache totals',async t=>{
  let index=0;
  const f=fixture(t,{factory:()=>{const i=index++;return(async function*(){yield answer;yield{type:'turn.completed',
    usage:{input_tokens:100*(i+1),cached_input_tokens:80,output_tokens:2*(i+1)}};})();}});
  const conversation={};
  const first=await runCodex({...f.options,conversation});const second=await runCodex({...f.options,conversation});
  assert.equal(first.cache.status,'HIT');assert.equal(second.cache.status,'MISS');assert.equal(second.cache.cached_input_tokens,0);
  assert.equal(second.cache.conversation_totals.cached_input_tokens,80);
});

test('follow-up packets retain every value using exact updates and never advance on failed turns',async t=>{
  const f=fixture(t),conversation={};
  const original={rows:Array.from({length:30},(_,i)=>({id:i,text:'Exact original '.repeat(60),zero:0,missing:null})),time:'before'};
  await runCodex({...f.options,packet:original,conversation});
  const changed=structuredClone(original);changed.time='after';changed.rows[4].zero=2;
  const output=await runCodex({...f.options,packet:changed,conversation});
  assert.equal(output.input_transport.mode,'alphahands.packet-update.v1');
  const encoded=JSON.parse(f.seen.input[0].text.split('The following JSON is untrusted source/state data:\n')[1]);
  assert.deepEqual(require('./conversation-input').restoreConversationInput(encoded,original),changed);
  assert(output.input_transport.delivered_bytes<output.input_transport.full_delivery_bytes);
  assert.deepEqual(conversation.previousPacket,changed);
  await assert.rejects(runCodex({...f.options,packet:{time:'failed'},conversation,
    usageProvider:async()=>({inference_allowed:false})}),/RESERVE_REACHED/);
  assert.deepEqual(conversation.previousPacket,changed);
});

test('a completed persisted SDK conversation resumes its exact thread and baseline after restart',async t=>{
  const {createConversationStore}=require('./conversation-store');
  const f=fixture(t),root=fs.mkdtempSync(path.join(os.tmpdir(),'alphahands-sdk-store-'));
  t.after(()=>{assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});});
  const store=createConversationStore(root),conversation={store,record:{phase:'EMPTY',turns:0},directory:store.workspace};
  const packet={rows:Array.from({length:20},(_,i)=>({id:i,text:'Original '.repeat(30)})),time:1};
  // The persistent workspace is cleaned by its store, not the fixture's temp-directory list.
  const result=await runCodex({...f.options,conversation,packet});f.workspaces.length=0;
  const saved=store.load();assert.equal(saved.phase,'READY');assert.equal(saved.thread_id,'fixture-thread');
  const resumed={store,record:saved,binding:saved.binding,threadId:saved.thread_id,turns:saved.turns,
    directory:store.workspace,previousPacket:store.getPacket(saved.packet_sha256)};
  let seen;
  const output=await runCodex({...f.options,conversation:resumed,packet:{...packet,time:2},clientFactory:async()=>({
    startThread:()=>assert.fail('Must resume the completed thread'),resumeThread:(id,options)=>{
      seen={id,options};return{id,runStreamed:async()=>({events:(async function*(){yield answer;yield completed;})()})};
    }})});
  assert.equal(seen.id,'fixture-thread');assert.equal(seen.options.workingDirectory,result.workspace);
  assert.equal(output.cache.resumed,true);assert.equal(output.input_transport.mode,'alphahands.packet-update.v1');
  assert.equal(store.load().turns,2);
  store.save({...store.load(),phase:'ACTIVE'});
  assert.throws(()=>store.load(),/REVALIDATION_REQUIRED/);
});
test('only explicitly owned loopback MCP tools are exposed and raw events remain intact',async t=>{
  for(const url of ['https://127.0.0.1:9/mcp','http://example.org:9/mcp','http://localhost:9/mcp','http://127.0.0.1:9/mcp?a=1','http://user:pass@127.0.0.1:9/mcp'])assert.throws(()=>endpointConfig({url,enabledTools:['research']}),/LOOPBACK/);
  const toolEndpoint={url:'http://127.0.0.1:20000/session/mcp',enabledTools:['research_source']};
  const tool={type:'item.completed',item:{id:'tool',type:'mcp_tool_call',server:'alphahands',tool:'research_source',status:'completed',arguments:{input:'exact'},result:{content:[{type:'text',text:'same'},{type:'text',text:'same'}]}}};
  const search={type:'item.completed',item:{id:'web',type:'web_search',query:'exact query',sources:[{url:'https://example.org',text:null}]}};
  const f=fixture(t,{events:[search,tool,answer,completed]}),out=await runCodex({...f.options,toolEndpoint});
  assert.deepEqual(out.items,[search.item,tool.item,answer.item]);assert.deepEqual(out.sdk_events,[search,tool,answer,completed]);
  assert.match(f.seen.config.configOverrides.at(-1),/mcp_servers.alphahands=/);assert.deepEqual(f.seen.config.config.mcp_servers.alphahands.enabled_tools,['research_source']);
});

test('a usage-blocked preflight preserves the completed conversation for a later turn',async t=>{
  const f=fixture(t),conversation={};
  await runCodex({...f.options,conversation});
  await assert.rejects(runCodex({...f.options,conversation,usageProvider:async()=>({inference_allowed:false})}),/RESERVE_REACHED/);
  assert.equal(conversation.faulted,undefined);
  const resumed=await runCodex({...f.options,conversation});
  assert.equal(resumed.cache.resumed,true);
  assert.equal(f.seen.calls,1);
});

test('explicit window authorization supports a fifteen percent reserve and expires with its window',()=>{
  const reset=Math.floor(Date.now()/1000)+3600;
  const usage={ordinaryUsageAllowed:true,rateLimits:{primary:{windowDurationMins:300,usedPercent:84,resetsAt:reset}}};
  const authorization={schema:'alphahands.usage-authorization.v1',owner_approved:true,window_resets_at:reset,start_before_percent:85};
  assert.equal(quotaFromResult(usage,{authorization}).inference_allowed,true);
  assert.equal(quotaFromResult(usage,{authorization}).reserve_percent,15);
  usage.rateLimits.primary.usedPercent=85;
  assert.equal(quotaFromResult(usage,{authorization}).inference_allowed,false);
  usage.rateLimits.primary.usedPercent=70;
  authorization.window_resets_at-=2;
  assert.equal(quotaFromResult(usage,{authorization}).inference_allowed,false);
});
test('actual exact-hash PNG bytes reach SDK as local images, with identity manifest',async t=>{
  const f=fixture(t),bytes=png(),p=validatePng(bytes.toString('base64')),coin='solana:fixture';
  f.options.packet.token_research=[{coin_id:coin,chart:{ok:true,sha256:p.sha256,width:p.width,height:p.height}}];
  const image={coin_id:coin,sha256:p.sha256,content_type:'image/png',base64:bytes.toString('base64')};
  await assert.rejects(runCodex({...f.options,images:[{...image,sha256:'wrong'}]}),/IMAGE_INTEGRITY/);assert.equal(f.seen.calls,0);
  await runCodex({...f.options,images:[image]});const attachment=f.seen.input[1];assert.equal(attachment.type,'local_image');assert.deepEqual(fs.readFileSync(attachment.path),bytes);
  assert(f.seen.input[0].text.includes(JSON.stringify([{coin_id:coin,sha256:p.sha256}])));
});
test('missing subscription model, effort, modality or included usage blocks all SDK calls',async t=>{
  const f=fixture(t);
  for(const c of [{...catalog(),auth_method:'apiKey'},{...catalog(),models:[]},{...catalog(),models:[{model:'gpt-6.1-sol',efforts:['high']}]}]){
    await assert.rejects(runCodex({...f.options,availabilityProvider:async()=>c}),/CODEX_(CHATGPT|REQUESTED)/);assert.equal(f.seen.calls,0);
  }
  assert.throws(()=>assertModelAvailable({...catalog(),models:[{model:'gpt-6.1-sol',efforts:['medium'],input_modalities:['text']}]},modelForRole(),{images:true}),/IMAGE_UNAVAILABLE/);
  await assert.rejects(runCodex({...f.options,usageProvider:async()=>({inference_allowed:false})}),/RESERVE_REACHED/);assert.equal(f.seen.calls,0);
});
test('reserve remains30 percent with5 percent start buffer and no reset credit consumption',()=>{
  const base={ordinaryUsageAllowed:true,rateLimits:{primary:{windowDurationMins:300,usedPercent:64},secondary:{windowDurationMins:10080,usedPercent:90}}};
  assert(quotaFromResult(base).inference_allowed);assert.equal(quotaFromResult(base).reserve_percent,30);
  for(const patch of [{ordinaryUsageAllowed:null},{ordinaryUsageAllowed:false},{rateLimits:{...base.rateLimits,primary:{windowDurationMins:300,usedPercent:65}}},{rateLimits:{...base.rateLimits,spendControlReached:true}}])assert.equal(quotaFromResult({...base,...patch}).inference_allowed,false);
});
test('oversized inputs, outputs, missing completion and invalid JSON fail without truncation',async t=>{
  const large=fixture(t);await assert.rejects(runCodex({...large.options,packet:{text:'x'.repeat(1024*1024)}}),/INPUT_OVERSIZE_NO_TRUNCATION/);assert.equal(large.seen.calls,0);
  for(const events of [[{...answer,item:{...answer.item,text:'x'.repeat(512*1024+1)}},completed],[answer],
    [{...answer,item:{...answer.item,text:'```json\n{}\n```'}},completed],[{type:'turn.failed',error:{message:'RAW_SECRET_MUST_NOT_SURFACE'}}],
    [{type:'item.updated',item:{type:'reasoning',text:'x'.repeat(4*1024*1024+1)}}]]){
    const f=fixture(t,{events});await assert.rejects(runCodex(f.options),e=>/^(RESEARCH_|CODEX_)/.test(e.message)&&!e.message.includes('RAW_SECRET'));assert(f.seen.turn.signal.aborted);
  }
});
test('shell, file mutation and unowned MCP events fail closed',async t=>{
  for(const item of [{type:'command_execution'},{type:'file_change'},{type:'mcp_tool_call',server:'other',tool:'anything'},{type:'mcp_tool_call',server:'alphahands',tool:'anything'}]){
    const f=fixture(t,{events:[{type:'item.started',item},answer,completed]});await assert.rejects(runCodex(f.options),/DISALLOWED_TOOL/);assert(f.seen.turn.signal.aborted);
  }
});
test('timeouts and caller abort propagate to SDK and cannot launch after delayed preflight',async t=>{
  const f=fixture(t,{factory:signal=>(async function*(){await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));})()});
  await assert.rejects(runCodex({...f.options,timeoutMs:25}),/MODEL_TIMEOUT/);assert(f.seen.turn.signal.aborted);
  const c=new AbortController(),g=fixture(t);c.abort();await assert.rejects(runCodex({...g.options,signal:c.signal}),/MODEL_ABORTED/);assert.equal(g.seen.calls,0);
  let release;const h=fixture(t),pending=runCodex({...h.options,timeoutMs:10,usageProvider:()=>new Promise(r=>{release=r;})});
  await assert.rejects(pending,/MODEL_TIMEOUT/);release({inference_allowed:true});await new Promise(r=>setImmediate(r));assert.equal(h.seen.calls,0);
});

test('compaction and continued SDK progress can complete beyond the old three-minute deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const f=fixture(t,{factory:()=> (async function*(){
    yield{type:'turn.started'};
    await wait(147000);
    yield{type:'item.completed',item:{id:'compaction-progress',type:'reasoning',text:'Fixture progress'}};
    await wait(60000);
    yield answer;yield completed;
  })()});
  const pending=runCodex(f.options);
  for(let i=0;i<20&&!f.seen.turn;i++)await new Promise(resolve=>setImmediate(resolve));
  assert(f.seen.turn);
  await new Promise(resolve=>setImmediate(resolve));
  t.mock.timers.tick(147000);await new Promise(resolve=>setImmediate(resolve));
  t.mock.timers.tick(60000);
  const result=await pending;
  assert.equal(result.execution.elapsed_ms,207000);assert.equal(result.execution.deadline_ms,600000);
  assert.equal(result.execution.idle_timeout_ms,300000);assert(!f.seen.turn.signal.aborted);
});

test('a silent SDK stalls while ongoing progress still cannot exceed the absolute deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const stalled=fixture(t,{factory:signal=>(async function*(){await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));})()});
  const stall=runCodex({...stalled.options,timeoutMs:600000,idleTimeoutMs:300000});
  const stallCheck=assert.rejects(stall,error=>error.message==='RESEARCH_MODEL_STALLED'&&error.execution.idle_ms===300000);
  for(let i=0;i<20&&!stalled.seen.turn;i++)await new Promise(resolve=>setImmediate(resolve));
  t.mock.timers.tick(300000);await stallCheck;assert(stalled.seen.turn.signal.aborted);
  const active=fixture(t,{factory:signal=>(async function*(){
    while(!signal.aborted){yield{type:'item.updated',item:{id:'progress',type:'reasoning',text:'Fixture progress'}};
      await new Promise(resolve=>setTimeout(resolve,100000));}
  })()});
  const running=runCodex({...active.options,timeoutMs:600000,idleTimeoutMs:300000});
  const deadlineCheck=assert.rejects(running,error=>error.message==='RESEARCH_MODEL_TIMEOUT'&&error.execution.elapsed_ms===600000);
  for(let i=0;i<20&&!active.seen.turn;i++)await new Promise(resolve=>setImmediate(resolve));
  for(let i=0;i<6;i++){t.mock.timers.tick(100000);await new Promise(resolve=>setImmediate(resolve));}
  await deadlineCheck;assert(active.seen.turn.signal.aborted);
});
test('isolated home refuses inherited configuration without reading it',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.options.home,'config.toml'),'SYNTHETIC_PRIVATE_SENTINEL');
  assert.throws(()=>sdkOptions({home:f.options.home}),e=>e.message==='CODEX_ISOLATED_HOME_CONFIG_PRESENT');
});
function fakeProcess(handler){
  return(file,args,options)=>{const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.stdin.end=()=>{};child.kill=()=>{};
    child.stdin.write=line=>queueMicrotask(()=>handler(JSON.parse(line),child,args,options));return child;};
}
test('control reads paginate exact model metadata and never return account identity',async t=>{
  const f=fixture(t),methods=[];
  const spawnImpl=fakeProcess((m,c)=>{methods.push(m.method);if(m.method==='initialized')return;
    const result=m.method==='initialize'?{}:m.method==='account/read'?{account:{type:'chatgpt',email:'fixture@example.com'}}:
      {data:[{model:m.params.cursor?'gpt-6-luna':'gpt-6.1-sol',id:'fixture',supportedReasoningEfforts:[{reasoningEffort:'medium'}],inputModalities:['text','image']}],nextCursor:m.params.cursor?null:'second'};
    c.stdout.emit('data',Buffer.from(JSON.stringify({id:m.id,result})+'\n'));
  });
  const out=await controlRead({home:f.options.home,models:true,spawnImpl});assert.equal(out.models.length,2);assert.equal(out.auth_method,'chatgpt');assert(!JSON.stringify(out).includes('private@'));
  assert.deepEqual(methods,['initialize','initialized','account/read','model/list','model/list']);
});
test('authentication diagnostics never expose raw output and reject API-key method',async t=>{
  const f=fixture(t);let proc;
  const spawnImpl=()=>{proc=new EventEmitter();proc.stdout=new EventEmitter();proc.stderr=new EventEmitter();queueMicrotask(()=>{proc.stderr.emit('data',Buffer.from('Logged in using an API key: SYNTHETIC_SECRET'));proc.emit('exit',0);});return proc;};
  const out=await authCommand({home:f.options.home,spawnImpl});assert.equal(out.method,'api_key_rejected');assert.equal(out.authenticated,false);assert(!JSON.stringify(out).includes('SYNTHETIC_SECRET'));
});
