'use strict';

const {spawn}=require('node:child_process');
const {isolatedHome,assertIsolatedHome,environment,command}=require('./codex-sdk-config');
function authCommand({login=false,home=isolatedHome(),timeoutMs=login?180000:20000,spawnImpl=spawn}={}){
  home=assertIsolatedHome(home);
  const cmd=command(['-c','forced_login_method="chatgpt"','login',...(login?[]:['status'])]);
  return new Promise((resolve,reject)=>{
    const controller=new AbortController();let child,settled=false,output='',bytes=0;
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(result);};
    const timer=setTimeout(()=>{finish(Error(login?'CODEX_LOGIN_TIMEOUT':'CODEX_AUTH_STATUS_TIMEOUT'));controller.abort();},timeoutMs);
    try{child=spawnImpl(cmd.file,cmd.args,{env:environment(home),windowsHide:true,stdio:['ignore','pipe','pipe'],signal:controller.signal});}
    catch{finish(Error('CODEX_AUTH_PROCESS_FAILED'));return;}
    // Never forward raw login URLs, tokens, account names or CLI diagnostics.
    const collect=chunk=>{bytes+=chunk.length;if(bytes>65536){finish(Error('CODEX_AUTH_OUTPUT_OVERSIZE'));controller.abort();return;}output+=chunk.toString('utf8');};
    child.stdout.on('data',collect);child.stderr.on('data',collect);
    child.on('error',()=>finish(Error('CODEX_AUTH_PROCESS_FAILED')));
    child.on('exit',code=>{
      if(login){if(code===0)finish(null,{authenticated:true,method:'chatgpt',home});else finish(Error('CODEX_CHATGPT_LOGIN_FAILED'));return;}
      if(code===0&&/logged in using chatgpt/i.test(output))finish(null,{authenticated:true,method:'chatgpt',home});
      else if(/api key/i.test(output))finish(null,{authenticated:false,method:'api_key_rejected',home});
      else finish(null,{authenticated:false,method:'login_required',home});
    });
  });
}
if(require.main===module){
  const args=process.argv.slice(2);
  if(args.length!==1||!['--status','--login'].includes(args[0])){process.stderr.write('Usage: node v2/agent/codex-auth.js --status | --login\n');process.exitCode=1;}
  else authCommand({login:args[0]==='--login'}).then(result=>process.stdout.write(JSON.stringify(result)+'\n'),error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
}
module.exports={authCommand};
