'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {renderReport}=require('./verify-holder-data');
test('holder report preserves every public field, distinguishes null/missing/zero and escapes source HTML/formulas',()=>{
  const raw=[{address:'PUBLIC_FIXTURE_WALLET',name:'<script>unsafe()</script>',tags:['kol'],twitter_username:'=unsafe',amount_percentage:0,token_transfer:{timestamp:0,type:'transfer'}},
    {address:'SECOND_FIXTURE_WALLET',name:null,tags:[]}];
  const rows=raw.map((r,i)=>({page_rank:i+1,provider_kol_label:{state:i===0?'GMGN_KOL_TAG_OBSERVED':'UNKNOWN'},remaining_share:{value:i===0?0:null},remaining_tokens:{raw:null},remaining_usd:{raw:0}}));
  const out=renderReport({coin:{url:'https://gmgn.ai/sol/token/PUBLIC_FIXTURE',coin_id:'solana:PUBLIC_FIXTURE'},route:'https://gmgn.ai/public_fixture',observation:{received_at:'2026-11-08T12:00:00Z',raw_public:{list:raw}},normalized:{depth:{top20:{state:'UNVERIFIED_TOP20',returned_count:2,rows}}},provider_field_inventory:[]});
  assert(out.html.includes('&lt;script&gt;'));assert(!out.html.includes('<script>unsafe'));
  assert(out.html.includes('MISSING'));assert(out.html.includes('timestamp'));assert(out.html.includes('GMGN KOL tags anywhere'));
  assert(out.html.includes('Wallet / GMGN name'));assert(out.html.includes('Unlabelled wallet'));assert(out.html.includes('<strong>&lt;script&gt;'));
  assert(out.csv.includes('token_transfer'));assert(out.csv.includes("'=unsafe"));assert(out.csv.includes('"0"'));assert(out.csv.includes('"null"'));assert.equal(out.field_count,6);
});
