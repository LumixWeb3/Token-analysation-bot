'use strict';

// Explicit no-model diagnostic. Normal saved-profile locking owns this browser.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {collectTokenFromPage,tokenForPacket,coinIdentity}=require('./token-evidence');
const {containsPrivateKeys,shape}=require('../market/network-probe');
const {hash}=require('../market/network-feed');
const {observeTokenResponses,requestTokenDepthFromPage}=require('./token-network-evidence');
async function verify({coins,headless=true,depth=false}={}){
  if(!Array.isArray(coins)||!coins.length||coins.length>2||new Set(coins).size!==coins.length)throw Error('ONE_OR_TWO_EXACT_COINS_REQUIRED');
  const identities=coins.map(coinIdentity);
  const {chromium}=require('playwright');
  const {launchManagedPersistentContext}=require('../../gmgn-browser-profile');
  const output=path.resolve(__dirname,'../../v2-runtime/token-'+crypto.randomUUID());
  let managed,stage='PROFILE_LAUNCH';
  try{
    if(require('node:os').freemem()<2.25*1024**3)throw Error('TOKEN_RAM_RESERVE');
    managed=await launchManagedPersistentContext({chromium,role:'v2-token-verification',chain:'solana',profileName:'gmgn-login',headless});
    fs.mkdirSync(output,{recursive:true});const summaries=[];
    for(const coin of identities){
      const page=managed.page;
      if(require('node:os').freemem()<1.5*1024**3)throw Error('TOKEN_RAM_RESERVE');
      const network=observeTokenResponses(page,coin);
      const routes=new Map(),bodies=[],pending=[];
      const onResponse=response=>{
        const u=new URL(response.url());
        const scoped=new Set([
          '/mrwapi/v1/multi_token_full_info',
          '/mrwapi/v1/multi_token_info',
          '/api/v1/mutil_window_token_info',
          `/api/v1/token_stat/${coin.chain==='solana'?'sol':coin.chain}/${coin.address}`,
          `/api/v1/token_fee_info/${coin.chain==='solana'?'sol':coin.chain}/${coin.address}`,
          `/vas/api/v1/token_holder_stat/${coin.chain==='solana'?'sol':coin.chain}/${coin.address}`,
          `/api/v1/token_mcap_candles/${coin.chain==='solana'?'sol':coin.chain}/${coin.address}`
        ]);
        if(u.origin==='https://gmgn.ai'&&scoped.has(u.pathname)) {
          let requestShape=null;try{requestShape=shape(response.request().postDataJSON());}catch{}
          routes.set(u.pathname,{path:u.pathname,status:response.status(),content_type:response.headers()['content-type']??null,
            query_keys:[...u.searchParams.keys()].filter(k=>/^[a-z_]{1,60}$/i.test(k)),
            public_chain:['sol','robinhood'].includes(u.searchParams.get('chain'))?u.searchParams.get('chain'):null,request_shape:requestShape});
          pending.push((async()=>{
            if(!response.ok())return;
            const bytes=await response.body();if(bytes.length>2*1024*1024)return;
            const body=JSON.parse(bytes.toString('utf8'));if(containsPrivateKeys(body)){
              routes.get(u.pathname).body_state='PRIVATE_VALUES_NOT_RETAINED';
              routes.get(u.pathname).public_shape=shape(body);
              if(Array.isArray(body.data)&&body.data.length===1)routes.get(u.pathname).record_fields=Object.fromEntries(
                Object.entries(body.data[0]).filter(([k])=>/^[a-z][a-z0-9_]{0,79}$/i.test(k)).map(([k,v])=>[k,v===null?'null':Array.isArray(v)?'array':typeof v]));
              return;
            }
            bodies.push({path:u.pathname,coin_id:coin.coin_id,received_at:new Date().toISOString(),
              status:response.status(),source_payload_sha256:hash(body),body,
              qualification:'OBSERVED_PUBLIC_RESPONSE_NOT_YET_FIELD_MAPPED'});
          })().catch(()=>{}));
        }
      };
      page.on('response',onResponse);
      stage='TOKEN_NAVIGATION';
      const response=await page.goto(coin.url,{waitUntil:'domcontentloaded',timeout:30000});
      if(!response?.ok())throw Error('TOKEN_HTTP_'+(response?.status()??'UNKNOWN'));
      stage='TOKEN_IDENTITY_RENDER';
      await page.waitForFunction(({address,evm})=>{
        const rendered=document.querySelector('#token-base-address')?.getAttribute('data-addr');
        return(evm?rendered?.toLowerCase():rendered)===address;
      },{address:coin.address,evm:coin.chain==='robinhood'},{timeout:15000});
      await page.waitForFunction(()=>Array.from(document.querySelectorAll('[data-sentry-component="BaseInfoBar"] .info-item-value')).some(e=>e.textContent.includes('$')),{},{timeout:8000});
      stage='TOKEN_DATA_CAPTURE';
      const publicProof=await page.evaluate(()=>({
        url:document.URL,bar:document.querySelector('[data-sentry-component="BaseInfoBar"]')?.outerHTML??null,
        basic:document.querySelector('[data-sentry-component="BasicInfo"]')?.outerHTML??null
      }));
      fs.writeFileSync(path.join(output,`${coin.chain}-public-dom.json`),JSON.stringify(publicProof),{flag:'wx'});
      const evidence=await collectTokenFromPage({page,coinId:coin.coin_id,networkCapture:()=>network.finish(),
        prepareDepth:depth?async({creatorAddress})=>{
          if(creatorAddress)network.setCreator(creatorAddress);
          return requestTokenDepthFromPage(page,coin,creatorAddress,{reuse:(kind,query)=>network.hasObservation(kind,query)});
        }:undefined});
      page.off('response',onResponse);
      await Promise.allSettled(pending);
      fs.writeFileSync(path.join(output,`${coin.chain}-public-routes.json`),JSON.stringify([...routes.values()]),{flag:'wx'});
      fs.writeFileSync(path.join(output,`${coin.chain}-public-responses.json`),JSON.stringify(bodies),{flag:'wx'});
      fs.writeFileSync(path.join(output,`${coin.chain}.json`),JSON.stringify(evidence),{flag:'wx'});
      if(evidence.chart.ok)fs.writeFileSync(path.join(output,`${coin.chain}-chart.png`),Buffer.from(evidence.chart.base64,'base64'),{flag:'wx'});
      const packet=tokenForPacket(evidence);
      summaries.push({coin_id:coin.coin_id,symbol:evidence.token.symbol,market_cap_usd:evidence.token.market_cap_usd,price_usd:evidence.token.price_usd,
        fees:evidence.token.total_fees_native,fee_unit:evidence.token.total_fees_unit,holders:evidence.token.holders_count,
        chart_ok:evidence.chart.ok,chart_label:evidence.chart.rendered_label??null,coverage:evidence.token.coverage.status,
        reasons:packet.packet.reasons,evidence_id:evidence.id,
        network:packet.packet.network.observations.map(o=>({kind:o.route.kind,status:o.qualification_status,invalid_fields:o.invalid_fields,
          fields:o.fields,candles:o.candles?{state:o.candles.state,count:o.candles.rows.length,resolution:o.candles.resolution,reasons:o.candles.reasons}:null,
          depth:o.depth?{state:o.depth.state,count:o.depth.returned_count,has_more:o.depth.has_more,creator:o.depth.creator_address}:null})),
        network_failures:evidence.network.failures});
    }
    return{mode:'READ_ONLY_NO_MODELS_NO_TRADES',output_dir:output,summaries};
  }catch(error){
    const detail=/^TOKEN_[A-Z0-9_]+$/.test(error.message)?error.message:error.name==='TimeoutError'?'SOURCE_RENDER_TIMEOUT':/already.*(?:use|lock)|profile.*lock/i.test(error.message)?'PROFILE_BUSY':'SOURCE_OR_CAPTURE_UNAVAILABLE';
    throw Error(stage+':'+detail);
  }finally{if(managed)await managed.close();}
}
if(require.main===module){
  if(!process.argv.includes('--live')){console.error('Explicit --live and --coin=chain:address required. Imports start nothing.');process.exitCode=1;}
  else verify({coins:process.argv.filter(a=>a.startsWith('--coin=')).map(a=>a.slice(7)),headless:!process.argv.includes('--headed'),depth:process.argv.includes('--depth')})
    .then(r=>console.log(JSON.stringify(r))).catch(error=>{console.error('TOKEN_SOURCE_CHECK_FAILED:'+error.message+'; no restart attempted.');process.exitCode=1;});
}
module.exports={verify};
