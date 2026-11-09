'use strict';
// One invocation's tools. Trusted controllers own all operational authority.
const {webSourceForPacket}=require('./web-evidence');
const {coinIdentity}=require('./token-evidence');
const clone=x=>JSON.parse(JSON.stringify(x));
const string={type:'string'},object=properties=>({type:'object',additionalProperties:false,properties});
const definitions=[
  {name:'research_collect',description:'Collect exact known-token GMGN evidence or public X evidence. Failed source attempts remain explicit.',inputSchema:{...object({kind:{type:'string',enum:['gmgn_token','x_link','x_search']},input:string,reason:string}),required:['kind','input','reason']}},
  {name:'research_browser',description:'Read public websites in the application-owned browser. Use native web search for general research; navigate project/token sources for direct verification. No account actions.',inputSchema:{...object({action:{type:'string',enum:['navigate','read','follow','expand','scroll']},url:string,snapshot_id:string,node_id:string,reason:string}),required:['action','reason']}},
  {name:'discovery_read',description:'Read current qualified Trending and Migrated discovery scopes and their versions.',inputSchema:object({})},
  {name:'discovery_set_trending_filters',description:'Change only the authorized V2 Trending filters using an expected version. A verified change ends the current frozen discovery scope.',inputSchema:{...object({expected_version:{anyOf:[{type:'integer'},string]},chain:{type:'string',enum:['solana','sol','robinhood']},patch:{type:'object'},reason:string,source_ids:{type:'array',items:string}}),required:['expected_version','chain','patch','reason','source_ids']}}
];
function createResearchTools({broker=null,feedController=null,browserController=null,allowedCoinIds=[],now=()=>Date.now()}={}){
  const allowedCoins=new Set(allowedCoinIds.map(id=>coinIdentity(id).coin_id));
  let busy=false,scopeChanged=false;const collected={sources:[],token_evidence:[],request_results:[]};
  function recordResult(result){
    if(!result||!Array.isArray(result.sources??[])||!Array.isArray(result.token_evidence??[]))throw Error('RESEARCH_TOOL_RESULT_INVALID');
    for(const source of result.sources??[])collected.sources.push(clone(source.schema==='alphahands.web-evidence.v1'?webSourceForPacket(source,now()):source));
    for(const token of result.token_evidence??[])collected.token_evidence.push(clone(token));
    collected.request_results.push(clone(result));
    if(result.scope_changed===true||result.changed===true)scopeChanged=true;
    return clone(result);
  }
  function sources({drain=false}={}){
    const result={...clone(collected),scope_changed:scopeChanged};
    if(drain)for(const key of Object.keys(collected))collected[key].length=0;
    return result;
  }
  async function callTool(name,args={}){
    const definition=definitions.find(d=>d.name===name);if(!definition)throw Error('RESEARCH_TOOL_UNKNOWN');
    if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!Object.hasOwn(definition.inputSchema.properties,k))||
      (definition.inputSchema.required??[]).some(k=>!Object.hasOwn(args,k)))throw Error('RESEARCH_TOOL_ARGUMENTS');
    for(const key of ['reason','input','url','snapshot_id','node_id'])if(Object.hasOwn(args,key)&&(typeof args[key]!=='string'||!args[key].trim()||args[key].length>(key==='reason'?10000:8192)))throw Error('RESEARCH_TOOL_ARGUMENTS');
    if(busy)throw Error('RESEARCH_TOOLS_BUSY');busy=true;
    try{
      let result;
      if(name==='research_collect'){
        if(!['gmgn_token','x_link','x_search'].includes(args.kind))throw Error('RESEARCH_TOOL_ARGUMENTS');
        if(args.kind==='gmgn_token'&&!allowedCoins.has(coinIdentity(args.input).coin_id))throw Error('UNKNOWN_RESEARCH_COIN');
        result=broker?await broker.collect(clone(args)):{request:clone(args),status:'UNVERIFIED',reason:'RESEARCH_BROKER_UNAVAILABLE',sources:[],token_evidence:[]};
      }else if(name==='research_browser'){
        if(!['navigate','read','follow','expand','scroll'].includes(args.action))throw Error('RESEARCH_TOOL_ARGUMENTS');
        result=browserController?await browserController.perform(clone(args)):{status:'UNVERIFIED',reason:'OWNED_BROWSER_NOT_CONFIGURED',sources:[],token_evidence:[]};
      }else if(name==='discovery_read'){
        result=feedController?await feedController.read():{status:'UNAVAILABLE',reason:'DISCOVERY_CONTROLLER_NOT_CONFIGURED'};
      }else{
        if(!['solana','sol','robinhood'].includes(args.chain)||!args.patch||typeof args.patch!=='object'||Array.isArray(args.patch)||
          !Array.isArray(args.source_ids)||args.source_ids.some(s=>typeof s!=='string'||!s.trim())||
          !((Number.isSafeInteger(args.expected_version)&&args.expected_version>=0)||(typeof args.expected_version==='string'&&args.expected_version.trim())))throw Error('RESEARCH_TOOL_ARGUMENTS');
        result=feedController?await feedController.update({...clone(args),chain:args.chain==='solana'?'sol':args.chain,feed:'trending'}):{changed:false,status:'UNAVAILABLE',reason:'DISCOVERY_CONTROLLER_NOT_CONFIGURED'};
        if(result?.changed===true)result={...result,scope_changed:true};
      }
      return recordResult(result);
    }finally{busy=false;}
  }
  return{definitions:clone(definitions),callTool,sources,recordResult,capabilities:{browser:browserController?'OWNED_PUBLIC_BROWSER':'UNAVAILABLE',filter_updates:feedController?'VERSIONED_TRENDING_ONLY':'UNAVAILABLE'}};
}
module.exports={createResearchTools,definitions};
