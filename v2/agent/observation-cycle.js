'use strict';
const {FeedBook}=require('../market/network-feed');

// A declared cohort stays fixed during a bounded research cycle. New arrivals
// remain in the live book for the next cycle. Source receipt times never change.
function observationCycle(liveBook,{now=()=>Date.now(),maxAgeMs=600000}={}){
  if(!(liveBook instanceof FeedBook))throw Error('QUALIFIED_SOURCE_BOOK_REQUIRED');
  const observed=liveBook.view(),started=now();
  if(!observed.research_ready)throw Error('MARKET_NOT_READY');
  class ObservationCycle extends FeedBook{
    view(){
      const live=liveBook.view(),age=now()-started;
      const reasons=[...live.reasons];
      if(observed.groups.some(group=>!live.groups.some(current=>current.feed===group.feed&&current.chain===group.chain&&current.request_sha256===group.request_sha256)))
        reasons.push('OBSERVATION_SCOPE_CHANGED');
      if(age<0||age>maxAgeMs)reasons.push('OBSERVATION_CYCLE_EXPIRED');
      return{...JSON.parse(JSON.stringify(observed)),recorded_at:new Date(now()).toISOString(),
        observation_cycle_at:observed.recorded_at,observation_cycle_age_ms:age,
        research_ready:reasons.length===0,strategy_ready:reasons.length===0,reasons,
        coverage_note:observed.coverage_note+' Fixed observation cycle. Later arrivals are deferred to the next cycle.',
        groups:observed.groups.map(group=>({...JSON.parse(JSON.stringify(group)),
          snapshot_age_ms:now()-Date.parse(group.snapshot_at),transport_age_ms:now()-Date.parse(group.last_message_at)}))};
    }
  }
  return new ObservationCycle();
}
module.exports={observationCycle};
