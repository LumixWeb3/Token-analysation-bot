'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process'),path=require('node:path');
const {collect,safeBody,stripImages,retryAllowed,attachMarketSocket,createFatalBoundary,closeCollectorResources}=require('./collector');
const {EventEmitter}=require('node:events');
const {FeedBook,SCOPE,CHANNELS}=require('./network-feed');
const fixture=require('./fixtures/gmgn-network-2026-10-27.json');
test('collector is inert without explicit opt-in and rejects invalid duration before browser loading',async()=>{
  const r=spawnSync(process.execPath,[path.join(__dirname,'collector.js')],{encoding:'utf8'});
  assert.equal(r.status,2);assert.match(r.stderr,/Inert by default/);
  await assert.rejects(collect({seconds:0}),/OUT_OF_BOUNDS/);
});
test('public evidence rejects private fields and declares lossless public values versus omitted image payloads',()=>{
  assert.throws(()=>safeBody(Buffer.from('{"data":{"access_token":"PRIVATE"}}')),/PRIVATE_RESPONSE/);
  const raw={data:[{a:'mint',mc:0,name:null,m_x:'https://x.com/example',ls_b64:'image',nested:{ri_p:'image',value:0}}]};
  assert.deepEqual(stripImages(raw),{data:[{a:'mint',mc:0,name:null,m_x:'https://x.com/example',nested:{value:0}}]});
  assert.equal(raw.data[0].ls_b64,'image');
});
test('authentication/rate-limit failures stop immediately; transient failures have at most three attempts',()=>{
  for(const code of [401,403,429])assert.equal(retryAllowed('PUBLIC_HTTP_'+code,1),false);
  assert.equal(retryAllowed('PUBLIC_HTTP_503',1),true);
  assert.equal(retryAllowed('PUBLIC_HTTP_503',2),true);
  assert.equal(retryAllowed('PUBLIC_HTTP_503',3),false);
  assert.equal(retryAllowed('RETRY_BUDGET_EXHAUSTED:SOCKET_ERROR',0),false);
});

test('malformed public responses do not echo source bytes or accept scalar payloads',()=>{
  assert.throws(()=>safeBody(Buffer.from('{"cookie":"SENSITIVE_BROKEN_JSON')),e=>e.message==='PUBLIC_RESPONSE_MALFORMED_JSON');
  for(const s of ['null','42','[]','"value"'])assert.throws(()=>safeBody(Buffer.from(s)),/INVALID_SHAPE/);
});

test('a failed recording callback stops further admission without escaping an event emitter',()=>{
  const emitter=new EventEmitter(),diskError=Object.assign(Error('disk full'),{code:'ENOSPC'});let stopped=false,attempts=0,fatalCalls=0;
  const boundary=createFatalBoundary(()=>{stopped=true;fatalCalls++;});
  emitter.on('frame',boundary.wrap(()=>{attempts++;throw diskError;}));
  assert.doesNotThrow(()=>emitter.emit('frame'));assert(stopped);assert.equal(boundary.failure,diskError);
  emitter.emit('frame');assert.equal(attempts,1);assert.equal(fatalCalls,1);
  const malformed=createFatalBoundary(()=>{});malformed.wrap(()=>{throw null;})();assert(malformed.failure instanceof Error);
});
test('all shutdown steps run despite failures and the original failure stays authoritative',async()=>{
  const calls=[],primary=Error('source failed'),disk=Error('journal failed'),browser=Error('browser failed');
  const actions=[()=>{calls.push('projection');throw disk;},()=>{calls.push('journal');throw disk;},async()=>{calls.push('detach');},async()=>{calls.push('browser');throw browser;}];
  await assert.rejects(closeCollectorResources(actions,primary),error=>error===primary);
  assert.deepEqual(calls,['projection','journal','detach','browser']);calls.length=0;
  await assert.rejects(closeCollectorResources(actions),error=>error===disk);
  assert.deepEqual(calls,['projection','journal','detach','browser']);
  await assert.rejects(closeCollectorResources([()=>{throw 0;}]),/COLLECTOR_CLEANUP_FAILED/);
});

test('only our exact subscribed socket supplies data; delayed events from replaced/natural sockets are ignored',()=>{
  const book=new FeedBook({now:()=>Date.parse('2026-10-27T12:40:00Z')});
  assert(book.snapshot('trending',fixture.trending,SCOPE.trending).accepted);
  const currentSockets=new Map(),data=[],outages=[];let stopped=false;
  const socket=()=>{const s=new EventEmitter();attachMarketSocket(s,'trending',{book,currentSockets,receive:(f,p)=>data.push(p),unavailable:(f,r)=>outages.push(r),stopped:()=>stopped});return s;};
  const message={action:'subscribe',id:'v2-trending',channel:CHANNELS.trending,data:[...book.groups.values()].map(g=>({chain:g.chain,filter_id:g.filter_id,version:g.baseline_version}))};
  const send=(s,m)=>s.emit('framesent',{payload:JSON.stringify(m)});
  const natural=socket();send(natural,{...message,id:'website'});natural.emit('framereceived',{payload:'unrelated'});assert.equal(data.length,0);assert(!book.connections.trending);
  const first=socket();send(first,{...message,data:message.data.slice(0,1)});assert(!book.connections.trending);
  send(first,{...message,data:[null,null]});assert(!book.connections.trending);
  send(first,message);first.emit('framereceived',{payload:'first'});assert.deepEqual(data,['first']);assert(book.connections.trending);
  const second=socket();send(second,message);send(first,message);first.emit('close');first.emit('socketerror');first.emit('framereceived',{payload:'obsolete'});natural.emit('close');
  assert(book.connections.trending);assert.deepEqual(outages,[]);assert.deepEqual(data,['first']);
  second.emit('framereceived',{payload:'second'});assert.deepEqual(data,['first','second']);second.emit('close');send(second,message);second.emit('framereceived',{payload:'closed'});assert(!book.connections.trending);assert.deepEqual(outages,['SOCKET_CLOSED']);assert.deepEqual(data,['first','second']);
  stopped=true;second.emit('socketerror');assert.equal(outages.length,1);
});
