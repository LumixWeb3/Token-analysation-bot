'use strict';

// Explicit live diagnostic only. No automatic import-time launch or trading.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PRIVATE_PATH = /account|wallet|following|follow_|remark|intercom|invitation|my_rank|user|order|trade_config|price_remind|business_group/i;
const PUBLIC_DATA_PATH = /(?:trending|new_pairs|trenches|token_list|major_coin_prices|rank\/[^/]+\/swaps)/i;
const PRIVATE_KEY = /^(?:access_token|refresh_token|auth_token|authorization|auth|api_key|token|cookie|cookies|set-cookie|password|email|user_id|uid|device_id|fp_did|tab_id|account|accounts|wallets|session|session_id|session_token|csrf|csrf_token)$/i;
const PUBLIC_QUERY = new Set(['chain', 'chains', 'interval', 'window', 'limit', 'orderby', 'order', 'direction']);

function route(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.username || u.password || !['https:', 'wss:'].includes(u.protocol) || !(u.hostname === 'gmgn.ai' || u.hostname.endsWith('.gmgn.ai'))) return null;
    if (PRIVATE_PATH.test(u.pathname)) return null;
    return { host: u.hostname, path: u.pathname,
      query: [...u.searchParams].filter(([k]) => PUBLIC_QUERY.has(k)) };
  } catch { return null; }
}
function containsPrivateKeys(value, depth = 0) {
  if (depth > 40) return true;
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => PRIVATE_KEY.test(key) || containsPrivateKeys(child, depth + 1));
}
function shape(value, depth = 0) {
  if (depth > 4) return { type: typeof value };
  if (Array.isArray(value)) return { type: 'array', length: value.length, sample: value.length ? shape(value[0], depth + 1) : null };
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 30).map(([k, v]) => [k, shape(v, depth + 1)]));
  return { type: value === null ? 'null' : typeof value };
}

function describeRequest(rawUrl, body = null) {
  const r = route(rawUrl);
  if (!r) return null;
  const u = new URL(rawUrl);
  return { query_keys: [...new Set([...u.searchParams.keys()])].filter(k => /^[a-zA-Z0-9_\[\].-]{1,80}$/.test(k)),
    public_parameters: Object.fromEntries([...u.searchParams].filter(([k]) => PUBLIC_QUERY.has(k))),
    body_shape: body === null ? null : shape(body), market: publicMarketRequest(body) };
}

function publicMarketRequest(body) {
  if (!body || !Array.isArray(body.params) || containsPrivateKeys(body)) return null;
  const filter = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const fields = {}, unknown = [];
    for (const [k, v] of Object.entries(value)) {
      if ((/^(min|max)_[a-z_]+$/.test(k) || k === 'limit') && typeof v === 'number' && Number.isFinite(v)) fields[k] = v;
      else if (['min_created','max_created'].includes(k) && typeof v === 'string' && /^\d+(?:\.\d+)?[mhd]$/.test(v)) fields[k] = v;
      else if (['filters', 'launchpad_platform', 'quote_address_type'].includes(k) && Array.isArray(v) &&
        v.every(x => (typeof x === 'string' && /^[a-zA-Z0-9_.:-]{0,100}$/.test(x)) || (typeof x === 'number' && Number.isFinite(x)))) fields[k] = v;
      else unknown.push(k);
    }
    return { fields, unknown };
  };
  return body.params.map(p => ({ chain: ['sol', 'robinhood'].includes(p.chain) ? p.chain : 'UNSUPPORTED',
    interval: ['1m','5m','1h','6h','24h'].includes(p.interval) ? p.interval : null,
    filter: filter(p.filter), completed: filter(p.completed) }));
}

async function probe({ seconds = 15, headless = true, captureStreams = false, captureSource = false, customTrending = false, setupWindowSeconds = 0,
  outputDir = path.resolve(__dirname, `../../tmp/v2-network-${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID()}`) } = {}) {
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 30) throw new Error('PROBE_DURATION_OUT_OF_BOUNDS');
  if (typeof headless !== 'boolean') throw new Error('INVALID_BROWSER_MODE');
  if (!Number.isInteger(setupWindowSeconds) || setupWindowSeconds < 0 || setupWindowSeconds > 300 || (headless && setupWindowSeconds)) throw new Error('SETUP_WINDOW_OUT_OF_BOUNDS');
  // Existing normal browser runtime and lock only; no scanner/tracker imports.
  const { chromium } = require('playwright');
  const { launchManagedPersistentContext } = require('../../gmgn-browser-profile');
  let managed;
  let cdp;
  const responses = [];
  const sockets = [];
  const pending = new Set();
  const failures = [];
  const pageLoads = [];
  const domChecks = [];
  const navigationStatus = new WeakMap();
  const workerTargets = [];
  const workerHttp = [];
  const streamSamples = [];
  const sourceAssets = [];
  const requestTemplates = new Map();
  fs.mkdirSync(outputDir, { recursive: true });
  const storeBody = (record, bytes) => {
    if (bytes.length > 2 * 1024 * 1024) { record.body_state = 'OVERSIZE'; return; }
    let data;
    try { data = JSON.parse(bytes.toString('utf8')); } catch { record.body_state = 'MALFORMED_JSON'; return; }
    if (containsPrivateKeys(data)) { record.body_state = 'PRIVATE_KEYS_REJECTED'; return; }
    record.file = `public-response-${responses.indexOf(record) + 1}.json`;
    fs.writeFileSync(path.join(outputDir, record.file), bytes, { flag: 'wx' });
    record.body_state = 'PUBLIC_CANDIDATE_CAPTURED'; record.shape = shape(data);
    record.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  };
  try {
    managed = await launchManagedPersistentContext({ chromium, role: 'v2-network-probe', chain: 'solana', profileName: 'gmgn-login', headless });
    const context = managed.context;
    const receiveFrame = (record, payload, binary = false) => {
      record.received_frames++;
      if (binary || typeof payload !== 'string') { record.binary_frames++; return; }
      if (payload.length > 1024 * 1024) return;
      try {
        const data = JSON.parse(payload);
        const candidate = data?.channel ?? data?.type;
        const channel = typeof candidate === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(candidate) ? candidate : 'UNCLASSIFIED';
        if (PRIVATE_PATH.test(channel) || /twitter|tg_monitor/.test(channel)) return;
        let entry = record.channels.find(c => c.channel === channel);
        if (!entry && record.channels.length < 32) { entry = { channel, count: 0, shape: null }; record.channels.push(entry); }
        if (entry) { entry.count++; if (!entry.shape && !containsPrivateKeys(data)) entry.shape = shape(data); }
        if (captureStreams && ['trenches_delta', 'trending_multichain_update'].includes(channel) &&
            streamSamples.length < 64 && streamSamples.filter(s => s.channel === channel && s.filter_id === data?.data?.fid).length < 6 && !containsPrivateKeys(data)) {
          const bytes = Buffer.from(payload);
          const file = `public-stream-${streamSamples.length + 1}.json`;
          fs.writeFileSync(path.join(outputDir, file), bytes, { flag: 'wx' });
          streamSamples.push({ channel, filter_id: data?.data?.fid ?? null, producer: record.producer, route: record.route,
            file, observed_at: new Date().toISOString(), sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
        }
      } catch { /* Unknown protocols stay unknown. */ }
    };
    const addSocket = (url, producer) => {
      const r = route(url);
      if (!r || sockets.length >= 12) return null;
      const record = { route: r, producer, received_frames: 0, binary_frames: 0, channels: [], status: 'UNVERIFIED_PROTOCOL' };
      sockets.push(record); return record;
    };
    const attachPage = page => {
      page.on('response', response => {
        try {
          if (response.request().isNavigationRequest() && response.frame() === page.mainFrame() &&
              new URL(response.url()).origin === 'https://gmgn.ai') navigationStatus.set(page, response.status());
        } catch { /* Worker responses have no main-page frame. */ }
      });
      page.on('websocket', socket => {
        const record = addSocket(socket.url(), 'page');
        if (record) socket.on('framereceived', event => receiveFrame(record, event.payload));
      });
    };
    for (const page of context.pages()) attachPage(page);
    context.on('page', attachPage);
    // GMGN moves some feed transports into workers. Observe their ordinary
    // sockets too; do not evaluate worker code, alter messages or access cookies.
    cdp = await context.newCDPSession(managed.page);
    const workerSockets = new Map();
    const workerResponses = new Map();
    const workerRequests = new Map();
    const commands = new Map();
    let commandId = 1;
    cdp.on('Target.attachedToTarget', event => {
      const info = event.targetInfo;
      if (!['worker', 'shared_worker'].includes(info.type) ||
          !(info.url.startsWith('https://gmgn.ai/') || info.url.startsWith('blob:https://gmgn.ai/'))) return;
      workerTargets.push({ type: info.type, script: info.url.startsWith('blob:') ? 'gmgn-blob-worker' : new URL(info.url).pathname });
      cdp.send('Target.sendMessageToTarget', { sessionId: event.sessionId,
        message: JSON.stringify({ id: commandId++, method: 'Network.enable', params: {} })
      }).catch(error => failures.push({ stage: 'WORKER_NETWORK_ENABLE', error: error.name }));
      if (captureSource) cdp.send('Target.sendMessageToTarget', { sessionId: event.sessionId,
        message: JSON.stringify({ id: commandId++, method: 'Debugger.enable', params: {} })
      }).catch(() => {});
    });
    cdp.on('Target.receivedMessageFromTarget', event => {
      try {
        const message = JSON.parse(event.message);
        if (commands.has(message.id)) {
          const resolve = commands.get(message.id); commands.delete(message.id); resolve(message); return;
        }
        if (message.error && failures.length < 12) failures.push({ stage: 'WORKER_PROTOCOL', code: message.error.code });
        const p = message.params;
        const key = `${event.sessionId}:${p?.requestId}`;
        if (captureSource && message.method === 'Debugger.scriptParsed' && /^https:\/\/gmgn\.ai\/_next\/static\/workers\/gmgn\.[a-f0-9]+\.js$/.test(p.url) && sourceAssets.length < 4) {
          const id = commandId++;
          const entry = { path: new URL(p.url).pathname, file: `public-source-${sourceAssets.length + 1}.js`, state: 'PENDING' };
          sourceAssets.push(entry);
          const work = new Promise(resolve => {
            const timer = setTimeout(() => { commands.delete(id); resolve(null); }, 5000);
            commands.set(id, reply => { clearTimeout(timer); resolve(reply.result?.scriptSource ?? null); });
            cdp.send('Target.sendMessageToTarget', { sessionId: event.sessionId, message: JSON.stringify({ id, method:'Debugger.getScriptSource', params:{scriptId:p.scriptId} }) }).catch(() => { clearTimeout(timer); commands.delete(id); resolve(null); });
          }).then(source => {
            if (typeof source !== 'string' || !source.length || Buffer.byteLength(source)>8*1024*1024) { entry.state='UNAVAILABLE'; return; }
            fs.writeFileSync(path.join(outputDir, entry.file), source, {flag:'wx'}); entry.state='CAPTURED';
            entry.sha256=crypto.createHash('sha256').update(source).digest('hex');
          });
          pending.add(work); work.finally(()=>pending.delete(work));
        }
        if (message.method === 'Network.requestWillBeSent' && route(p.request.url)?.path === '/trs/api/v1/trenches_rank') {
          let body = null;
          try { body = p.request.postData ? JSON.parse(p.request.postData) : null; } catch {}
          workerRequests.set(key, describeRequest(p.request.url, body));
        } else if (message.method === 'Network.responseReceived' && ['XHR', 'Fetch'].includes(p.type) && workerHttp.length < 40) {
          const r = route(p.response.url);
          if (r) workerHttp.push({ route: r, status: p.response.status, mime_type: p.response.mimeType });
          if (r && r.path === '/trs/api/v1/trenches_rank' && responses.length < 16) {
            const record = { route: r, transport: 'shared_worker', status: p.response.status,
              observed_at: new Date().toISOString(), request: workerRequests.get(key) ?? null,
              schema_status: 'UNVERIFIED', body_state: 'NOT_READ' };
            workerRequests.delete(key);
            responses.push(record); workerResponses.set(key, record);
          }
        } else if (message.method === 'Network.loadingFinished' && workerResponses.has(key) && pending.size < 4) {
          const record = workerResponses.get(key); workerResponses.delete(key);
          if (record.status !== 200) return;
          const id = commandId++;
          const work = new Promise(resolve => {
            const timeout = setTimeout(() => { commands.delete(id); resolve({ error: { code: 'BODY_TIMEOUT' } }); }, 5000);
            commands.set(id, reply => { clearTimeout(timeout); resolve(reply); });
            cdp.send('Target.sendMessageToTarget', { sessionId: event.sessionId,
              message: JSON.stringify({ id, method: 'Network.getResponseBody', params: { requestId: p.requestId } })
            }).catch(() => { clearTimeout(timeout); commands.delete(id); resolve({ error: { code: 'BODY_COMMAND_FAILED' } }); });
          }).then(reply => {
            if (reply.error) { record.body_state = 'UNAVAILABLE'; return; }
            storeBody(record, Buffer.from(reply.result.body, reply.result.base64Encoded ? 'base64' : 'utf8'));
          }).catch(() => { record.body_state = 'CAPTURE_FAILED'; });
          pending.add(work); work.finally(() => pending.delete(work));
        } else if (message.method === 'Network.webSocketCreated') {
          const record = addSocket(p.url, 'worker'); if (record) workerSockets.set(key, record);
        } else if (message.method === 'Network.webSocketFrameReceived' && workerSockets.has(key)) {
          receiveFrame(workerSockets.get(key), p.response.payloadData, p.response.opcode !== 1);
        }
      } catch { failures.push({ stage: 'WORKER_MESSAGE_FORMAT', error: 'UNVERIFIED' }); }
    });
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: false });
    context.on('response', response => {
      const r = route(response.url());
      if (captureSource && r && /^\/_next\/static\/workers\/gmgn\.[a-f0-9]+\.js$/.test(r.path) && sourceAssets.length < 2 && response.status() === 200) {
        const entry = { path: r.path, file: `public-worker-${sourceAssets.length + 1}.js` };
        sourceAssets.push(entry);
        const work = response.body().then(bytes => {
          if (bytes.length > 8 * 1024 * 1024 || !bytes.length) { entry.state = bytes.length ? 'OVERSIZE' : 'EMPTY'; return; }
          fs.writeFileSync(path.join(outputDir, entry.file), bytes, { flag: 'wx' });
          entry.sha256 = crypto.createHash('sha256').update(bytes).digest('hex'); entry.state = 'CAPTURED';
        }).catch(() => { entry.state = 'UNAVAILABLE'; });
        pending.add(work); work.finally(() => pending.delete(work));
      }
      if (!['xhr', 'fetch'].includes(response.request().resourceType())) return;
      if (!r || !PUBLIC_DATA_PATH.test(r.path) || responses.length >= 16 || pending.size >= 4) return;
      const work = (async () => {
        let body = null;
        try { body = response.request().postDataJSON(); } catch {}
        if (r.path === '/rrs/api/v1/trending_multichain' && body?.params) requestTemplates.set('trending', {url:response.url(), body});
        const record = { route: r, status: response.status(), request: describeRequest(response.url(), body),
          observed_at: new Date().toISOString(), schema_status: 'UNVERIFIED', body_state: 'NOT_READ' };
        responses.push(record);
        if (record.status !== 200) return;
        const type = await response.headerValue('content-type');
        if (!type?.includes('json')) { record.body_state = 'NOT_JSON'; return; }
        storeBody(record, await response.body());
      })().catch(error => failures.push({ stage: 'RESPONSE_CAPTURE', error: error.name }));
      pending.add(work); work.finally(() => pending.delete(work));
    });
    // Load the normal pages once; receive their ordinary traffic without
    // scrolling, modifying filters, direct endpoint replay or challenge bypass.
    const page = managed.page;
    const attachedShared = new Set();
    for (const url of ['https://gmgn.ai', 'https://gmgn.ai/trend?chain=sol']) {
      try {
        const navigation = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        const status = navigation?.status() ?? null;
        let title = await page.title();
        let challenge = /just a moment|attention required|cloudflare|verify you are human/i.test(title);
        // A headed run needs separate owner permission. Verification is always
        // manual: no challenge clicks, retries, credential exports or bypass.
        if (challenge && !headless) {
          console.log(JSON.stringify({ stage: 'OWNER_VERIFICATION_REQUIRED', path: new URL(url).pathname, timeout_seconds: 60 }));
          const deadline = Date.now() + 60000;
          while (challenge && Date.now() < deadline) {
            await page.waitForTimeout(1000);
            title = await page.title();
            challenge = /just a moment|attention required|cloudflare|verify you are human/i.test(title);
          }
        }
        const finalStatus = navigationStatus.get(page) ?? status;
        pageLoads.push({ path: new URL(url).pathname, initial_status: status, status: finalStatus, challenge });
        if (finalStatus !== 200 || challenge) {
          failures.push({ stage: 'NORMAL_PAGE_QUALIFICATION', status: finalStatus, reason: challenge ? 'BROWSER_CHALLENGE' : 'NON_200_PAGE' });
          break;
        }
        // Shared workers are separate targets, not necessarily children of the
        // page's auto-attach tree. Only this dedicated browser's GMGN workers.
        const targets = await cdp.send('Target.getTargets');
        for (const info of targets.targetInfos.filter(t => t.type === 'shared_worker' &&
          (t.url.startsWith('https://gmgn.ai/') || t.url.startsWith('blob:https://gmgn.ai/'))).slice(0, 4)) {
          if (attachedShared.has(info.targetId)) continue;
          await cdp.send('Target.attachToTarget', { targetId: info.targetId, flatten: false });
          attachedShared.add(info.targetId);
        }
        if (new URL(url).pathname === '/trend') {
          const { readDom } = require('./gmgn');
          const deadline = Date.now() + 60000;
          let window = (await page.evaluate(readDom, { feed: 'trending' })).scope.window;
          if (window !== '24h' && !headless) console.log(JSON.stringify({ stage: 'OWNER_SELECT_24H', timeout_seconds: 60 }));
          while (window !== '24h' && !headless && Date.now() < deadline) {
            await page.waitForTimeout(1000);
            window = (await page.evaluate(readDom, { feed: 'trending' })).scope.window;
          }
          if (window !== '24h') { failures.push({ stage: 'TRENDING_WINDOW', expected: '24h', observed: window }); break; }
          if (customTrending) {
            const template = requestTemplates.get('trending');
            if (!template) throw new Error('NORMAL_REQUEST_TEMPLATE_MISSING');
            const body = require('./filter-config').loadOwnerFilters().request;
            const status = await page.evaluate(async ({url,body})=>{
              const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify(body)});
              await r.arrayBuffer(); return r.status;
            },{url:template.url,body});
            if(status!==200) failures.push({stage:'EXPLICIT_SCOPE_REQUEST',status});
          }
        }
        await page.waitForTimeout((seconds + (new URL(url).pathname === '/trend' ? setupWindowSeconds : 0)) * 1000);
        // Read current labels/identities for later response parity; no scrolling
        // or clicks. This is the same already-qualified DOM reader, not a second
        // guessed normalizer or a claim that the viewport is the full feed.
        const { readDom, normalizeFrame } = require('./gmgn');
        const started = new Date().toISOString();
        const raw = await page.evaluate(readDom, { feed: new URL(url).pathname === '/' ? 'migrated' : 'trending' });
        const frame = normalizeFrame(raw, { captureStartedAt: started, observedAt: new Date().toISOString() });
        const file = `dom-${frame.feed}.json`;
        fs.writeFileSync(path.join(outputDir, file), JSON.stringify(frame), { flag: 'wx' });
        domChecks.push({ feed: frame.feed, file, rows: frame.rows.length, scope: frame.scope, errors: frame.errors });
      } catch (error) { failures.push({ stage: 'NORMAL_PAGE_LOAD', error: error.name }); break; }
    }
    await Promise.allSettled([...pending]);
  } finally {
    if (cdp) await cdp.detach().catch(() => {});
    if (managed) await managed.close();
  }
  const result = { version: 1, recorded_at: new Date().toISOString(),
    mode: 'BOUNDED_READ_ONLY_NETWORK_PROBE', strategy_ready: false,
    note: 'Observed traffic only. Candidate bodies still require exact schema, UI identity/value/filter/freshness and complete-cohort verification. Worker/socket coverage is not assumed.',
    output_dir: outputDir, page_loads: pageLoads, dom_checks: domChecks, worker_targets: workerTargets,
    worker_http: workerHttp, responses, sockets, stream_samples: streamSamples, source_assets: sourceAssets, failures };
  fs.writeFileSync(path.join(outputDir, 'summary.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
  return result;
}

if (require.main === module) {
  if (!process.argv.includes('--live-read-only-network-probe')) {
    console.error('Inert by default. Explicit --live-read-only-network-probe required.');
    process.exitCode = 2;
  } else {
    probe({ headless: !process.argv.includes('--headed'), captureStreams: process.argv.includes('--capture-public-streams') }).then(result => console.log(JSON.stringify({
      mode: result.mode, output_dir: result.output_dir, page_loads: result.page_loads,
      public_response_bodies: result.responses.filter(r => r.body_state === 'PUBLIC_CANDIDATE_CAPTURED').length,
      sockets: result.sockets.length, worker_targets: result.worker_targets,
      worker_http: result.worker_http, failures: result.failures, strategy_ready: false
    }))).catch(error => {
      console.error(JSON.stringify({ stage: 'NETWORK_PROBE', error: error.name, message: error.message.slice(0, 180) }));
      process.exitCode = 1;
    });
  }
}
module.exports = { route, containsPrivateKeys, shape, describeRequest, publicMarketRequest, probe };
