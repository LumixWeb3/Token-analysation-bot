'use strict';

// Explicit tiny connectivity proof. No market/position/account data or trading.
const {runCodex}=require('./codex-runner');
const {startResearchMcpServer}=require('./research-mcp');
async function verifyConnection({role='main',execute=runCodex,startServer=startResearchMcpServer}={}){
  let calls=0;
  const tools={definitions:[{name:'discovery_read',description:'Read the diagnostic-only connection marker. Not a market feed.',inputSchema:{type:'object',properties:{},additionalProperties:false}}],
    callTool:async(name,args)=>{if(name!=='discovery_read'||Object.keys(args).length)throw Error('DIAGNOSTIC_TOOL_INVALID');calls++;return{status:'DIAGNOSTIC_ONLY',marker:'ALPHAHANDS_SDK_CONNECTED',trading_enabled:false};}};
  const server=await startServer({tools});
  try{
    const schema={type:'object',additionalProperties:false,properties:{marker:{type:'string',enum:['ALPHAHANDS_SDK_CONNECTED']},trading_enabled:{type:'boolean',enum:[false]}},required:['marker','trading_enabled']};
    const result=await execute({role,toolEndpoint:{url:server.url,enabledTools:server.enabledTools},timeoutMs:120000,
      policy:'You are verifying AlphaHands connectivity only. Call discovery_read exactly once and return its marker with trading_enabled false. '+
        (role==='main'?'First use native web search once for the official OpenAI Codex SDK documentation. This verifies search availability; do not browse other topics. ':'Do not search; this turn verifies the separate recal model route. ')+
        'Do not inspect files, run commands, infer market conditions or propose a trade.',
      packet:{purpose:'SDK_CONNECTION_CHECK',trading_enabled:false,token_research:[]},schema});
    const answer=JSON.parse(result.text),searches=result.items.filter(i=>i.type==='web_search').length;
    if(calls<1||answer.marker!=='ALPHAHANDS_SDK_CONNECTED'||answer.trading_enabled!==false){
      const failure=Error('SDK_DIAGNOSTIC_TOOL_PROOF_FAILED');failure.details={tool_calls:calls,native_search_events:searches,item_types:result.items.map(i=>i.type),
        tool_errors:result.items.filter(i=>i.type==='mcp_tool_call').map(i=>({status:i.status,error:JSON.stringify(i.error??null).replace(/https?:[^\s"\\]+/g,'<url>').slice(0,1000)}))};throw failure;
    }
    if(role==='main'&&searches<1)throw Error('SDK_DIAGNOSTIC_SEARCH_NOT_OBSERVED');
    return{verified_at:new Date().toISOString(),model:result.model,tool_calls:calls,native_search_events:searches,usage:result.usage,trading_enabled:false};
  }finally{await server.close();}
}
if(require.main===module){
  const args=process.argv.slice(2),role=args[0]?.replace(/^--/,'');
  if(args.length!==1||!['main','recal'].includes(role)){process.stderr.write('Usage: node v2/agent/verify-sdk-connection.js --main | --recal\n');process.exitCode=1;}
  else verifyConnection({role}).then(result=>process.stdout.write(JSON.stringify(result)+'\n'),e=>{process.stderr.write(JSON.stringify({error:e.message,details:e.details??null})+'\n');process.exitCode=1;});
}
module.exports={verifyConnection};
