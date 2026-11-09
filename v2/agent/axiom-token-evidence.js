'use strict';

// Read-only public projections from observed Axiom token responses. This module
// neither navigates nor requests data and is separate from trade decisions.
const crypto = require('node:crypto');
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PATHS = new Set(['/token-and-best-pair-info', '/token-info-v2']);
const TOKEN_FIELDS = {
  tokenAddress: 'string', tokenName: 'string', tokenTicker: 'string',
  tokenDecimals: 'number', tokenDeployerAddress: 'string', tokenCreatedAt: 'string',
  tokenUpdatedAt: 'string', bestPairAddress: 'string', supplyRaw: 'string', supply: 'number'
};
const HOLDER_FIELDS = {
  top10HoldersPercent: 'number', devHoldsPercent: 'number', snipersHoldPercent: 'number',
  insidersHoldPercent: 'number', bundlersHoldPercent: 'number', freshWalletsHoldPercent: 'number',
  proTradersHoldPercent: 'number', numHolders: 'number', numBotUsers: 'number',
  supplyRaw: 'string', decimals: 'number', deployer: 'string', createdSlot: 'number',
  lastUpdatedSlot: 'number', headSlot: 'number'
};

function publicTokenRoute(rawUrl, mint, method = 'GET') {
  if (!ADDRESS.test(mint || '')) throw Error('AXIOM_MINT_INVALID');
  let url;
  try { url = new URL(rawUrl); } catch { throw Error('AXIOM_ROUTE_INVALID'); }
  if (method !== 'GET' || url.protocol !== 'https:' || url.username || url.password || url.hash ||
    !/^sol-api\d*\.axiom\.trade$/.test(url.hostname) || !PATHS.has(url.pathname) ||
    [...url.searchParams.keys()].some(key => key !== 'tokenAddress') ||
    url.searchParams.getAll('tokenAddress').length !== 1 || url.searchParams.get('tokenAddress') !== mint) {
    throw Error('AXIOM_EXACT_PUBLIC_ROUTE_REQUIRED');
  }
  return { host: url.hostname, path: url.pathname, token_address: mint, method };
}

function scalarFields(source, definition) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw Error('AXIOM_PUBLIC_OBJECT_REQUIRED');
  return Object.fromEntries(Object.entries(definition).map(([field, type]) => {
    const value = source[field];
    if (value === undefined || value === null) return [field, null];
    if (typeof value !== type || type === 'number' && (!Number.isFinite(value) || value < 0) ||
      type === 'string' && value.length > 2048) throw Error('AXIOM_PUBLIC_FIELD_INVALID');
    return [field, value];
  }));
}

function projectTokenResponse({ url, mint, method = 'GET', status, body, requestStartedAt, receivedAt }) {
  const route = publicTokenRoute(url, mint, method);
  if (status !== 200) throw Error('AXIOM_HTTP_UNAVAILABLE');
  if (!Number.isFinite(Date.parse(requestStartedAt)) || !Number.isFinite(Date.parse(receivedAt)) ||
    Date.parse(receivedAt) < Date.parse(requestStartedAt)) throw Error('AXIOM_CAPTURE_TIME_INVALID');
  let rawPublic, identityBasis;
  if (route.path === '/token-and-best-pair-info') {
    if (body?.token?.tokenAddress !== mint) throw Error('AXIOM_RESPONSE_IDENTITY_MISMATCH');
    if (body.token.bestPairAddress && body.bestPairInfo?.bestPairAddress &&
      body.token.bestPairAddress !== body.bestPairInfo.bestPairAddress) throw Error('AXIOM_PAIR_IDENTITY_MISMATCH');
    rawPublic = { token: scalarFields(body.token, TOKEN_FIELDS) };
    identityBasis = 'EXACT_REQUEST_AND_RESPONSE_TOKEN';
  } else {
    rawPublic = { holderStats: scalarFields(body?.holderStats, HOLDER_FIELDS) };
    for (const field of ['numHolders', 'numBotUsers', 'decimals', 'createdSlot', 'lastUpdatedSlot', 'headSlot']) {
      const value = rawPublic.holderStats[field];
      if (value !== null && !Number.isSafeInteger(value)) throw Error('AXIOM_PUBLIC_COUNT_INVALID');
    }
    identityBasis = 'EXACT_REQUEST_ONLY_RESPONSE_HAS_NO_MINT';
  }
  const record = {
    schema: 'alphahands.axiom-token-observation.v1', coin_id: 'solana:' + mint,
    route, status, request_started_at: requestStartedAt, received_at: receivedAt,
    identity_basis: identityBasis, raw_public: rawPublic,
    coverage: { scope: 'TOKEN_METADATA_OR_HOLDER_AGGREGATES', ranked_holder_list: 'UNVERIFIED',
      top20: 'UNVERIFIED', holder_labels: 'UNVERIFIED', percentage_scale: 'UNVERIFIED',
      provider_freshness: 'UNVERIFIED', execution_qualified: false },
    note: 'Null means missing. Zero remains observed zero. Receipt time does not prove provider update time. Aggregate holder statistics do not identify the top 20 wallets.'
  };
  return { ...record, sha256: crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex') };
}

function observeAxiomTokenResponses(page, mint, { now = () => Date.now() } = {}) {
  if (!ADDRESS.test(mint || '')) throw Error('AXIOM_MINT_INVALID');
  const observations = [], failures = [], pending = new Set(), starts = new WeakMap();
  let stopped = false, admitted = 0;
  const onRequest = request => { starts.set(request, new Date(now()).toISOString()); };
  const onResponse = response => {
    if (stopped || admitted >= 4) return;
    const request = response.request();
    let route;
    try { route = publicTokenRoute(response.url(), mint, request.method()); } catch { return; }
    admitted++;
    const work = (async () => {
      try {
        if (response.status() !== 200) throw Error('AXIOM_HTTP_UNAVAILABLE');
        const requestStartedAt = starts.get(request);
        if (!requestStartedAt) throw Error('AXIOM_REQUEST_START_UNOBSERVED');
        const bytes = await response.body();
        if (!bytes.length || bytes.length > 2 * 1024 * 1024) throw Error('AXIOM_BODY_SIZE_INVALID');
        const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        observations.push(projectTokenResponse({ url: response.url(), mint, method: request.method(),
          status: response.status(), body, requestStartedAt, receivedAt: new Date(now()).toISOString() }));
      } catch (error) {
        failures.push({ route, reason: /^AXIOM_[A-Z_]+$/.test(error.message) ? error.message : 'AXIOM_PUBLIC_RESPONSE_UNAVAILABLE' });
      }
    })();
    pending.add(work);
    work.finally(() => pending.delete(work));
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  return {
    async finish() {
      stopped = true;
      page.off('request', onRequest);
      page.off('response', onResponse);
      await Promise.allSettled([...pending]);
      return { observations: structuredClone(observations), failures: structuredClone(failures) };
    }
  };
}

module.exports = { publicTokenRoute, projectTokenResponse, observeAxiomTokenResponses };
