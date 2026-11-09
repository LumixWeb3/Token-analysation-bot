'use strict';
// Ephemeral loopback MCP endpoint, closed by its parent after the model turn.
const http=require('node:http'),crypto=require('node:crypto');
const {tokenForPacket}=require('./token-evidence');
const MAX_BODY=1024*1024;
function modelContent(result,now=Date.now()){
  const projected=JSON.parse(JSON.stringify(result)),images=[];
  if(Array.isArray(result.token_evidence))projected.token_evidence=result.token_evidence.map(e=>{
    const checked=tokenForPacket(e,result.sources??[],now);
    for(const image of checked.images)images.push({type:'image',data:image.base64,mimeType:image.content_type});
    return checked.packet;
  });
  return{content:[{type:'text',text:JSON.stringify(projected)},...images],structuredContent:projected,isError:false};
}
async function startResearchMcpServer({tools,port=0,now=()=>Date.now()}={}){
  if(!tools||typeof tools.callTool!=='function'||!Array.isArray(tools.definitions))throw Error('RESEARCH_MCP_TOOLS_REQUIRED');
  if(!Number.isInteger(port)||port<0||port>65535)throw Error('RESEARCH_MCP_PORT');
  const endpoint='/mcp/'+crypto.randomBytes(16).toString('hex');let address;
  const response=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(body===null?'':JSON.stringify(body));};
  const server=http.createServer(async(req,res)=>{
    if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!==address||req.url!==endpoint){response(res,403,{error:'FORBIDDEN'});return;}
    if(req.headers.origin){try{const origin=new URL(req.headers.origin);if(origin.protocol!=='http:'||!['127.0.0.1','localhost'].includes(origin.hostname)||origin.username||origin.password)throw Error();}catch{response(res,403,{error:'FORBIDDEN_ORIGIN'});return;}}
    if(req.method!=='POST'){response(res,405,{error:'METHOD_NOT_ALLOWED'});return;}
    if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??'')){response(res,415,{error:'JSON_REQUIRED'});return;}
    let size=0;const chunks=[];
    try{
      for await(const chunk of req){size+=chunk.length;if(size>MAX_BODY){response(res,413,{error:'BODY_LIMIT'});return;}chunks.push(chunk);}
      let message;try{message=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{response(res,400,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});return;}
      if(!message||typeof message!=='object'||Array.isArray(message)||message.jsonrpc!=='2.0'||typeof message.method!=='string'||
        (Object.hasOwn(message,'id')&&typeof message.id!=='string'&&typeof message.id!=='number'&&message.id!==null)){
        response(res,400,{jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid Request'}});return;
      }
      if(!Object.hasOwn(message,'id')){response(res,202,null);return;}
      const reply=result=>response(res,200,{jsonrpc:'2.0',id:message.id,result});
      if(message.method==='initialize'){reply({protocolVersion:['2024-11-05','2025-03-26','2025-06-18'].includes(message.params?.protocolVersion)?message.params.protocolVersion:'2025-03-26',capabilities:{tools:{listChanged:false}},serverInfo:{name:'alphahands-research',version:'1.0.0'}});return;}
      if(message.method==='ping'){reply({});return;}
      if(message.method==='tools/list'){reply({tools:tools.definitions});return;}
      if(message.method==='tools/call'){
        try{const result=await tools.callTool(message.params?.name,message.params?.arguments??{});reply(modelContent(result,now()));}
        catch(e){const code=/^[A-Z][A-Z0-9_:]{1,100}$/.test(e?.message)?e.message:'RESEARCH_TOOL_FAILED';reply({content:[{type:'text',text:JSON.stringify({status:'UNVERIFIED',reason:code})}],isError:true});}return;
      }
      response(res,200,{jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Method not found'}});
    }catch{if(!res.headersSent)response(res,400,{error:'REQUEST_FAILED'});else res.end();}
  });
  server.requestTimeout=30000;server.headersTimeout=10000;server.timeout=45000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  address='127.0.0.1:'+server.address().port;
  let closed=false;
  return{url:'http://'+address+endpoint,enabledTools:tools.definitions.map(d=>d.name),close:async()=>{
    if(closed)return;closed=true;await new Promise((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeIdleConnections?.();});
  }};
}
module.exports={startResearchMcpServer,modelContent,MAX_BODY};
