'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {prepareConversationInput,restoreConversationInput}=require('./conversation-input');
const {createConversationStore,readDetail}=require('./conversation-store');
function roundtrip(before,after){
  const prepared=prepareConversationInput(after,before);
  assert.equal(JSON.stringify(restoreConversationInput(JSON.parse(prepared.text),before)),JSON.stringify(after));
  return prepared;
}
test('exact updates preserve null, zero, duplicate records, order, added/removed keys and literal reference objects',()=>{
  const repeated={text:'Immutable source text '.repeat(100),zero:0,missing:null};
  const original={rows:[repeated,repeated,{...repeated,text:'other'}],value:null,remove:true,
    literal:JSON.parse('{"__proto__":{"x":1},"$ref":"original value"}')};
  const changed=structuredClone(original);changed.rows[1].zero=1;delete changed.remove;changed.added=0;
  roundtrip(original,changed);roundtrip(changed,original);roundtrip(original,original);
  roundtrip(original,{rows:[original.rows[2],original.rows[0]],literal:original.literal});
  roundtrip(original,{value:0,rows:original.rows});roundtrip(null,original);
  const update=roundtrip(original,{...original,value:5});
  assert.equal(update.manifest.mode,'alphahands.packet-update.v1');
  assert.throws(()=>restoreConversationInput(JSON.parse(update.text),{...original,value:'wrong'}),/BASE_INVALID/);
  const damaged=JSON.parse(update.text);damaged.packet_sha256='0'.repeat(64);
  assert.throws(()=>restoreConversationInput(damaged,original),/INTEGRITY/);
  assert.equal({}.x,undefined);
});
test('recursive edits reconstruct a varied deterministic sequence exactly',()=>{
  let previous={rows:Array.from({length:100},(_,i)=>({id:i,value:i%4,empty:null,text:'Original '.repeat(20)}))};
  for(let i=0;i<75;i++){
    const next=structuredClone(previous);next.rows[i%next.rows.length].value=i;
    if(i%7===0)next.rows.reverse();
    if(i%11===0)next.rows.push({id:100+i,value:0,empty:null,text:'Added'});
    if(i%13===0)delete next.rows[0].text;
    roundtrip(previous,next);previous=next;
  }
});
test('private packet store verifies immutable bytes and supports exact bounded recovery',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'alphahands-conversation-'));
  t.after(()=>{assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});});
  const store=createConversationStore(root),packet={zero:0,missing:null,rows:[{text:'a'},{text:'a'}],large:'x'.repeat(140000)};
  const sha=store.putPacket(packet);assert.equal(store.putPacket(packet),sha);assert.deepEqual(store.getPacket(sha),packet);
  assert.equal(readDetail(store.getPacket,{packet_sha256:sha,path:['zero']}).value,0);
  assert.equal(readDetail(store.getPacket,{packet_sha256:sha,path:['missing']}).value,null);
  assert.equal(readDetail(store.getPacket,{packet_sha256:sha,path:['large']}).status,'SELECT_SMALLER_PATH_OR_RANGE');
  const page=readDetail(store.getPacket,{packet_sha256:sha,path:['rows'],offset:0,count:1});
  assert.deepEqual(page.value,[{text:'a'}]);assert.equal(page.total,2);assert.equal(page.next_offset,1);
  assert.throws(()=>readDetail(store.getPacket,{packet_sha256:sha,path:['no']}),/DETAIL_PATH/);
  assert.throws(()=>store.getPacket('../outside'),/ID_INVALID/);
  fs.writeFileSync(path.join(root,'packets',sha+'.json'),'{}');
  assert.throws(()=>store.getPacket(sha),/INTEGRITY/);
});
