'use strict';

// Passive, exact-token public projections. No requests, profile or service startup.
const {hash}=require('../market/network-feed');
const {identity}=require('../market/gmgn');
const {containsPrivateKeys}=require('../market/network-probe');
const {stamp,MAX_CAPTURE_AGE_MS}=require('./x-evidence');
const clone=x=>JSON.parse(JSON.stringify(x));
const BODY_FIELDS=['schema','coin_id','route','status','request_context','request_started_at','received_at','projection','raw_public','provider_updated_at','note'];
const FULL_FIELDS=('chain address symbol name logo total_supply locked_ratio creation_timestamp migrated_timestamp biggest_pool_address holder_count liquidity decimals standard launchpad launchpad_progress launchpad_status launchpad_platform migration_market_cap migration_market_cap_quote creator_address migrated_pool migrated_pool_exchange launch_quote_address banner open_timestamp creator_token_status dexscr_update_link cto_flag dexscr_update_link_ts twitter_create_token_count twitter_created_count creator_open_count priority_fee tip_fee trade_fee total_fee image_dup_count creation_tool visiting_count rug_ratio bluechip_owner_count bluechip_owner_percentage top_rat_trader_percentage top_bundler_trader_percentage top_entrapment_trader_percentage top_bot_degen_percentage creator_created_count bot_degen_count bot_degen_rate fresh_wallet_rate top_10_holder_rate dev_team_hold_rate creator_hold_rate creator_token_balance private_vault_hold_rate top70_sniper_hold_rate ath_price ath_ts ath_market_cap migration_market_cap_quote_address').split(' ');
const STAT_FIELDS=('holder_count bluechip_owner_count bluechip_owner_percentage signal_count degen_call_count top_rat_trader_percentage top_bundler_trader_percentage top_entrapment_trader_percentage top_bot_degen_percentage creator_created_count bot_degen_count bot_degen_rate fresh_wallet_rate top_10_holder_rate dev_team_hold_rate creator_hold_rate creator_token_balance private_vault_hold_rate top70_sniper_hold_rate').split(' ');
const HOLDER_FIELDS=('smart_degen_count renowned_count fresh_wallet_count dex_bot_count insider_count following_count dev_count bluechip_owner_count bundler_count sniper_count fomo_count gmgn_count pumpfun_count axiom_count').split(' ').filter(k=>k!=='following_count');
const STAT_MAP={holders_count:['holder_count','count'],top10_concentration_pct:['top_10_holder_rate','fraction'],bundler_pct_gmgn:['top_bundler_trader_percentage','fraction'],fresh_wallet_pct:['fresh_wallet_rate','fraction'],creator_holding_pct:['creator_hold_rate','fraction'],creator_created_count:['creator_created_count','count']};
const QUERY_FIELDS=new Set(['resolution','limit','from','to','pool_type']);
const WALLET_FIELDS=('address addr_type exchange native_balance balance amount_cur usd_value amount_percentage accu_amount accu_cost cost cost_cur sell_amount_cur sell_amount_percentage sell_volume_cur buy_volume_cur buy_amount_cur netflow_usd netflow_amount buy_tx_count_cur sell_tx_count_cur current_buy_amount current_sell_amount current_transfer_in_amount current_transfer_out_amount history_bought_cost history_bought_fee history_sold_income history_sold_fee history_transfer_in_amount history_transfer_in_cost history_transfer_out_amount history_transfer_out_income history_transfer_out_fee transfer_in_count transfer_out_count wallet_tag_v2 profit total_cost profit_change realized_profit realized_pnl unrealized_profit unrealized_pnl avg_cost avg_sold transfer_in is_new is_suspicious is_on_curve start_holding_at end_holding_at last_block last_active_timestamp name avatar twitter_username twitter_name created_at').split(' ');
const DEV_FIELDS=('token_address symbol chain create_timestamp is_open marcket_cap market_cap biggest_pool pool_liquidity holders swap_1h volume_1h logo bundler_rate liquidity_less_4k cto_flag dexscr_ad dexscr_update_link is_pump launchpad_platform token_ath_mc coin_creator_fee coin_creator_fee_claimable coin_creator_fee_token_address coin_creator_fee_token_symbol total_fee').split(' ');
const PRICE_FIELDS=['address','price','hot_level',...['1m','5m','1h','6h','24h'].flatMap(w=>['price','buys','sells','swaps','volume','buy_volume','sell_volume'].map(k=>k+'_'+w))];
const POOL_FIELDS=('address pool_address quote_address quote_symbol liquidity base_reserve quote_reserve initial_liquidity initial_base_reserve initial_quote_reserve creation_timestamp base_reserve_value quote_reserve_value creator exchange token0_address token1_address base_address base_symbol fee_ratio factory').split(' ');
const WINDOW_DEV_FIELDS=('address creator_address creator_token_balance creator_token_status top_10_holder_rate dexscr_ad dexscr_update_link cto_flag dexscr_boost_fee dexscr_trending_bar dexscr_ad_ts dexscr_update_link_ts dexscr_boost_ts dexscr_trending_bar_ts twitter_del_post_token_count twitter_create_token_count fund_from fund_from_ts creator_open_count offchain twitter_change_flag twitter_created_count twitter_del_post_count twitter_rename_count').split(' ');
const walletAddress=(address,coin)=>identity(`https://gmgn.ai/${coin.chain==='solana'?'sol':coin.chain}/token/${address}`).address;
function describeTokenRoute(rawUrl,coin,creatorAddress=null){
  let u;try{u=new URL(rawUrl);}catch{return null;}
  if(u.origin!=='https://gmgn.ai'||u.username||u.password||u.hash)return null;
  const c=coin.chain==='solana'?'sol':coin.chain,a=coin.address;
  const routes={
    '/mrwapi/v1/multi_token_full_info':'full_info',
    '/api/v1/mutil_window_token_info':'window_info',
    [`/api/v1/token_stat/${c}/${a}`]:'token_stat',
    [`/vas/api/v1/token_holder_stat/${c}/${a}`]:'holder_stat',
    [`/api/v1/token_fee_info/${c}/${a}`]:'pool_fee_info',
    [`/api/v1/token_mcap_candles/${c}/${a}`]:'mcap_candles',
    [`/vas/api/v1/token_holders/${c}/${a}`]:'holder_wallets'
  };
  if(creatorAddress)routes[`/api/v1/dev_created_tokens/${c}/${walletAddress(creatorAddress,coin)}`]='developer_history';
  const kind=routes[u.pathname];if(!kind)return null;
  const keys=new Set([...QUERY_FIELDS,...(kind==='holder_wallets'?['orderby','direction']:[])]);
  const query=Object.fromEntries([...u.searchParams].filter(([k,v])=>keys.has(k)&&/^[A-Za-z0-9_.-]{1,40}$/.test(v)));
  const holderScope=kind==='holder_wallets'?{first_page_scope_verified:
    [...u.searchParams].length===3&&['limit','orderby','direction'].every(k=>u.searchParams.getAll(k).length===1)&&
    query.orderby==='amount_percentage'&&query.direction==='desc'&&/^[1-9]\d{0,3}$/.test(query.limit??'')&&Number(query.limit)<=1000}:{};
  return{kind,path:u.pathname,query,...holderScope,...(kind==='developer_history'?{creator_address:walletAddress(creatorAddress,coin)}:{})};
}
function scalarProjection(input,fields){
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('TOKEN_JSON_RECORD_INVALID');
  return Object.fromEntries(fields.filter(k=>Object.hasOwn(input,k)).map(k=>{
    const v=input[k];if(v!==null&&!['string','number','boolean'].includes(typeof v))throw Error('TOKEN_JSON_FIELD_SHAPE:'+k);
    if(typeof v==='number'&&!Number.isFinite(v))throw Error('TOKEN_JSON_NONFINITE');return[k,v];
  }));
}
function numeric(raw,unit){
  if(raw===null||raw===undefined)return{value:null,raw:raw??null,state:'MISSING',unit};
  if(!['number','string'].includes(typeof raw)||(typeof raw==='string'&&!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)))return{value:null,raw,state:'INVALID',unit};
  let value=Number(raw);
  if(!Number.isFinite(value)||value<0||(unit==='count'&&!Number.isSafeInteger(value))||(unit==='fraction'&&value>1))return{value:null,raw,state:'INVALID',unit};
  if(unit==='fraction')value*=100;
  return{value,raw,state:'OBSERVED',unit:unit==='fraction'?'percent':unit};
}
function publicTokenRequest(raw,coin){
  if(raw?.chain!==(coin.chain==='solana'?'sol':coin.chain)||!Array.isArray(raw.addresses)||!raw.addresses.length||raw.addresses.length>100)return null;
  const requested=raw.addresses.some(a=>typeof a==='string'&&(coin.chain==='robinhood'?a.toLowerCase():a)===coin.address);
  return requested?{chain:raw.chain,address:coin.address,requested_address_count:raw.addresses.length}:null;
}
function projectResponse(body,route,coin,requestContext=null){
  if(body?.code!==0||!body.data)throw Error('TOKEN_JSON_PROVIDER_FAILURE');
  if(route.kind==='full_info'){
    if(!Array.isArray(body.data))throw Error('TOKEN_JSON_FULL_INFO_SHAPE');
    const matches=body.data.filter(r=>r?.chain===(coin.chain==='solana'?'sol':coin.chain)&&
      (coin.chain==='robinhood'?r.address?.toLowerCase():r.address)===coin.address);
    if(matches.length!==1)throw Error('TOKEN_JSON_IDENTITY_MISMATCH');
    // The mixed response contains non-public fields: only proven token scalars
    // are retained. Auth/account sections are never copied or logged.
    const data=scalarProjection(matches[0],FULL_FIELDS);
    const links=scalarProjection(matches[0].link??{},['twitter','website','telegram','discord','github','youtube','tiktok','instagram']);
    if(Object.keys(links).length)data.link=links;
    return{data,projection:'EXPLICIT_PUBLIC_FIELDS_ONLY'};
  }
  if(route.kind==='window_info'){
    const c=coin.chain==='solana'?'sol':coin.chain;
    if(requestContext?.chain!==c||requestContext?.address!==coin.address||!Number.isInteger(requestContext.requested_address_count)||requestContext.requested_address_count<1||requestContext.requested_address_count>100)throw Error('TOKEN_JSON_CHAIN_REQUEST_UNVERIFIED');
    if(!Array.isArray(body.data))throw Error('TOKEN_JSON_WINDOW_INFO_SHAPE');
    const matches=body.data.filter(r=>(coin.chain==='robinhood'?r?.address?.toLowerCase():r?.address)===coin.address);
    if(matches.length!==1)throw Error('TOKEN_JSON_IDENTITY_MISMATCH');
    const row=matches[0],data=scalarProjection(row,[...FULL_FIELDS,'circulating_supply','max_supply']);
    for(const [key,fields]of Object.entries({price:PRICE_FIELDS,pool:POOL_FIELDS,dev:WINDOW_DEV_FIELDS}))if(row[key]!==null&&row[key]!==undefined){
      const address=row[key].address;
      if((coin.chain==='robinhood'?address?.toLowerCase():address)!==coin.address)throw Error('TOKEN_JSON_NESTED_IDENTITY');
      data[key]=scalarProjection(row[key],fields);
    }
    return{data,projection:'PUBLIC_MARKET_WINDOW_WITH_EXACT_CHAIN_REQUEST'};
  }
  if(containsPrivateKeys(body))throw Error('TOKEN_JSON_PRIVATE_RESPONSE_REJECTED');
  if(route.kind==='token_stat')return{data:scalarProjection(body.data,STAT_FIELDS),projection:'EXPLICIT_PUBLIC_FIELDS_ONLY'};
  if(route.kind==='holder_stat')return{data:scalarProjection(body.data,HOLDER_FIELDS),projection:'PUBLIC_AGGREGATES_WITHOUT_PERSONAL_FOLLOWING'};
  if(route.kind==='pool_fee_info'){
    const a=body.data.address;
    if((coin.chain==='robinhood'?a?.toLowerCase():a)!==coin.address)throw Error('TOKEN_JSON_IDENTITY_MISMATCH');
    return{data:clone(body.data),projection:'PUBLIC_EXACT_TOKEN_POOL_TAX_DATA'};
  }
  if(route.kind==='mcap_candles'){
    if(!Array.isArray(body.data.list)||body.data.list.length>5000)throw Error('TOKEN_JSON_CANDLE_LIST_INVALID');
    return{data:{list:body.data.list.map(c=>scalarProjection(c,['time','open','high','low','close','volume','source','amount']))},projection:'PUBLIC_MCAP_CANDLES'};
  }
  if(route.kind==='holder_wallets'){
    if(!Array.isArray(body.data.list)||body.data.list.length>1000)throw Error('TOKEN_JSON_HOLDER_LIST_INVALID');
    const seen=new Set();
    const list=body.data.list.map(row=>{
      const address=walletAddress(row.address,coin);
      if(seen.has(address))throw Error('TOKEN_JSON_HOLDER_DUPLICATE_ADDRESS');seen.add(address);
      const result=scalarProjection(row,WALLET_FIELDS);
      for(const key of ['name','twitter_username','twitter_name','wallet_tag_v2','exchange'])
        if(Object.hasOwn(row,key)&&row[key]!==null&&typeof row[key]!=='string')throw Error('TOKEN_JSON_HOLDER_LABEL_INVALID');
      for(const key of ['tags','maker_token_tags'])if(Object.hasOwn(row,key)){
        if(row[key]!==null&&(!Array.isArray(row[key])||row[key].some(v=>typeof v!=='string')))throw Error('TOKEN_JSON_HOLDER_TAGS_INVALID');
        result[key]=clone(row[key]);
      }
      // Public counterpart/transaction metadata observed in normal holder JSON.
      // This is a transfer receipt, never proof of a buy or common ownership.
      for(const key of ['native_transfer','token_transfer','token_transfer_in','token_transfer_out'])if(Object.hasOwn(row,key)){
        if(row[key]===null){result[key]=null;continue;}
        const transfer=scalarProjection(row[key],['name','address','timestamp','tx_hash','type']);
        for(const label of ['name','address','tx_hash','type'])if(Object.hasOwn(transfer,label)&&transfer[label]!==null&&typeof transfer[label]!=='string')throw Error('TOKEN_JSON_TRANSFER_FIELD_INVALID');
        if(transfer.timestamp!==undefined&&transfer.timestamp!==null&&(typeof transfer.timestamp!=='number'||!Number.isFinite(transfer.timestamp)||transfer.timestamp<0))throw Error('TOKEN_JSON_TRANSFER_TIME_INVALID');
        result[key]=transfer;
      }
      return result;
    });
    if(!Object.hasOwn(body.data,'next')||!(body.data.next===null||typeof body.data.next==='string'))throw Error('TOKEN_JSON_HOLDER_PAGINATION_UNVERIFIED');
    return{data:{...scalarProjection(body.data,['total','total_count']),list,next:body.data.next},projection:'PUBLIC_HOLDER_WALLETS_WITHOUT_PERSONAL_ACCOUNT_STATE'};
  }
  if(route.kind==='developer_history'){
    if(!Array.isArray(body.data.tokens)||body.data.tokens.length>1000)throw Error('TOKEN_JSON_DEV_LIST_INVALID');
    const data=scalarProjection(body.data,['last_create_timestamp','inner_count','open_count','open_ratio']);
    data.creator_ath_info=scalarProjection(body.data.creator_ath_info??{},['creator','ath_token','ath_mc','token_symbol','token_logo','token_name']);
    if(data.creator_ath_info.creator&&walletAddress(data.creator_ath_info.creator,coin)!==route.creator_address)throw Error('TOKEN_JSON_CREATOR_MISMATCH');
    data.tokens=body.data.tokens.map(r=>scalarProjection(r,DEV_FIELDS));
    return{data,projection:'PUBLIC_CREATOR_TOKEN_SAMPLE_NOT_COMPLETE_HISTORY'};
  }
  throw Error('TOKEN_JSON_ROUTE_UNSUPPORTED');
}
function buildObservation({body,url,status=200,coin,creatorAddress=null,request_context=null,request_started_at,received_at}){
  const route=describeTokenRoute(url,coin,creatorAddress);if(!route)throw Error('TOKEN_JSON_ROUTE_MISMATCH');
  if(status!==200)throw Error('TOKEN_JSON_HTTP_FAILURE');
  if(request_context&&hash(scalarProjection(request_context,['chain','address','requested_address_count']))!==hash(request_context))throw Error('TOKEN_JSON_REQUEST_CONTEXT_NOT_PUBLIC');
  const projected=projectResponse(body,route,coin,request_context);
  if(containsPrivateKeys(projected))throw Error('TOKEN_JSON_PRIVATE_PROJECTION_REJECTED');
  const value={schema:'alphahands.token-network.v2',coin_id:coin.coin_id,route,status,request_context,request_started_at,received_at,
    projection:projected.projection,raw_public:projected.data,provider_updated_at:null,
    note:'Normal page response; receipt time is not a verified server update time. Not an executable quote.'};
  return{id:hash(value),...value};
}
function normalizedFields(observation){
  const raw=observation.raw_public,out={};
  if(['full_info','token_stat'].includes(observation.route.kind))for(const [name,[key,unit]]of Object.entries(STAT_MAP))out[name]=numeric(raw[key],unit);
  if(observation.route.kind==='full_info'){
    out.total_fees_native=numeric(raw.total_fee,observation.coin_id.startsWith('solana:')?'SOL':'ETH');
    out.liquidity_usd=numeric(raw.liquidity,'USD');out.ath_market_cap_usd=numeric(raw.ath_market_cap,'USD');
  }
  if(observation.route.kind==='holder_stat')for(const key of HOLDER_FIELDS)out[key]=numeric(raw[key],'count');
  if(observation.route.kind==='window_info'){
    out.price_usd=numeric(raw.price?.price,'USD');out.volume_24h_usd=numeric(raw.price?.volume_24h,'USD');
    out.liquidity_usd=numeric(raw.liquidity,'USD');out.holders_count=numeric(raw.holder_count,'count');
    out.total_fees_native=numeric(raw.total_fee,observation.coin_id.startsWith('solana:')?'SOL':'ETH');
    const supply=numeric(raw.circulating_supply,'TOKEN'),price=out.price_usd;out.circulating_supply=supply;
    const value=price.state==='OBSERVED'&&supply.state==='OBSERVED'?price.value*supply.value:null;
    out.derived_market_cap_usd={value:Number.isFinite(value)?value:null,state:value===null?'MISSING':!Number.isFinite(value)?'INVALID':'DERIVED',unit:'USD',
      formula:'circulating_supply * price_usd',inputs:{circulating_supply:raw.circulating_supply??null,price:raw.price?.price??null}};
  }
  return out;
}
function normalizeCandles(observation,now){
  if(observation.route.kind!=='mcap_candles')return null;
  const resolution=observation.route.query.resolution??null,rows=[],reasons=[];let previous=-1;
  for(const c of observation.raw_public.list){
    const time=c.time,values=Object.fromEntries(['open','high','low','close'].map(k=>[k,numeric(c[k],'USD_MARKET_CAP')]));
    if(!Number.isSafeInteger(time)||time<1000000000000||time>now||time<=previous||Object.values(values).some(v=>v.state!=='OBSERVED')||
      values.low.value>Math.min(values.open.value,values.close.value)||values.high.value<Math.max(values.open.value,values.close.value)||values.low.value>values.high.value){reasons.push('CANDLE_TIME_ORDER_OR_OHLC_INVALID');break;}
    previous=time;rows.push({time_ms:time,...Object.fromEntries(Object.entries(values).map(([k,v])=>[k,v.value])),
      raw_volume:c.volume??null,raw_amount:c.amount??null,volume_unit:'UNVERIFIED'});
  }
  if(!rows.length)reasons.push('CANDLES_EMPTY');
  if(!/^(?:1s|5s|15s|30s|1m|5m|15m|30m|1h|4h|1d)$/.test(resolution??''))reasons.push('CANDLE_RESOLUTION_UNVERIFIED');
  return{state:reasons.length?'UNVERIFIED':'QUALIFIED_OBSERVED_WINDOW',resolution,rows:reasons.includes('CANDLE_TIME_ORDER_OR_OHLC_INVALID')?[]:rows,
    reasons,complete_history:false,execution_qualified:false,note:'Sparse observed MC bars; no invented missing bars, fills, volume units or full-history claim.'};
}
function holderDepth(observation,coin){
  const raw=observation.raw_public,query=observation.route.query,reasons=[],seen=new Set();let previous=Infinity;
  const totals={total:numeric(raw.total,'count'),total_count:numeric(raw.total_count,'count')};
  for(const total of Object.values(totals)){
    if(total.state==='INVALID')reasons.push('PROVIDER_TOTAL_INVALID');
    if(total.state==='OBSERVED'&&total.value<raw.list.length)reasons.push('PROVIDER_TOTAL_BELOW_RETURNED_COUNT');
  }
  const labelFields=['name','twitter_username','twitter_name','wallet_tag_v2','tags','maker_token_tags','exchange','addr_type'];
  const rows=raw.list.map((r,index)=>{
    const address=walletAddress(r.address,coin),share=numeric(r.amount_percentage,'fraction');
    if(seen.has(address))reasons.push('DUPLICATE_WALLET');seen.add(address);
    if(share.state!=='OBSERVED')reasons.push('SHARE_MISSING_OR_INVALID');
    else{if(share.value>previous)reasons.push('PROVIDER_ORDER_NOT_DESCENDING');previous=share.value;}
    const providerRank=typeof r.wallet_tag_v2==='string'&&/^TOP[1-9]\d*$/.test(r.wallet_tag_v2)?Number(r.wallet_tag_v2.slice(3)):null;
    if(providerRank!==null&&providerRank!==index+1)reasons.push('PROVIDER_RANK_CONFLICT');
    const labels=Object.fromEntries(labelFields.map(key=>[key,{state:!Object.hasOwn(r,key)?'MISSING':r[key]===null?'NULL':'OBSERVED',value:clone(r[key]??null)}]));
    return{page_rank:index+1,provider_rank:providerRank,provider_rank_raw:r.wallet_tag_v2??null,
      chain:coin.chain,token_coin_id:coin.coin_id,wallet_id:coin.chain+':'+address,address,provider_address:r.address,
      remaining_share:share,remaining_usd:numeric(r.usd_value,'USD'),remaining_tokens:numeric(Object.hasOwn(r,'amount_cur')?r.amount_cur:r.balance,'TOKEN'),
      provider_label:r.name??null,provider_x_handle:r.twitter_username??null,provider_exchange:r.exchange??null,
      provider_tags:r.tags??null,provider_token_tags:r.maker_token_tags??null,labels,
      label_provenance:{provider:'GMGN',observation_id:observation.id??null,path:observation.route.path,source_row_index:index,received_at:observation.received_at,provider_updated_at:observation.provider_updated_at},
      provider_kol_label:{state:r.tags?.includes('kol')?'GMGN_KOL_TAG_OBSERVED':'UNKNOWN',source_field:'tags',raw_tag:r.tags?.includes('kol')?'kol':null},
      kol_attribution:'UNVERIFIED',kol_note:'Only the exact provider labels are observed. Names, handles or absent labels do not establish or disprove KOL identity, ownership, fresh buying or conviction.',
      pool_exclusion:'NONE',pool_attribution:{exchange:r.exchange??null,addr_type:r.addr_type??null,name:r.name??null,interpretation:'RAW_PROVIDER_CLAIMS_ONLY'},
      provider_times:scalarProjection(r,['start_holding_at','end_holding_at','last_active_timestamp','created_at','last_block']),
      native_balance_raw:r.native_balance??null,native_balance_unit:'PROVIDER_BASE_UNITS_UNVERIFIED',
      note:'Pool/bot labels and profile attribution are provider claims. Transfers, cumulative PnL and a labelled holder are not proof of a fresh KOL buy or conviction.'};
  });
  if(observation.route.first_page_scope_verified!==true)reasons.push('FIRST_PAGE_UNFILTERED_SCOPE_UNVERIFIED');
  if(raw.list.length>Number(query.limit))reasons.push('RETURNED_COUNT_EXCEEDS_REQUEST');
  const hasMore=raw.next!==null&&raw.next!=='',requested=20,selected=rows.slice(0,requested);
  if(selected.length<requested)reasons.push('FEWER_THAN_20_OBSERVED');
  const uniqueReasons=[...new Set(reasons)],top20={state:uniqueReasons.length?'UNVERIFIED_TOP20':'QUALIFIED_OBSERVED_TOP20',
    requested_count:requested,returned_count:selected.length,complete_top20:uniqueReasons.length===0,reasons:uniqueReasons,
    rank_basis:'PROVIDER_FIRST_PAGE_AMOUNT_PERCENTAGE_DESCENDING_WITH_OBSERVED_ORDER_CHECK',
    rows:selected,excluded_rows:[],pool_policy:'INCLUDE_ALL_PROVIDER_ROWS; NO_INFERRED_POOL_EXCLUSION',
    complete_wallet_list:false,source_page_returned_count:raw.list.length,has_more:hasMore,
    provider_total_fields:clone(totals),
    provider_updated_at:observation.provider_updated_at,received_at:observation.received_at};
  return{state:'PARTIAL_OBSERVED_PAGE',returned_count:raw.list.length,has_more:hasMore,complete_wallet_list:false,
    provider_total_fields:clone(totals),
    order:query,rows:rows.map(({labels,label_provenance,provider_times,...row})=>row),top20,
    activity_window:'UNVERIFIED_PROVIDER_CURRENT_WINDOW',bot_account_fills:false};
}
function depthForPacket(observation,coin){
  const raw=observation.raw_public;
  if(observation.route.kind==='holder_wallets')return holderDepth(observation,coin);
  if(observation.route.kind==='developer_history')return{state:'PARTIAL_PROVIDER_SAMPLE',returned_count:raw.tokens.length,complete_history:false,
    creator_address:observation.route.creator_address,total_migrated:numeric(raw.open_count,'count'),total_unmigrated:numeric(raw.inner_count,'count'),
    reported_migrated_share:numeric(raw.open_ratio,'fraction'),rows:raw.tokens.map((r,index)=>{
      let id=null;try{id=identity(`https://gmgn.ai/${r.chain}/token/${r.token_address}`).coin_id;}catch{}
      return{provider_index:index,coin_id:id,state:id?'IDENTITY_QUALIFIED':'UNVERIFIED_TOKEN_IDENTITY',
        current_mc:numeric(r.market_cap,'USD'),ath_mc:numeric(r.token_ath_mc,'USD'),
        total_fees:numeric(r.total_fee,r.chain==='sol'?'SOL':r.chain==='robinhood'?'ETH':'UNVERIFIED_NATIVE_UNIT'),
        note:'Creator-history observations may lag the main token page. No fee/price substitution, developer score or full-history claim.'};
    })};
  return null;
}
function observationForPacket(observation,coin,now=Date.now(),creatorAddress=null){
  const id=observation.id,body=Object.fromEntries(BODY_FIELDS.filter(k=>Object.hasOwn(observation,k)).map(k=>[k,observation[k]]));
  if(body.schema!=='alphahands.token-network.v2'||hash(body)!==id)throw Error('TOKEN_JSON_INTEGRITY');
  if(body.coin_id!==coin.coin_id)throw Error('TOKEN_JSON_IDENTITY_MISMATCH');
  if(body.request_context&&hash(scalarProjection(body.request_context,['chain','address','requested_address_count']))!==hash(body.request_context))throw Error('TOKEN_JSON_REQUEST_CONTEXT_NOT_PUBLIC');
  const route=describeTokenRoute('https://gmgn.ai'+body.route.path+'?'+new URLSearchParams(body.route.query),coin,creatorAddress);
  if(!route||route.kind!==body.route.kind)throw Error('TOKEN_JSON_ROUTE_MISMATCH');
  if(body.route.creator_address!==route.creator_address)throw Error('TOKEN_JSON_CREATOR_MISMATCH');
  if(body.route.first_page_scope_verified===true&&route.first_page_scope_verified!==true)throw Error('TOKEN_JSON_HOLDER_SCOPE_MISMATCH');
  // Re-apply the public projection on consumption; an extra private key cannot
  // acquire authority merely by receiving a new content hash.
  if(containsPrivateKeys(body.raw_public))throw Error('TOKEN_JSON_PRIVATE_RESPONSE_REJECTED');
  const projected=projectResponse({code:0,data:['full_info','window_info'].includes(body.route.kind)?[body.raw_public]:body.raw_public},route,coin,body.request_context);
  if(hash(projected.data)!==hash(body.raw_public)||projected.projection!==body.projection)throw Error('TOKEN_JSON_PUBLIC_PROJECTION_MISMATCH');
  const query=describeTokenRoute('https://gmgn.ai'+body.route.path+'?'+new URLSearchParams(body.route.query),coin,creatorAddress).query;
  if(hash(query)!==hash(body.route.query))throw Error('TOKEN_JSON_QUERY_NOT_PUBLIC');
  const start=stamp(body.request_started_at),at=stamp(body.received_at),fresh=Number.isFinite(start)&&Number.isFinite(at)&&start<=at&&at<=now&&now-at<=MAX_CAPTURE_AGE_MS;
  const fields=normalizedFields(body),invalid=Object.entries(fields).filter(([,v])=>v.state==='INVALID').map(([k])=>k);
  if(creatorAddress&&body.route.kind==='full_info'&&body.raw_public.creator_address&&walletAddress(body.raw_public.creator_address,coin)!==walletAddress(creatorAddress,coin))invalid.push('creator_address');
  const candles=normalizeCandles(body,now),candlesQualified=!candles||candles.state==='QUALIFIED_OBSERVED_WINDOW';
  const depth=depthForPacket({id,...body},coin);
  if(depth)depth.unverified_row_indexes=depth.rows.flatMap((r,i)=>r.state==='UNVERIFIED_TOKEN_IDENTITY'||Object.values(r).some(v=>v?.state==='INVALID')?[i]:[]);
  if(depth?.top20){
    depth.top20.qualified=fresh&&depth.top20.complete_top20&&!depth.unverified_row_indexes.length;
    if(depth.unverified_row_indexes.length){depth.top20.state='UNVERIFIED_TOP20';depth.top20.reasons.push('INVALID_DEPTH_ROWS');}
    if(!fresh){depth.top20.state='UNVERIFIED_TOP20';depth.top20.reasons.push('OBSERVATION_TIME_UNVERIFIED');}
  }
  return{id,...clone(body),qualified:fresh&&invalid.length===0&&candlesQualified&&!depth?.unverified_row_indexes.length,
    qualification_status:!fresh?'UNVERIFIED_TIME':invalid.length?'INVALID_FIELDS':!candlesQualified?'UNVERIFIED_CANDLES':depth?.unverified_row_indexes.length?'UNVERIFIED_DEPTH_ROWS':'QUALIFIED_PUBLIC_OBSERVATION',
    invalid_fields:invalid,fields,candles,depth};
}
function observeTokenResponses(page,coin,{now=()=>Date.now(),maxObservations=32,finishTimeoutMs=10000}={}){
  if(!Number.isInteger(maxObservations)||maxObservations<1||maxObservations>64||!Number.isInteger(finishTimeoutMs)||finishTimeoutMs<1||finishTimeoutMs>30000)throw Error('TOKEN_JSON_CAPTURE_BOUNDS');
  const observations=[],failures=[],pending=new Set();let accepting=true,sealed=false,finished,creatorAddress=null;
  const requestTimes=new WeakMap(),onRequest=r=>{
    let context=null;
    if(describeTokenRoute(r.url?.(),coin,creatorAddress)?.kind==='window_info')try{context=publicTokenRequest(r.postDataJSON(),coin);}catch{}
    requestTimes.set(r,{at:new Date(now()).toISOString(),context});
  };
  const onResponse=response=>{
    if(!accepting||!describeTokenRoute(response.url(),coin,creatorAddress))return;
    const request=requestTimes.get(response.request());if(!request)return;
    if(observations.length+pending.size>=maxObservations){if(failures.length<32)failures.push({reason:'TOKEN_JSON_CAPTURE_BOUND'});return;}
    const received=new Date(now()).toISOString();
    const task=(async()=>{try{
      if(response.status()!==200)throw Error('TOKEN_JSON_HTTP_FAILURE');
      const bytes=await response.body();if(bytes.length>2*1024*1024)throw Error('TOKEN_JSON_OVERSIZE');
      const o=buildObservation({body:JSON.parse(bytes.toString('utf8')),url:response.url(),status:response.status(),coin,creatorAddress,request_context:request.context,request_started_at:request.at,received_at:received});
      if(!sealed)observations.push(o);
    }catch(e){if(!sealed&&failures.length<32)failures.push({path:describeTokenRoute(response.url(),coin,creatorAddress).path,reason:/^TOKEN_JSON_[A-Z_]+(?::[a-z_]+)?$/.test(e.message)?e.message:'TOKEN_JSON_UNREADABLE'});}})();
    pending.add(task);task.finally(()=>pending.delete(task));
  };
  page.on('request',onRequest);page.on('response',onResponse);
  return{setCreator(address){const next=walletAddress(address,coin);if(creatorAddress&&creatorAddress!==next)throw Error('TOKEN_JSON_CREATOR_CHANGED');creatorAddress=next;},
    hasObservation(kind,query={}){return observations.some(o=>{
      if(o.route.kind!==kind||Object.entries(query).some(([k,v])=>o.route.query[k]!==v))return false;
      return observationForPacket(o,coin,now(),creatorAddress).qualified;
    });},finish(){
    if(finished)return finished;
    accepting=false;page.off('request',onRequest);page.off('response',onResponse);
    finished=(async()=>{
      let timer;const timedOut=await Promise.race([Promise.allSettled([...pending]).then(()=>false),new Promise(resolve=>{timer=setTimeout(()=>resolve(true),finishTimeoutMs);})]);
      clearTimeout(timer);sealed=true;if(timedOut)failures.push({reason:'TOKEN_JSON_CAPTURE_TIMEOUT'});
      return{observations:clone(observations),failures:clone(failures)};
    })();return finished;
  }};
}
async function requestTokenDepthFromPage(page,coin,creatorAddress=null,{reuse=()=>false}={}){
  const c=coin.chain==='solana'?'sol':coin.chain;
  const routes=[`/vas/api/v1/token_holders/${c}/${coin.address}?limit=100&orderby=amount_percentage&direction=desc`];
  if(creatorAddress)routes.push(`/api/v1/dev_created_tokens/${c}/${walletAddress(creatorAddress,coin)}`);
  const results=[];
  for(const route of routes){
    if(identity(page.url()).coin_id!==coin.coin_id)throw Error('TOKEN_JSON_PAGE_CHANGED');
    const described=describeTokenRoute('https://gmgn.ai'+route,coin,creatorAddress);
    if(reuse(described.kind,described.query)){results.push({path:described.path,status:200,reused_observation:true});continue;}
    // Replay only the public routes observed from the normal website. Browser
    // credentials remain internal; neither headers nor auth query values leave it.
    const result=await page.evaluate(async route=>{
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
      let status=null;
      try{
        const response=await fetch(route,{credentials:'include',signal:controller.signal});status=response.status;
        const reader=response.body?.getReader();let size=0;
        if(reader)for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;
          if(size>2*1024*1024){controller.abort();return{status,error_type:'BODY_OVERSIZE'};}}
        return{status};
      }catch(e){return{status,error_type:e.name};}finally{clearTimeout(timer);}
    },route);
    results.push({path:route.split('?')[0],status:result.status,reused_observation:false,...(result.error_type?{error_type:result.error_type}:{})});
  }
  return results;
}
module.exports={describeTokenRoute,projectResponse,buildObservation,observationForPacket,observeTokenResponses,requestTokenDepthFromPage,publicTokenRequest,numeric,normalizeCandles};
