'use strict';

// Owner-supplied GMGN exports -> explicit public network requests. No browser UI,
// storage injection, auth access, V1 filter imports or side effects.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const CRITERIA=new Set(['frozen','not_honeypot','verified','renounced','is_burnt',
  'is_wash_trading','is_show_alert','has_social','has_at_least_one_social','is_migrated',
  'is_not_migrated','is_original_social','is_original_avatar','is_update_social',
  'owner_renounced','dev_still_holding','dev_sell_all','dev_burnt']);
function positive(raw,name){
  if(typeof raw!=='string'||!/^\d+(?:\.\d+)?$/.test(raw)||!Number.isFinite(Number(raw))||Number(raw)<=0||Number(raw)>Number.MAX_SAFE_INTEGER)throw Error('INVALID_FILTER:'+name);
  return Number(raw);
}
function compileImport(config,{platformScope}={}){
  if(platformScope!=='ALL_CURRENT_GMGN')throw Error('EXPLICIT_PLATFORM_SCOPE_REQUIRED');
  if(!config||!['sol','robinhood'].includes(config.network)||config.tab!=='trending')throw Error('WRONG_FILTER_SCOPE');
  if(Object.keys(config).some(k=>!['id','network','tab','filterQuery','keywordSearch','timeType'].includes(k)))throw Error('UNKNOWN_IMPORT_FIELDS');
  if(!Array.isArray(config.keywordSearch)||config.keywordSearch.length)throw Error('KEYWORD_SCOPE_NOT_SUPPORTED');
  if(config.timeType?.min!=='d'||!['d','h'].includes(config.timeType?.max))throw Error('FILTER_AGE_UNITS');
  const q=config.filterQuery;if(!q||typeof q!=='object'||Array.isArray(q))throw Error('FILTER_QUERY_MISSING');
  const age=positive(q.max_created,'max_created'),fee=positive(q.min_gas_fee,'min_gas_fee');
  const ageMinutes=age*(config.timeType.max==='h'?60:1440);
  if(!Number.isFinite(ageMinutes)||ageMinutes>Number.MAX_SAFE_INTEGER)throw Error('INVALID_FILTER:max_created');
  // GMGN's observed all-selected builder emits [] after expanding its current
  // platform registry. A literal export-key list can omit new/aliased platforms.
  const filter={filters:[],max_created:String(ageMinutes)+'m',min_gas_fee:fee,limit:500,launchpad_platform:[]};
  // Trending displays MC in K, but its exported filterQuery and request both
  // store USD. The public MCFilterItem multiplies the UI input before export.
  if(q.min_marketcap!==undefined){
    filter.min_marketcap=positive(q.min_marketcap,'min_marketcap');
    if(filter.min_marketcap>Number.MAX_SAFE_INTEGER)throw Error('INVALID_FILTER:min_marketcap');
  }
  let selected=0;
  for(const [key,value]of Object.entries(q)){
    if(['max_created','min_gas_fee','min_marketcap'].includes(key))continue;
    if(/^(?:min|max)_/.test(key)||['__proto__','constructor','prototype'].includes(key))throw Error('UNSUPPORTED_FILTER_FIELD:'+key);
    if(!/^[A-Za-z0-9_.:-]{1,100}$/.test(key)||!['0','1'].includes(value))throw Error('UNKNOWN_FILTER_FIELD:'+key);
    if(CRITERIA.has(key)){
      // Owner's actual Trending sheet was checked live on 2026-10-28:
      // NoMint maps to renounced in GMGN's public request builder.
      if(key==='renounced'&&value==='1'&&config.network==='sol')filter.filters.push('renounced');
      else if(value!=='0')throw Error('UNAPPROVED_SCREENING_CRITERION:'+key);
    }
    else if(value==='1')selected++;
    else throw Error('PARTIAL_LAUNCHPAD_SCOPE_NOT_QUALIFIED');
  }
  if(!selected)throw Error('EMPTY_LAUNCHPAD_SCOPE');
  return{chain:config.network,interval:'24h',filter};
}
function loadOwnerFilters(root=path.join(__dirname,'filters')){
  const configs=[],manifest=[];
  for(const chain of ['sol','robinhood']){
    const file=path.join(root,chain+'.json'),stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw Error('INVALID_FILTER_FILE');
    const bytes=fs.readFileSync(file),config=JSON.parse(bytes.toString('utf8'));
    if(config.network!==chain)throw Error('FILTER_FILE_CHAIN_MISMATCH');
    configs.push(compileImport(config,{platformScope:'ALL_CURRENT_GMGN'}));
    manifest.push({file:chain+'.json',sha256:crypto.createHash('sha256').update(bytes).digest('hex'),launchpad_scope:'ALL_CURRENT_GMGN'});
  }
  return{request:{meta:{},params:configs},manifest};
}
module.exports={compileImport,loadOwnerFilters};
