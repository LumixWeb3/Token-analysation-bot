'use strict';

// Explicit read-only public GMGN holder proof. Never launches on import.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {coinIdentity}=require('./token-evidence');
const {observeTokenResponses,requestTokenDepthFromPage,observationForPacket,describeTokenRoute}=require('./token-network-evidence');
const escape=value=>String(value??'null').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const show=v=>v===undefined?'MISSING':v===null?'null':typeof v==='object'?JSON.stringify(v):String(v);
function renderReport(report){
  const top=report.normalized.depth.top20,raw=report.observation.raw_public.list.slice(0,20);
  const fields=[...new Set(raw.flatMap(Object.keys))].sort();
  const fieldCoverage=fields.map(field=>{const observed=raw.filter(r=>Object.hasOwn(r,field));return{field,present:observed.length,missing:raw.length-observed.length,null:observed.filter(r=>r[field]===null).length,zero:observed.filter(r=>r[field]===0||r[field]==='0').length};});
  const labels=r=>[r.name,r.twitter_username&&'@'+r.twitter_username,...(r.tags??[]),...(r.maker_token_tags??[]),r.exchange].filter(v=>v!==null&&v!==undefined&&v!=='').join(' · ')||'No provider label observed';
  const cells=values=>values.map(v=>'<td>'+escape(show(v))+'</td>').join('');
  const rows=top.rows.map((n,index)=>{const r=raw[index],name=r.name||r.twitter_name||(r.twitter_username?'@'+r.twitter_username:'Unlabelled wallet');
    const wallet='<td><strong>'+escape(name)+'</strong>'+(r.twitter_username?'<br><span class="handle">@'+escape(r.twitter_username)+'</span>':'')+'<br><small>'+escape(r.address)+'</small></td>';
    return'<tr>'+cells([n.page_rank])+wallet+cells([labels(r),n.provider_kol_label.state,n.remaining_share.value===null?null:n.remaining_share.value+'%',n.remaining_tokens.raw,n.remaining_usd.raw,r.buy_tx_count_cur,r.sell_tx_count_cur,r.realized_profit??r.realized_pnl,r.unrealized_profit??r.unrealized_pnl])+`<td><details><summary>All ${Object.keys(r).length} fields</summary><pre>${escape(JSON.stringify({provider_public:r,normalized:n},null,2))}</pre></details></td></tr>`;}).join('');
  const allFields=fieldCoverage.map(r=>'<tr>'+cells([r.field,r.present,r.missing,r.null,r.zero])+'</tr>').join('');
  const kolRows=report.observation.raw_public.list.map((r,index)=>({...r,page_rank:index+1})).filter(r=>r.tags?.includes('kol'));
  const kolTable=kolRows.length?'<div class="wrap"><table><thead><tr><th>Page rank</th><th>Wallet</th><th>Provider name</th><th>Provider X handle</th><th>Raw share</th><th>Tags</th></tr></thead><tbody>'+kolRows.map(r=>'<tr>'+cells([r.page_rank,r.address,r.name,r.twitter_username,r.amount_percentage,r.tags])+'</tr>').join('')+'</tbody></table></div>':'<p>No explicit GMGN KOL tag observed in this returned page; KOL identity remains unknown.</p>';
  const rawMatrix='<thead><tr><th>Rank</th>'+fields.map(f=>'<th>'+escape(f)+'</th>').join('')+'</tr></thead><tbody>'+raw.map((r,i)=>'<tr>'+cells([i+1,...fields.map(f=>Object.hasOwn(r,f)?r[f]:undefined)])+'</tr>').join('')+'</tbody>';
  const excluded=report.provider_field_inventory.map(i=>({observed_at:i.received_at,provider_row_fields:i.provider_row_fields,excluded_from_public_projection:i.excluded_row_fields}));
  const html=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>AlphaHands · GMGN holder proof</title><style>
  :root{color-scheme:dark;font-family:system-ui,sans-serif;background:#10151c;color:#e2eaf2}body{margin:0;padding:32px;max-width:1700px;margin:auto}h1{font-size:32px;letter-spacing:-1px}h2{margin-top:36px}p{color:#b7c7d6;line-height:1.6}.tag{display:inline-block;border:1px solid #34505b;padding:7px 12px;border-radius:8px;color:#8ce6d0;margin:5px 8px 5px 0}.wrap{overflow:auto;border:1px solid #2b3b4e;border-radius:12px;max-height:76vh}table{border-collapse:collapse;width:100%;font-size:13px}td,th{text-align:left;padding:12px;border-bottom:1px solid #273443;vertical-align:top;white-space:nowrap}th{position:sticky;top:0;background:#1d2b3a;color:#a7d1ea;z-index:1}tr:nth-child(even){background:#14202a}td:nth-child(2){font-family:ui-monospace,monospace}summary{cursor:pointer;color:#82d8ec}pre{font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;word-break:break-word;max-width:900px;max-height:650px;overflow:auto}a{color:#8edff0}.warning{border-left:3px solid #e8bd69;padding:8px 16px;background:#26251c}code{word-break:break-all}footer{margin:30px 0;color:#8a9eb1}</style></head><body>
  <p>ALPHAHANDS / READ-ONLY LIVE DATA CHECK</p><h1>GMGN · Top 20 holders</h1>
  <span class="tag">${escape(top.state)}</span><span class="tag">${top.returned_count} / 20 rows</span><span class="tag">${report.observation.raw_public.list.length} rows received</span>
  <p>Token: <a href="${escape(report.coin.url)}">${escape(report.coin.coin_id)}</a><br>Captured: ${escape(report.observation.received_at)}<br>Source: <code>${escape(report.route)}</code></p>
  <p class="warning">This is a dated snapshot. Provider labels are not independently verified KOL identities, recent buys or conviction. Native balances are unverified provider base units. Zero, null and MISSING remain distinct. Pools remain included; this is not a complete holder census.</p>
  <div class="wrap"><table><thead><tr>${['Rank','Wallet / GMGN name','GMGN labels','KOL tag state','Supply share','Tokens · provider raw','Value · USD','Buy count · provider current','Sell count · provider current','Realized PnL · provider raw','Unrealized PnL · provider raw','Every captured field'].map(t=>'<th>'+escape(t)+'</th>').join('')}</tr></thead><tbody>${rows}</tbody></table></div>
  <h2>Every captured public field · exact values</h2><p>Scroll sideways for the full JSON-field table. Values are preserved as received, without number rounding. MISSING means the property was absent.</p><div class="wrap"><table>${rawMatrix}</table></div>
  <h2>GMGN KOL tags anywhere in the returned page</h2><p>This checks all ${report.observation.raw_public.list.length} captured rows, including wallets outside the top20. These are provider labels, not independently confirmed identity or conviction.</p>${kolTable}
  <h2>Field coverage</h2><div class="wrap"><table><thead><tr><th>JSON field</th><th>Present / 20</th><th>Missing</th><th>Null</th><th>Zero</th></tr></thead><tbody>${allFields}</tbody></table></div>
  <h2>What was retained and excluded</h2><p>The export contains the allowlisted public wallet projection, not authentication/account data. Unknown provider keys are listed below without copying their values.</p><details><summary>Provider field inventory</summary><pre>${escape(JSON.stringify(excluded,null,2))}</pre></details>
  <h2>Downloads</h2><p><a href="holder-data.json">Complete captured public JSON + normalization + proof</a> · <a href="top20-all-fields.csv">Top20 · every captured public field (CSV)</a></p>
  <footer>Read-only request. No model inference, paper fills, trades or account changes. Ordered by amount_percentage descending; token and query identity verified.</footer></body></html>`;
  const csvValue=v=>{let text=show(v);if(typeof v==='string'&&/^[=+@\-\t\r]/.test(text)&&!/^\-?\d+(?:\.\d+)?$/.test(text))text="'"+text;return'"'+text.replace(/"/g,'""')+'"';};
  return{html,csv:[['rank',...fields].map(csvValue).join(','),...raw.map((r,i)=>[i+1,...fields.map(f=>Object.hasOwn(r,f)?r[f]:undefined)].map(csvValue).join(','))].join('\r\n'),field_count:fields.length};
}
async function verifyHolders({coinId,headless=true}={}){
  const coin=coinIdentity(coinId),{chromium}=require('playwright'),{launchManagedPersistentContext}=require('../../gmgn-browser-profile');
  if(os.freemem()<2.25*1024**3)throw Error('HOLDER_RAM_RESERVE');
  let managed,network,stage='PROFILE_LAUNCH';const inventory=[],pending=[];
  try{
    managed=await launchManagedPersistentContext({chromium,role:'v2-holder-verification',chain:coin.chain,profileName:'gmgn-login',headless});
    const page=managed.page;network=observeTokenResponses(page,coin);
    const inventoryResponse=response=>{
      const route=describeTokenRoute(response.url(),coin);if(route?.kind!=='holder_wallets')return;
      pending.push((async()=>{if(response.status()!==200)return;const bytes=await response.body();if(bytes.length>2*1024*1024)return;
        const body=JSON.parse(bytes.toString('utf8'));if(!Array.isArray(body.data?.list))return;
        // Names only, never unknown values or response headers/cookies.
        const keys=[...new Set(body.data.list.flatMap(Object.keys))].filter(k=>/^[a-zA-Z0-9_]{1,80}$/.test(k)).sort();
        const shape=value=>value===null?'null':Array.isArray(value)?{type:'array',length:value.length,item_shapes:value.slice(0,2).map(shape)}:typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([k])=>/^[a-zA-Z0-9_]{1,80}$/.test(k)).map(([k,v])=>[k,Array.isArray(v)?'array':v===null?'null':typeof v])):typeof value;
        const transferShapes=Object.fromEntries(['native_transfer','token_transfer','token_transfer_in','token_transfer_out'].filter(key=>Object.hasOwn(body.data.list[0]??{},key)).map(key=>[key,shape(body.data.list[0][key])]));
        inventory.push({received_at:new Date().toISOString(),provider_row_fields:keys,transfer_field_shapes:transferShapes});})().catch(()=>{}));
    };
    page.on('response',inventoryResponse);stage='EXACT_TOKEN_NAVIGATION';
    const response=await page.goto(coin.url,{waitUntil:'domcontentloaded',timeout:30000});if(!response?.ok()&&headless)throw Error('HOLDER_HTTP_'+response?.status());
    // A visible, owner-authorized browser can wait for the owner to complete
    // normal interactive access. No challenge bypass or automated restart.
    await page.waitForFunction(({address,evm})=>{const value=document.querySelector('#token-base-address')?.getAttribute('data-addr');return(evm?value?.toLowerCase():value)===address;},{address:coin.address,evm:coin.chain==='robinhood'},{timeout:headless?15000:90000});
    if(os.freemem()<1.5*1024**3)throw Error('HOLDER_RAM_RESERVE');stage='PUBLIC_HOLDER_JSON';
    const requests=await requestTokenDepthFromPage(page,coin);const captured=await network.finish();network=null;await Promise.allSettled(pending);page.off('response',inventoryResponse);
    const observation=captured.observations.filter(o=>o.route.kind==='holder_wallets'&&o.route.first_page_scope_verified).at(-1);
    if(!observation)throw Error('HOLDER_NO_QUALIFIED_ROUTE:'+JSON.stringify({requests,failures:captured.failures}));
    const normalized=observationForPacket(observation,coin,Date.now());if(!normalized.depth?.top20?.qualified)throw Error('HOLDER_TOP20_UNVERIFIED:'+JSON.stringify(normalized.depth?.top20?.reasons??[]));
    const retained=new Set(observation.raw_public.list.flatMap(Object.keys));
    for(const row of inventory)row.excluded_row_fields=row.provider_row_fields.filter(k=>!retained.has(k));
    const report={schema:'alphahands.holder-verification.v1',coin,route:'https://gmgn.ai'+requests[0].path+'?limit=100&orderby=amount_percentage&direction=desc',requests,
      observation,normalized,provider_field_inventory:inventory,failures:captured.failures,
      scope:'EXACT_TOKEN_FIRST_PUBLIC_HOLDER_PAGE_NO_CURSOR',ui_comparison:'NOT_PERFORMED_JSON_SOURCE_CHECK_ONLY',trading_enabled:false};
    const output=path.resolve(__dirname,'../../v2-runtime/holders-'+crypto.randomUUID());fs.mkdirSync(output,{recursive:true});const rendered=renderReport(report);
    fs.writeFileSync(path.join(output,'holder-data.json'),JSON.stringify(report,null,2),{flag:'wx'});fs.writeFileSync(path.join(output,'top20-all-fields.csv'),rendered.csv,{flag:'wx'});fs.writeFileSync(path.join(output,'holders.html'),rendered.html,{flag:'wx'});
    const top=normalized.depth.top20;
    return{output_dir:output,coin_id:coin.coin_id,received_at:observation.received_at,holder_count:observation.raw_public.list.length,top20_qualified:top.qualified,
      fields_per_top20_union:rendered.field_count,kol_tagged_top20:top.rows.filter(r=>r.provider_kol_label.state==='GMGN_KOL_TAG_OBSERVED').length,
      kol_tagged_full_page:observation.raw_public.list.filter(r=>r.tags?.includes('kol')).length,excluded_provider_fields:[...new Set(inventory.flatMap(i=>i.excluded_row_fields))],
      preview:top.rows.map(r=>({rank:r.page_rank,address:r.address,share_pct:r.remaining_share.value,usd_value:r.remaining_usd.raw,label:r.provider_label,handle:r.provider_x_handle,tags:r.provider_tags})),browser_closed_on_return:true};
  }catch(error){const message=/^(?:HOLDER_|PROFILE_BUSY|TOKEN_JSON_)/.test(error.message)?error.message:error.name==='TimeoutError'?'HOLDER_RENDER_TIMEOUT':'HOLDER_SOURCE_UNAVAILABLE';throw Error(stage+':'+message);}
  finally{if(network)await network.finish().catch(()=>{});if(managed)await managed.close();}
}
if(require.main===module){const args=process.argv.slice(2);const coin=args.find(a=>a.startsWith('--coin='))?.slice(7);if(!args.includes('--live')||!coin){process.stderr.write('Explicit --live --coin=chain:address required.\n');process.exitCode=1;}
  else verifyHolders({coinId:coin,headless:!args.includes('--headed')}).then(r=>process.stdout.write(JSON.stringify(r)+'\n'),e=>{process.stderr.write(e.message+'\n');process.exitCode=1;});}
module.exports={verifyHolders,renderReport};
