'use strict';

const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createRequire}=require('node:module');
const MODELS=Object.freeze({main:Object.freeze({model:'gpt-6.1-sol',effort:'medium'}),
  // No previous V2 recal effort was pinned. Medium is an explicit implementation default.
  recal:Object.freeze({model:'gpt-6-luna',effort:'medium'})});
const DISABLED=Object.freeze(['shell_tool','shell_snapshot','view_image','skill_mcp_dependency_install','plugins','apps','browser_use','browser_use_external','browser_use_full_cdp_access',
  'computer_use','in_app_browser','multi_agent','hooks','workspace_dependencies']);
function modelForRole(role='main'){
  if(!Object.hasOwn(MODELS,role))throw Error('RESEARCH_MODEL_ROLE_INVALID');
  return{role,...MODELS[role]};
}
function isolatedHome(){return path.join(os.homedir(),'.alphahands-v2-codex');}
function assertIsolatedHome(home=isolatedHome()){
  // A separate official login avoids copying authentication or inheriting user MCP,
  // provider and global instruction configuration. Do not read authentication files.
  if(!path.isAbsolute(home))throw Error('CODEX_HOME_NOT_ABSOLUTE');
  fs.mkdirSync(home,{recursive:true});
  const stat=fs.lstatSync(home);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('CODEX_HOME_UNSAFE');
  for(const name of ['config.toml','AGENTS.md','AGENTS.override.md'])if(fs.existsSync(path.join(home,name)))throw Error('CODEX_ISOLATED_HOME_CONFIG_PRESENT');
  return fs.realpathSync(home);
}
function environment(home=isolatedHome()){
  const names=['PATH','Path','SystemRoot','WINDIR','COMSPEC','USERPROFILE','HOME','APPDATA','LOCALAPPDATA','TEMP','TMP','LANG','LC_ALL'];
  return{...Object.fromEntries(names.filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]])),CODEX_HOME:home};
}
function command(args){
  // The pinned SDK's native binary avoids a Node launcher process between our
  // timeout/termination handler and the CLI, particularly important on Windows.
  const triples={win32:{x64:'x86_64-pc-windows-msvc',arm64:'aarch64-pc-windows-msvc'},
    linux:{x64:'x86_64-unknown-linux-musl',arm64:'aarch64-unknown-linux-musl'},
    darwin:{x64:'x86_64-apple-darwin',arm64:'aarch64-apple-darwin'}};
  const triple=triples[process.platform]?.[process.arch];if(!triple)throw Error('CODEX_PLATFORM_UNSUPPORTED');
  const suffix={win32:'win32',linux:'linux',darwin:'darwin'}[process.platform],codexRequire=createRequire(require.resolve('@openai/codex/package.json'));
  const root=path.dirname(codexRequire.resolve(`@openai/codex-${suffix}-${process.arch}/package.json`)),binary=process.platform==='win32'?'codex.exe':'codex';
  for(const dir of ['bin','codex']){const file=path.join(root,'vendor',triple,dir,binary);if(fs.existsSync(file))return{file,args};}
  throw Error('CODEX_PINNED_BINARY_NOT_FOUND');
}
function endpointConfig(endpoint){
  if(endpoint===undefined||endpoint===null)return{};
  if(!endpoint||typeof endpoint.url!=='string'||!Array.isArray(endpoint.enabledTools)||!endpoint.enabledTools.length)throw Error('RESEARCH_TOOL_ENDPOINT_INVALID');
  let u;try{u=new URL(endpoint.url);}catch{throw Error('RESEARCH_TOOL_ENDPOINT_INVALID');}
  if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||u.username||u.password||u.search||u.hash)throw Error('RESEARCH_TOOL_ENDPOINT_NOT_OWNED_LOOPBACK');
  if(endpoint.enabledTools.some(n=>typeof n!=='string'||!/^[a-z][a-z0-9_]{0,79}$/.test(n))||new Set(endpoint.enabledTools).size!==endpoint.enabledTools.length)throw Error('RESEARCH_TOOL_ENDPOINT_INVALID');
  // Owner approved these host-validated V2 operations. This applies only to the
  // explicit loopback server, never external MCP or arbitrary shell commands.
  return{alphahands:{url:u.href,enabled:true,required:true,enabled_tools:[...endpoint.enabledTools],default_tools_approval_mode:'approve',
    tools:Object.fromEntries(endpoint.enabledTools.map(name=>[name,{output_token_limit:1048576}])),startup_timeout_sec:15,tool_timeout_sec:120}};
}
function sdkOptions({home=isolatedHome(),toolEndpoint}={}){
  const mcp=endpointConfig(toolEndpoint);
  return{codexPathOverride:command([]).file,env:environment(assertIsolatedHome(home)),config:{forced_login_method:'chatgpt',model_provider:'openai',web_search:'live',
    features:{...Object.fromEntries(DISABLED.map(n=>[n,false])),code_mode:{enabled:false}},project_doc_max_bytes:0,history:{persistence:'none'},
    mcp_servers:mcp},configOverrides:['mcp_servers={}']
    // Apply the owned server after clearing the table, including any managed defaults.
    .concat(mcp.alphahands?[`mcp_servers.alphahands=${tomlInline(mcp.alphahands)}`]:[])};
}
function tomlInline(value){
  const encode=v=>Array.isArray(v)?'['+v.map(encode).join(',')+']':v&&typeof v==='object'?tomlInline(v):JSON.stringify(v);
  return'{'+Object.entries(value).map(([k,v])=>`${k}=${encode(v)}`).join(',')+'}';
}
module.exports={MODELS,DISABLED,modelForRole,isolatedHome,assertIsolatedHome,environment,command,endpointConfig,sdkOptions};
