'use strict';

const os = require('node:os');
const GIB = 1024 ** 3;

function createMemoryMonitor({ freeMemory = os.freemem, totalMemory = os.totalmem,
  usage = process.memoryUsage, now = () => Date.now() } = {}) {
  let lowSince = null;
  let latest = null;

  function sample() {
    const free = freeMemory();
    const total = totalMemory();
    const at = now();
    if (!Number.isFinite(free) || free < 0 || !Number.isFinite(total) || total <= 0 || free > total)
      throw Error('BOT_RAM_MEASUREMENT_UNAVAILABLE');
    if (free < 1.25 * GIB) lowSince ??= at;
    else lowSince = null;
    const node = usage();
    latest = {
      measured_at: new Date(at).toISOString(), available_bytes: free, total_bytes: total,
      available_gb: Math.round(free / GIB * 100) / 100,
      node_rss_bytes: node.rss, node_heap_used_bytes: node.heapUsed,
      low_memory_since: lowSince === null ? null : new Date(lowSince).toISOString(),
      stop_required: lowSince !== null && at - lowSince >= 30000,
      critical_floor_gb: 1.25, critical_grace_seconds: 30,
      scope: 'System available memory and runner process. Scheduled checks also inspect owned descendants.'
    };
    return latest;
  }
  return { sample, latest: () => latest };
}

module.exports = { createMemoryMonitor };
