'use strict';

// Pure compilation of the owner's Completed exports. Public GMGN definitions
// pin quote IDs, platform aliases and facet semantics; no storage/UI mutation.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const definitions=require('./fixtures/gmgn-filter-definitions-2026-10-29.json');
const clone=x=>JSON.parse(JSON.stringify(x));
const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const ranges={usd_market_cap:['marketcap',1],total_fee:['total_fee',1],
  bundler_rate:['bundler_rate',.01],entrapment_ratio:['entrapment_ratio',.01],fresh_wallet_rate:['fresh_wallet_rate',.01]};
function switches(value,label){
  if(!object(value)||Object.values(value).some(v=>typeof v!=='boolean'))throw Error('INVALID_MIGRATED_SWITCHES:'+label);
  return Object.keys(value).filter(k=>value[k]);
}
function compileMigratedImport(config,{limit=60}={}){
  const keys=['currentPage','network','dex','quote','facets','metricsRange','tweetAgeRange','metricsSelect','social','inputKeywords'];
  if(!object(config)||config.currentPage!=='Completed'||!['sol','robinhood'].includes(config.network))throw Error('WRONG_MIGRATED_SCOPE');
  if(keys.some(k=>!Object.hasOwn(config,k))||Object.keys(config).some(k=>!keys.includes(k)))throw Error('MIGRATED_IMPORT_FIELDS');
  if(!Number.isInteger(limit)||limit<1||limit>500)throw Error('MIGRATED_LIMIT');
  const catalog=definitions.networks[config.network],selected=switches(config.dex,'dex'),platforms=new Set();
  const facets=switches(config.facets,'facets');
  if(catalog.facets.some(f=>!Object.hasOwn(config.facets,f.key)))throw Error('MIGRATED_FACETS_INCOMPLETE');
  for(const key of Object.keys(config.facets))if(!catalog.facets.some(f=>f.key===key))throw Error('UNKNOWN_MIGRATED_FACET:'+key);
  if(!selected.length)throw Error('EMPTY_MIGRATED_PLATFORMS');
  for(const key of Object.keys(config.dex))if(!catalog.platforms.some(p=>p.key===key||p.group===key))throw Error('UNKNOWN_MIGRATED_PLATFORM:'+key);
  const effectivePlatforms=[...new Set([...selected,...catalog.facets.filter(f=>facets.includes(f.key)).map(f=>f.owner)])];
  for(const key of effectivePlatforms){
    const grouped=catalog.platforms.filter(p=>p.group===key),own=catalog.platforms.find(p=>p.key===key);
    for(const p of grouped.length?[...grouped,...(own?[own]:[])]:[own]){
      platforms.add(p.key);for(const child of p.children)platforms.add(child);
    }
    if(grouped.length&&!own)platforms.add(key);
  }
  const quoteKeys=switches(config.quote,'quote'),quotes=new Set();
  if(catalog.quotes.some(q=>!Object.hasOwn(config.quote,q.key)))throw Error('MIGRATED_QUOTES_INCOMPLETE');
  if(!quoteKeys.length)throw Error('EMPTY_MIGRATED_QUOTES');
  for(const key of Object.keys(config.quote))if(!catalog.quotes.some(q=>q.key===key))throw Error('UNKNOWN_MIGRATED_QUOTE:'+key);
  for(const key of quoteKeys)for(const type of catalog.quotes.find(q=>q.key===key).types)quotes.add(type);
  const filters=new Set();
  for(const facet of catalog.facets){
    if(selected.includes(facet.owner))for(const filter of facet.owner_filters)filters.add(filter);
    if(facets.includes(facet.key))for(const filter of facet.selected_filters)filters.add(filter);
  }
  const audits=switches(config.metricsSelect,'metricsSelect');
  for(const filter of audits){
    if(config.network!=='robinhood'||!['not_honeypot','open_source','owner_renounced','is_burnt'].includes(filter))throw Error('UNSUPPORTED_MIGRATED_AUDIT:'+filter);
    filters.add(filter);
  }
  if(switches(config.social,'social').length)throw Error('UNSUPPORTED_MIGRATED_SOCIAL_FILTER');
  if(!object(config.inputKeywords)||Object.keys(config.inputKeywords).length)throw Error('UNSUPPORTED_MIGRATED_KEYWORDS');
  const completed={filters:[...filters]};
  for(const group of ['metricsRange','tweetAgeRange']){
    if(!object(config[group]))throw Error('INVALID_MIGRATED_RANGES');
    for(const [key,bounds]of Object.entries(config[group])){
      if(!object(bounds)||Object.keys(bounds).sort().join(',')!=='max,min')throw Error('INVALID_MIGRATED_BOUND_SHAPE:'+key);
      if(typeof bounds.min!=='string'||typeof bounds.max!=='string')throw Error('INVALID_MIGRATED_BOUND:'+key);
      const mapping=group==='metricsRange'&&Object.hasOwn(ranges,key)?ranges[key]:null;
      for(const edge of ['min','max'])if(bounds[edge]!==''){
        if(!mapping)throw Error('UNSUPPORTED_MIGRATED_RANGE:'+key);
        if(!/^\d+(?:\.\d+)?$/.test(bounds[edge]))throw Error('INVALID_MIGRATED_BOUND:'+key);
        const value=Number(bounds[edge]);
        if(!Number.isFinite(value)||value>Number.MAX_SAFE_INTEGER||(mapping[1]===.01&&value>100))throw Error('INVALID_MIGRATED_BOUND:'+key);
        completed[edge+'_'+mapping[0]]=value*mapping[1];
      }
      if(bounds.min!==''&&bounds.max!==''&&Number(bounds.min)>Number(bounds.max))throw Error('INVERTED_MIGRATED_RANGE:'+key);
    }
  }
  return{chain:config.network,completed:{...completed,launchpad_platform:[...platforms],quote_address_type:[...quotes],limit}};
}
function loadOwnerMigratedFilters(root=path.join(__dirname,'filters')){
  const params=[],manifest=[];
  for(const chain of ['sol','robinhood']){
    const file=path.join(root,'migrated-'+chain+'.json'),stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw Error('INVALID_MIGRATED_FILTER_FILE');
    const bytes=fs.readFileSync(file),config=JSON.parse(bytes.toString('utf8'));
    if(config.network!==chain)throw Error('MIGRATED_FILTER_CHAIN_MISMATCH');
    params.push(compileMigratedImport(config));manifest.push({file:path.basename(file),sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
  }
  return{request:{params},manifest,definition_sources:clone(definitions.sources)};
}
module.exports={compileMigratedImport,loadOwnerMigratedFilters};
