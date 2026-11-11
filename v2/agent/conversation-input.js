'use strict';

// Exact updates to the last completed packet. No summarisation or field selection.
const {hash}=require('../market/network-feed');
const {prepareModelInput,restoreModelInput}=require('./lossless-input');
const SCHEMA='alphahands.packet-update.v1';
const json=value=>JSON.stringify(value);
function changes(before,after,path=[],out=[]){
  if(json(before)===json(after))return out;
  const objects=before&&after&&typeof before==='object'&&typeof after==='object';
  const arrays=Array.isArray(before)&&Array.isArray(after);
  if(objects&&(arrays||!Array.isArray(before)&&!Array.isArray(after))&&
    json(Object.keys(before))===json(Object.keys(after))){
    for(const key of Object.keys(after))changes(before[key],after[key],[...path,key],out);
  }else out.push({path,value:after});
  return out;
}
function restoreUpdate(update,previous){
  if(update?.schema!==SCHEMA||hash(previous)!==update.base_packet_sha256||!Array.isArray(update.replace))
    throw Error('RESEARCH_INPUT_UPDATE_BASE_INVALID');
  let restored=JSON.parse(json(previous));
  for(const entry of update.replace){
    if(!entry||!Array.isArray(entry.path)||entry.path.some(key=>typeof key!=='string')||!Object.hasOwn(entry,'value'))
      throw Error('RESEARCH_INPUT_UPDATE_INVALID');
    if(!entry.path.length){restored=entry.value;continue;}
    let parent=restored;
    for(const key of entry.path.slice(0,-1)){
      if(!parent||typeof parent!=='object'||!Object.hasOwn(parent,key))throw Error('RESEARCH_INPUT_UPDATE_INVALID');
      parent=parent[key];
    }
    const key=entry.path.at(-1);
    if(!parent||typeof parent!=='object'||!Object.hasOwn(parent,key))throw Error('RESEARCH_INPUT_UPDATE_INVALID');
    Object.defineProperty(parent,key,{value:entry.value,writable:true,enumerable:true,configurable:true});
  }
  if(hash(restored)!==update.packet_sha256||Buffer.byteLength(json(restored))!==update.packet_bytes)
    throw Error('RESEARCH_INPUT_UPDATE_INTEGRITY');
  return restored;
}
function prepareConversationInput(packet,previous=null){
  const full=prepareModelInput(packet);
  if(!previous)return full;
  const update={schema:SCHEMA,base_packet_sha256:hash(previous),packet_sha256:hash(packet),
    packet_bytes:Buffer.byteLength(json(packet)),replace:changes(previous,packet)};
  if(json(restoreUpdate(update,previous))!==json(packet))throw Error('RESEARCH_INPUT_UPDATE_INTEGRITY');
  const prepared=prepareModelInput(update);
  if(prepared.manifest.delivered_bytes>=full.manifest.delivered_bytes)return full;
  return{text:prepared.text,manifest:{...full.manifest,mode:SCHEMA,encoding:prepared.manifest.mode,
    delivered_bytes:prepared.manifest.delivered_bytes,base_packet_sha256:update.base_packet_sha256,
    replacements:update.replace.length,full_delivery_bytes:full.manifest.delivered_bytes}};
}
function restoreConversationInput(value,previous){
  const decoded=value?.schema==='alphahands.lossless-json.v1'?restoreModelInput(value):value;
  return decoded?.schema===SCHEMA?restoreUpdate(decoded,previous):decoded;
}
module.exports={prepareConversationInput,restoreConversationInput,restoreUpdate,SCHEMA};
