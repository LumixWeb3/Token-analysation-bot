'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryMonitor } = require('./memory-monitor');
const {quotaFromResult}=require('./codex-runner');

test('critical memory must persist for thirty seconds and recovery clears the timer', () => {
  let clock = Date.now(), free = 3 * 1024 ** 3;
  const monitor = createMemoryMonitor({ now: () => clock, freeMemory: () => free,
    totalMemory: () => 8 * 1024 ** 3, usage: () => ({ rss: 100, heapUsed: 50 }) });
  assert.equal(monitor.sample().stop_required, false);
  free = 1024 ** 3;
  assert.equal(monitor.sample().stop_required, false);
  clock += 29999;
  assert.equal(monitor.sample().stop_required, false);
  clock++;
  assert.equal(monitor.sample().stop_required, true);
  free = 2 * 1024 ** 3;
  assert.equal(monitor.sample().low_memory_since, null);
  free = 1024 ** 3;
  assert.equal(monitor.sample().stop_required, false);
});

test('unavailable memory telemetry fails visibly instead of inventing free capacity', () => {
  const monitor = createMemoryMonitor({ freeMemory: () => NaN });
  assert.throws(() => monitor.sample(), /BOT_RAM_MEASUREMENT_UNAVAILABLE/);
});

test('explicit usage waiver is bound to one reset window and preserves hard availability gates',()=>{
  const resetsAt=Math.floor(Date.now()/1000)+3600;
  const result={ordinaryUsageAllowed:true,rateLimits:{primary:{usedPercent:80,windowDurationMins:300,resetsAt}}};
  const authorization={schema:'alphahands.usage-authorization.v1',owner_approved:true,window_resets_at:resetsAt,start_before_percent:95};
  assert.equal(quotaFromResult(result).inference_allowed,false);
  assert.equal(quotaFromResult(result,{authorization}).inference_allowed,true);
  assert.equal(quotaFromResult(result,{authorization:{...authorization,window_resets_at:resetsAt+1}}).inference_allowed,false);
  assert.equal(quotaFromResult({...result,ordinaryUsageAllowed:false},{authorization}).inference_allowed,false);
  result.rateLimits.primary.usedPercent=95;
  assert.equal(quotaFromResult(result,{authorization}).inference_allowed,false);
});
