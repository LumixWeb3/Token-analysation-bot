'use strict';

// Private runtime-only state. SDK authentication stays in its isolated home.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {hash}=require('../market/network-feed');
const {MAX_PACKET_BYTES}=require('./lossless-input');
const SCHEMA='alphahands.sdk-conversation.v1';
function directory(root){
  fs.mkdirSync(root,{recursive:true});
  const stat=fs.lstatSync(root);
  if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('RESEARCH_CONVERSATION_STORE_UNSAFE');
}
function read(file,limit){
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>limit)throw Error('RESEARCH_CONVERSATION_STORE_UNSAFE');
  return JSON.parse(fs.readFileSync(file,'utf8'));
}
function createConversationStore(root){
  root=path.resolve(root);directory(root);
  const packets=path.join(root,'packets'),workspace=path.join(root,'workspace');
  directory(packets);directory(workspace);
  const stateFile=path.join(root,'conversation.json');
  function load(){
    if(!fs.existsSync(stateFile))return null;
    const record=read(stateFile,16384),{sha256,...body}=record;
    if(body.schema!==SCHEMA||hash(body)!==sha256)throw Error('RESEARCH_CONVERSATION_STORE_INTEGRITY');
    if(!['READY','ACTIVE','EMPTY'].includes(body.phase)||!Number.isSafeInteger(body.turns)||body.turns<0)
      throw Error('RESEARCH_CONVERSATION_STORE_INTEGRITY');
    if(body.phase==='ACTIVE')throw Error('RESEARCH_CONVERSATION_REVALIDATION_REQUIRED');
    if(body.endpoint){
      let url;try{url=new URL(body.endpoint);}catch{throw Error('RESEARCH_CONVERSATION_STORE_INTEGRITY');}
      if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.search||url.hash||
        !/^\/mcp\/[a-f0-9]{32}$/.test(url.pathname))throw Error('RESEARCH_CONVERSATION_STORE_INTEGRITY');
    }
    if(body.phase==='READY'&&(!/^[a-zA-Z0-9_-]{1,128}$/.test(body.thread_id??'')||
      !/^[a-f0-9]{64}$/.test(body.binding??'')||body.turns<1||!/^[a-f0-9]{64}$/.test(body.packet_sha256??'')))
      throw Error('RESEARCH_CONVERSATION_STORE_INTEGRITY');
    return body;
  }
  function save(body){
    const value={...body,schema:SCHEMA},bytes=JSON.stringify({...value,sha256:hash(value)});
    const temporary=stateFile+'.'+crypto.randomUUID()+'.tmp',fd=fs.openSync(temporary,'wx',0o600);
    try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(temporary,stateFile);
  }
  function packetFile(sha){
    if(!/^[a-f0-9]{64}$/.test(sha??''))throw Error('RESEARCH_INPUT_DETAIL_ID_INVALID');
    return path.join(packets,sha+'.json');
  }
  function getPacket(sha){
    const value=read(packetFile(sha),MAX_PACKET_BYTES);
    if(hash(value)!==sha)throw Error('RESEARCH_INPUT_DETAIL_INTEGRITY');
    return value;
  }
  function putPacket(packet){
    const bytes=JSON.stringify(packet),sha=hash(packet),file=packetFile(sha);
    if(Buffer.byteLength(bytes)>MAX_PACKET_BYTES)throw Error('RESEARCH_INPUT_OVERSIZE_NO_TRUNCATION');
    if(fs.existsSync(file)){if(JSON.stringify(getPacket(sha))!==bytes)throw Error('RESEARCH_INPUT_DETAIL_INTEGRITY');}
    else{
      const fd=fs.openSync(file,'wx',0o600);
      try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    }
    return sha;
  }
  return{root,workspace,load,save,getPacket,putPacket};
}

const detailDefinition={name:'research_input_read',description:'Recover exact fields from a supplied packet by SHA-256 after compaction or for comparison. Historical times and qualification stay historical. No network or action. An oversized subtree returns its keys and counts so you can request smaller paths.',
  inputSchema:{type:'object',additionalProperties:false,properties:{packet_sha256:{type:'string'},path:{type:'array',items:{type:'string'}},offset:{type:'integer',minimum:0},count:{type:'integer',minimum:1,maximum:1000}},required:['packet_sha256','path']}};
function readDetail(getPacket,args){
  if(!args||Object.keys(args).some(k=>!['packet_sha256','path','offset','count'].includes(k))||
    !Array.isArray(args.path)||args.path.length>64||args.path.some(p=>typeof p!=='string')||
    !/^[a-f0-9]{64}$/.test(args.packet_sha256??''))throw Error('RESEARCH_INPUT_DETAIL_ARGUMENTS');
  let value=getPacket(args.packet_sha256);
  for(const key of args.path){
    if(!value||typeof value!=='object'||!Object.hasOwn(value,key))throw Error('RESEARCH_INPUT_DETAIL_PATH');
    value=value[key];
  }
  const result={schema:'alphahands.input-detail.v1',packet_sha256:args.packet_sha256,path:args.path,
    freshness:'ORIGINAL_PACKET_TIMES_ONLY',value_sha256:hash(value)};
  if(args.offset!==undefined||args.count!==undefined){
    if(!Number.isSafeInteger(args.offset)||args.offset<0||!Number.isSafeInteger(args.count)||args.count<1||args.count>1000||
      !(Array.isArray(value)||typeof value==='string')||args.offset>value.length)throw Error('RESEARCH_INPUT_DETAIL_RANGE');
    Object.assign(result,{offset:args.offset,total:value.length,next_offset:Math.min(value.length,args.offset+args.count)});
    value=value.slice(args.offset,args.offset+args.count);
  }
  if(Buffer.byteLength(JSON.stringify(value))>128*1024)return{...result,status:'SELECT_SMALLER_PATH_OR_RANGE',
    type:Array.isArray(value)?'array':typeof value,length:value?.length??null,
    keys:value&&typeof value==='object'&&!Array.isArray(value)?Object.keys(value):null};
  return{...result,status:'EXACT',value};
}
module.exports={createConversationStore,detailDefinition,readDetail};
