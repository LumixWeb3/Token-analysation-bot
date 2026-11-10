'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createResearchTools}=require('./research-tools');
const {startResearchMcpServer,modelContent}=require('./research-mcp');
const {coinIdentity,validatePng}=require('./token-evidence');
const {hash}=require('../market/network-feed');
const {createOwnedBrowserController,researchUrl,publicAddress}=require('./research-browser');
const NOW=Date.parse('2026-11-08T12:00:00Z');
test('tools expose only bounded operations and preserve source attempts while draining evidence',async()=>{
  const calls=[],source={schema:'fixture',id:'source-1'};
  const tools=createResearchTools({broker:{collect:async r=>({request:r,status:'COLLECTED',sources:[source],token_evidence:[],attempts:[{transport:'LOCAL_X_API',status:'UNVERIFIED'},{transport:'OWNED_X_PAGE',status:'COLLECTED'}]})},
    feedController:{read:async()=>({version:1}),update:async r=>{calls.push(r);return{changed:true,version:2};}}});
  await tools.callTool('research_collect',{kind:'x_link',input:'https://x.com/example',reason:'Inspect'});
  await tools.callTool('discovery_set_trending_filters',{expected_version:1,chain:'solana',patch:{max_age_days:7},reason:'Review scope',source_ids:['source-1']});
  assert.equal(calls[0].feed,'trending');const drained=tools.sources({drain:true});assert.equal(drained.sources.length,1);assert.equal(drained.scope_changed,true);
  assert.equal(drained.request_results[0].attempts.length,2);assert.equal(tools.sources().sources.length,0);assert.equal(tools.sources().scope_changed,true);
  await assert.rejects(tools.callTool('shell',{}),/UNKNOWN/);await assert.rejects(tools.callTool('research_browser',{action:'evaluate',reason:'No'}),/ARGUMENTS/);
  await assert.rejects(tools.callTool('research_collect',{kind:'gmgn_token',input:'robinhood:0x1111111111111111111111111111111111111111',reason:'Inspect unknown'}),/UNKNOWN_RESEARCH_COIN/);
  await assert.rejects(tools.callTool('discovery_set_trending_filters',{expected_version:1,chain:'solana',patch:{},reason:'Review',source_ids:[],feed:'migrated'}),/ARGUMENTS/);
});
test('missing controllers remain explicit and concurrent tools cannot race a shared page or filter version',async()=>{
  const tools=createResearchTools();assert.equal((await tools.callTool('research_browser',{action:'read',reason:'Inspect'})).reason,'OWNED_BROWSER_NOT_CONFIGURED');
  let finish;const busy=createResearchTools({feedController:{read:()=>new Promise(r=>{finish=r;})}});
  const reading=busy.callTool('discovery_read',{});await assert.rejects(busy.callTool('discovery_read',{}),/BUSY/);finish({status:'OBSERVED'});await reading;
});
test('ephemeral MCP supports initialize/list/call/ping and rejects foreign host, origin, path and malformed requests',async t=>{
  const endpoint=await startResearchMcpServer({tools:createResearchTools()});t.after(()=>endpoint.close());
  const post=(body,options={})=>fetch(endpoint.url,{method:'POST',headers:{'Content-Type':'application/json',...options.headers},body:typeof body==='string'?body:JSON.stringify(body)});
  let response=await post({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26'}});assert.equal((await response.json()).result.protocolVersion,'2025-03-26');
  response=await post({jsonrpc:'2.0',id:2,method:'tools/list'});assert.equal((await response.json()).result.tools.length,4);
  response=await post({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'research_browser',arguments:{action:'read',reason:'Inspect'}}});assert.equal((await response.json()).result.structuredContent.reason,'OWNED_BROWSER_NOT_CONFIGURED');
  response=await post({jsonrpc:'2.0',id:4,method:'ping'});assert.deepEqual((await response.json()).result,{});
  response=await post({jsonrpc:'2.0',method:'notifications/initialized'});assert.equal(response.status,202);
  response=await post('{malformed');assert.equal(response.status,400);
  response=await post([]);assert.equal(response.status,400);
  response=await post({jsonrpc:'2.0',id:5,method:'missing'});assert.equal((await response.json()).error.code,-32601);
  response=await post({jsonrpc:'2.0',id:6,method:'ping'},{headers:{Origin:'https://evil.example'}});assert.equal(response.status,403);
  response=await fetch(endpoint.url+'-wrong',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(response.status,403);
  response=await fetch(endpoint.url);assert.equal(response.status,405);
});
function fixturePage(){
  let url='about:blank',route,buttonText='Show more';const page={
    url:()=>url,mainFrame:()=>page,route:async(_pattern,handler)=>{route=handler;},unroute:async()=>{route=null;},
    goto:async next=>{url=next;},evaluate:async callback=>String(callback).includes('document.body')?{
      text:'Project body.\n\nSecond paragraph.',text_bounded:false,links:[{index:0,text:'Research',url:'https://example.org/research'},{index:1,text:'Private',url:'https://127.0.0.1'}],links_bounded:false,
      buttons:[{index:0,text:buttonText},{index:1,text:'Buy now'}]}:undefined,
    locator:()=>({nth:()=>({innerText:async()=>buttonText,click:async()=>{buttonText='Expanded';}})}),
    request:async(raw,method='GET')=>{let state;await route({request:()=>({url:()=>raw,method:()=>method,isNavigationRequest:()=>false}),continue:async()=>{state='continued';},abort:async()=>{state='aborted';}});return state;}
  };return page;
}
test('owned browser uses opaque current snapshots and never exposes arbitrary click or code execution',async()=>{
  const page=fixturePage();let released=0;const controller=createOwnedBrowserController({acquirePage:async()=>({owned:true,page,release:async()=>{released++;}}),now:()=>NOW,lookup:async()=>[{address:'93.184.216.34'}]});
  const first=await controller.perform({action:'navigate',url:'https://example.com/project',reason:'Inspect'});assert.equal(first.status,'COLLECTED');assert.equal(first.sources[0].blocks[0].text,'Project body.\n\nSecond paragraph.');
  assert.equal(first.snapshot.links.length,1);assert.equal(first.snapshot.expanders.length,1);
  const stale=await controller.perform({action:'follow',snapshot_id:'forged',node_id:'link-0',reason:'Inspect'});assert.equal(stale.reason,'BROWSER_SNAPSHOT_STALE');
  const followed=await controller.perform({action:'follow',snapshot_id:first.snapshot.id,node_id:'link-0',reason:'Inspect'});assert.equal(followed.snapshot.url,'https://example.org/research');
  const denied=await controller.perform({action:'expand',snapshot_id:followed.snapshot.id,node_id:'expand-1',reason:'Inspect'});assert.equal(denied.reason,'BROWSER_NODE_INVALID');
  const expanded=await controller.perform({action:'expand',snapshot_id:followed.snapshot.id,node_id:'expand-0',reason:'Inspect'});assert.equal(expanded.status,'COLLECTED');assert.equal(released,5);
});
test('owned browser rejects nonowned leases, local DNS, private routes and unresolved cleanup',async()=>{
  assert.throws(()=>researchUrl('https://example.com/%61dmin'),/ROUTE/);assert.throws(()=>researchUrl('https://x.com/messages'),/ROUTE/);
  for(const ip of ['127.0.0.1','10.1.1.1','192.168.1.1','169.254.169.254','100.64.0.1','::1','::ffff:127.0.0.1','2001:db8::1'])assert.equal(publicAddress(ip),false);
  assert(publicAddress('93.184.216.34'));assert(publicAddress('2606:4700::1111'));
  assert(publicAddress('192.0.43.8'), 'IANA public web address is outside the reserved /24 blocks');
  assert(publicAddress('192.2.1.1'), 'public 192.2/16 must not be mistaken for 192.0.2/24');
  for(const ip of ['192.0.0.1','192.0.2.1','192.168.1.1'])assert.equal(publicAddress(ip),false);
  const privateController=createOwnedBrowserController({acquirePage:async()=>({owned:true,page:fixturePage(),release:async()=>{}}),lookup:async()=>[{address:'127.0.0.1'}]});
  assert.equal((await privateController.perform({action:'navigate',url:'https://example.com',reason:'Inspect'})).reason,'BROWSER_DESTINATION_NOT_PUBLIC');
  const unowned=createOwnedBrowserController({acquirePage:async()=>({owned:false,page:fixturePage(),release:async()=>{throw Error('must not release');}})});
  assert.equal((await unowned.perform({action:'navigate',url:'https://example.com',reason:'Inspect'})).reason,'NAVIGATION_OWNED_PAGE_REQUIRED');
  await assert.rejects(unowned.perform({action:'navigate',url:'https://example.com',reason:'Inspect'}),/UNRESOLVED/);
  const cleanup=createOwnedBrowserController({acquirePage:async()=>({owned:true,page:fixturePage(),release:async()=>{throw Error('secret error');}}),now:()=>NOW,lookup:async()=>[{address:'93.184.216.34'}]});
  assert.equal((await cleanup.perform({action:'navigate',url:'https://example.com',reason:'Inspect'})).reason,'BROWSER_LEASE_RELEASE_FAILED');
  await assert.rejects(cleanup.perform({action:'read',reason:'Inspect'}),/UNRESOLVED/);
});
test('late acquisition is released once and a timeout permanently blocks reuse',async()=>{
  let complete,releases=0;const controller=createOwnedBrowserController({acquireTimeoutMs:1,acquirePage:()=>new Promise(resolve=>{complete=resolve;})});
  assert.equal((await controller.perform({action:'navigate',url:'https://example.com',reason:'Inspect'})).reason,'BROWSER_LEASE_ACQUIRE_FAILED');
  complete({owned:true,page:fixturePage(),release:async()=>{releases++;}});await new Promise(resolve=>setImmediate(resolve));assert.equal(releases,1);
  await assert.rejects(controller.perform({action:'read',reason:'Inspect'}),/UNRESOLVED/);
});
test('browser request interception rejects private subresources and writes before continuing public reads',async()=>{
  const page=fixturePage(),goto=page.goto,states=[];
  page.goto=async url=>{states.push(await page.request('https://private.example/resource'));
    states.push(await page.request('https://example.com/submit','POST'));states.push(await page.request('https://example.com/read','GET'));await goto(url);};
  const controller=createOwnedBrowserController({acquirePage:async()=>({owned:true,page,release:async()=>{}}),now:()=>NOW,
    lookup:async host=>[{address:host==='private.example'?'10.0.0.1':'93.184.216.34'}]});
  assert.equal((await controller.perform({action:'navigate',url:'https://example.com',reason:'Inspect'})).status,'COLLECTED');
  assert.deepEqual(states,['aborted','aborted','continued']);
});
test('MCP chart bytes travel as actual image content while exact raw token evidence remains intact',()=>{
  const crc=bytes=>{let c=-1;for(const b of bytes){c^=b;for(let n=0;n<8;n++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^-1)>>>0;};
  const chunk=(name,data)=>{const type=Buffer.from(name),head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);tail.writeUInt32BE(crc(Buffer.concat([type,data])));return Buffer.concat([head,type,data,tail]);};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(200);ihdr.writeUInt32BE(120,4);ihdr[8]=8;ihdr[9]=2;
  const bytes=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',require('node:zlib').deflateSync(Buffer.alloc((200*3+1)*120))),chunk('IEND',Buffer.alloc(0))]);
  const png=validatePng(bytes.toString('base64')),coin=coinIdentity('robinhood:0x1111111111111111111111111111111111111111'),at=new Date(NOW).toISOString();
  const body={schema:'alphahands.token-evidence.v2',coin_id:coin.coin_id,source_url:coin.url,capture_started_at:at,collected_at:at,
    token:{coin_id:coin.coin_id,chain:coin.chain,address:coin.address,source_url:coin.url,scraped_at:at,total_fees_native:null},network:{observations:[]},coverage:{},
    chart:{ok:true,coin_id:coin.coin_id,source_url:coin.url,captured_at:at,rendered_label:'Chart for robinhood/'+coin.address+'/USD',sha256:png.sha256,width:png.width,height:png.height,base64:bytes.toString('base64')}};
  const evidence={id:hash(body),...body},result={sources:[],token_evidence:[evidence]};
  const displayed=modelContent(result,NOW);assert.equal(displayed.content[1].type,'image');assert.equal(displayed.content[1].data,evidence.chart.base64);
  assert.equal(displayed.structuredContent.token_evidence[0].chart.base64,undefined);assert(evidence.chart.base64);assert(!displayed.content[0].text.includes(evidence.chart.base64));
});
