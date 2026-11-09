'use strict';

// No browser launch, authentication, requests, V1 imports or trading side effects.
// This function is serialized into a read-only DOM scope by the supplied browser.
function readDom({ feed }) {
  const text = e => e ? e.textContent.replace(/\s+/g, ' ').trim() : null;
  const attr = (e, key) => e?.getAttribute(key) ?? null;
  const leaf = e => e ? Array.from(e.querySelectorAll('*')).filter(n =>
    n.children.length === 0 && text(n)).map(text) : [];
  const visible = e => !!e && e.getBoundingClientRect().height > 0;
  const selected = Array.from(document.querySelectorAll(
    '[data-testid^="chain-multi-select-bar-option-"],input[data-testid^="chain-multi-select-option-"]'
  )).filter(n => n.getAttribute('aria-pressed') === 'true' || n.checked === true)
    .map(n => attr(n, 'data-testid').replace(/^chain-multi-select-(?:bar-option|option)-/, ''));
  const scope = {
    selected_chains: [...new Set(selected)].sort(),
    selection_observed: selected.length > 0,
    // Saved login, a funnel icon or a selected preset is not a canonical-filter audit.
    filter_status: 'UNVERIFIED', filter_hash: null,
    upstream_updated_at: null, network_status: 'UNVERIFIED'
  };
  const base = { feed, page_url: document.URL, scope, errors: [], rows: [] };
  if (!['migrated', 'trending'].includes(feed)) throw new Error('Unsupported feed');
  let root;
  let scroller;
  if (feed === 'migrated') {
    const roots = Array.from(document.querySelectorAll('[data-testid="trenchesCompleted"]')).filter(visible);
    if (roots.length !== 1) return { ...base, errors: ['MIGRATED_LANE_NOT_UNIQUE'] };
    root = roots[0];
    const scrolls = Array.from(root.querySelectorAll('.gmgn-scrollbar')).filter(visible);
    if (scrolls.length !== 1) return { ...base, errors: ['MIGRATED_SCROLLER_NOT_UNIQUE'] };
    scroller = scrolls[0];
    base.rows = Array.from(root.querySelectorAll('[data-testid="trench-token-card"]')).filter(visible).map(card => {
      const wrapper = card.parentElement;
      const height = Number.parseFloat(wrapper.style.height);
      const transform = /^translateY\((\d+(?:\.\d+)?)px\)$/.exec(wrapper.style.transform);
      const offset = transform ? Number(transform[1]) : null;
      const index = offset !== null && height > 0 && Number.isInteger(offset / height) ? offset / height : null;
      const symbol = card.querySelector('[data-sentry-component="TooltipCopy"]');
      const metric = label => Array.from(card.querySelectorAll(`[data-icon="${label}"]`)).map(text);
      const feeLabels = Array.from(card.querySelectorAll('span')).filter(n => n.children.length === 0 && text(n) === 'F');
      const fee = feeLabels.length === 1 ? feeLabels[0].parentElement : null;
      const feeValues = fee ? Array.from(fee.querySelectorAll('span')).filter(n => n.children.length === 0 && text(n) !== 'F').map(text) : [];
      const feeIcons = fee ? Array.from(fee.querySelectorAll('[data-icon]')).map(n => attr(n, 'data-icon')) : [];
      const age = card.querySelector('.trenches-social-metric-aligned-row');
      return {
        href: attr(card, 'href'), chain_attr: attr(card, 'data-trenches-token-chain'),
        address_attr: attr(card, 'data-trenches-token-address'), key_attr: attr(card, 'data-trenches-token-key'),
        lane_attr: attr(card, 'data-trenches-token-page'), render_index: index,
        index_basis: 'wrapper_translate_y_divided_by_height', row_height: height,
        symbol: text(symbol), name: text(symbol?.nextElementSibling),
        displayed_age: text(age?.firstElementChild), quote_asset: text(card.querySelector('[data-testid="quote-token-tag"]')),
        logo_url: attr(card.querySelector('img[alt="logo"]'), 'src'),
        metrics: { mc: metric('MC'), volume: metric('V'), net_buy: metric('N'), transactions: metric('TX') },
        fee_values: feeValues, fee_icons: feeIcons,
        social_urls: Array.from(card.querySelectorAll('a[aria-label="twitter"]')).map(n => attr(n, 'href')),
        top: card.getBoundingClientRect().top
      };
    }).sort((a, b) => a.top - b.top);
    scope.window = 'current_migrated_list';
  } else {
    const tables = Array.from(document.querySelectorAll('table')).filter(e => visible(e) && e.querySelector('tbody[data-testid="virtuoso-item-list"]'));
    if (tables.length !== 1) return { ...base, errors: ['TRENDING_TABLE_NOT_UNIQUE'] };
    root = tables[0];
    scroller = root.closest('.gmgn-table-scroller');
    if (!scroller) return { ...base, errors: ['TRENDING_SCROLLER_MISSING'] };
    base.headers = Array.from(root.querySelectorAll('thead th')).map(text);
    const times = Array.from(document.querySelectorAll('div')).filter(n => n.children.length === 0 &&
      ['1m', '5m', '1h', '6h', '24h'].includes(text(n)) && n.classList.contains('bg-toggle-highlight'));
    scope.window = times.length === 1 ? text(times[0]) : null;
    base.rows = Array.from(root.querySelectorAll('tbody tr[data-index]')).filter(visible).map(row => {
      const cells = Array.from(row.querySelectorAll('td'));
      const token = row.querySelector('a[data-sentry-component="TokenCellBase"]');
      const title = token?.querySelector('[title]');
      const indexText = attr(row, 'data-index');
      return {
        href: attr(token, 'href'), render_index: /^\d+$/.test(indexText || '') ? Number(indexText) : null,
        index_basis: 'data_index', row_keys: cells.map(n => attr(n, 'data-row-key')),
        symbol: text(title),
        name: title?.nextElementSibling?.matches('[data-sentry-source-file="SearchAddressOrSymbolTooltip.tsx"]') ?
          text(title.nextElementSibling.querySelector('div')) : null,
        displayed_age: null, quote_asset: null,
        logo_url: attr(token?.querySelector('img[alt="logo"]'), 'src'),
        social_urls: Array.from(cells[0]?.querySelectorAll('a[href]') || []).map(n => attr(n, 'href')).filter(u => /^https:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(u)),
        cells: cells.map(cell => ({ text: text(cell), leaves: leaf(cell) })), top: row.getBoundingClientRect().top
      };
    }).sort((a, b) => a.render_index - b.render_index);
  }
  const rect = scroller.getBoundingClientRect();
  base.scroll = { top: scroller.scrollTop, height: scroller.scrollHeight, client: scroller.clientHeight };
  base.visible_indexes = base.rows.filter(r => r.top >= rect.top && r.top < rect.bottom).map(r => r.render_index);
  // Reaching the end of the DOM does not prove the server has no more results.
  base.terminal_evidence = null;
  base.explicit_empty = /^(?:No data|No tokens|No results)$/i.test(text(root));
  return base;
}

const CHAINS = Object.freeze({ sol: 'solana', solana: 'solana', robinhood: 'robinhood' });
const NATIVE = Object.freeze({ solana: 'SOL', robinhood: 'ETH' });
const MISSING = /^(?:-|--|—|N\/A|null|undefined)?$/i;

function amount(raw, unit = 'USD', signed = false) {
  if (raw === null || raw === undefined || (typeof raw === 'string' && MISSING.test(raw.trim()))) {
    return { value: null, raw: raw ?? null, state: 'MISSING', unit };
  }
  if (typeof raw !== 'string') return { value: null, raw, state: 'INVALID', unit };
  let value = raw.trim().replace(/^[\uE000-\uF8FF🔥\s]+/u, '');
  const prefix = signed ? '[+-]?' : '';
  const dollars = unit === 'USD' ? '\\$' : '';
  const match = new RegExp(`^(${prefix})${dollars}((?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?)([KMB])?$`, 'i').exec(value);
  if (!match) return { value: null, raw, state: 'INVALID', unit };
  const scale = { K: 1e3, M: 1e6, B: 1e9 }[match[3]?.toUpperCase()] || 1;
  value = Number(`${match[1]}${match[2].replace(/,/g, '')}`) * scale;
  if (!Number.isFinite(value) || (!signed && value < 0)) return { value: null, raw, state: 'INVALID', unit };
  return { value, raw, state: 'OBSERVED_ROUNDED', unit };
}

function identity(href) {
  if (typeof href !== 'string' || !href) throw new Error('INVALID_TOKEN_URL');
  const url = new URL(href, 'https://gmgn.ai');
  if (url.origin !== 'https://gmgn.ai' || url.username || url.password || url.search || url.hash) throw new Error('INVALID_TOKEN_URL');
  const parts = /^\/(sol|robinhood)\/token\/([^/]+)$/.exec(url.pathname);
  if (!parts) throw new Error('INVALID_TOKEN_PATH');
  const chain = CHAINS[parts[1]];
  const address = chain === 'robinhood' ? parts[2].toLowerCase() : parts[2];
  const valid = chain === 'solana' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) : /^0x[a-f0-9]{40}$/.test(address);
  if (!valid) throw new Error('INVALID_TOKEN_ADDRESS');
  if (chain === 'solana') {
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let value = 0n;
    for (const c of address) value = value * 58n + BigInt(alphabet.indexOf(c));
    let bytes = 0;
    while (value > 0n) { bytes++; value >>= 8n; }
    bytes += /^1*/.exec(address)[0].length;
    if (bytes !== 32) throw new Error('INVALID_SOLANA_ADDRESS_LENGTH');
  }
  return { chain, address, coin_id: `${chain}:${address}`, url: `https://gmgn.ai/${parts[1]}/token/${address}` };
}

function sourceLink(raw) {
  if (typeof raw !== 'string') return { raw: raw ?? null, canonical_url: null, type: 'INVALID', author: null, post_id: null };
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password || !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(u.hostname)) throw new Error();
    const status = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)\/?$/.exec(u.pathname);
    const community = /^\/i\/communities\/(\d+)\/?$/.exec(u.pathname);
    const profile = /^\/([A-Za-z0-9_]{1,15})\/?$/.exec(u.pathname);
    const reserved = new Set(['home', 'search', 'explore', 'settings', 'intent', 'i', 'share', 'login']);
    if (!status && !community && (!profile || reserved.has(profile[1].toLowerCase()))) {
      return { raw, canonical_url: null, type: 'UNSUPPORTED', author: null, post_id: null };
    }
    const pathname = status ? `/${status[1]}/status/${status[2]}` : community ? `/i/communities/${community[1]}` : `/${profile[1]}`;
    return { raw, canonical_url: `https://x.com${pathname}`, type: status ? 'STATUS' : community ? 'COMMUNITY' : 'PROFILE',
      author: status ? (status[1].toLowerCase() === 'i' ? null : status[1]) : profile?.[1] ?? null, post_id: status?.[2] ?? null };
  } catch { return { raw, canonical_url: null, type: 'INVALID', author: null, post_id: null }; }
}

function headerName(raw) {
  return raw.replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function normalizeFrame(raw, { observedAt, captureStartedAt }) {
  if (!raw || !['migrated', 'trending'].includes(raw.feed)) throw new Error('INVALID_FRAME');
  for (const value of [observedAt, captureStartedAt]) {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('INVALID_CAPTURE_TIME');
  }
  if (Date.parse(captureStartedAt) > Date.parse(observedAt)) throw new Error('REVERSED_CAPTURE_TIME');
  const errors = [...(raw.errors || [])];
  const rows = [];
  const seen = new Set();
  const seenIndex = new Set();
  let page;
  try { page = new URL(raw.page_url); } catch { errors.push('INVALID_PAGE_URL'); }
  if (!page || page.origin !== 'https://gmgn.ai' || page.username || page.password ||
    (raw.feed === 'migrated' ? page.pathname !== '/' : page.pathname !== '/trend')) errors.push('WRONG_PAGE');
  const headers = (raw.headers || []).map(headerName);
  const requiredHeaders = ['mc', 'ath mc', 'liq', 'holders', 'total fees'];
  const volumeHeaders = headers.filter(h => /^(?:1m|5m|1h|6h|24h) vol$/.test(h));
  const transactionHeaders = headers.filter(h => /^(?:1m|5m|1h|6h|24h) txs$/.test(h));
  if (raw.feed === 'trending' && volumeHeaders.length !== 1) errors.push('HEADER_NOT_UNIQUE:volume');
  if (raw.feed === 'trending' && transactionHeaders.length !== 1) errors.push('HEADER_NOT_UNIQUE:transactions');
  if (raw.feed === 'trending') for (const h of requiredHeaders) {
    if (headers.filter(v => v === h).length !== 1) errors.push(`HEADER_NOT_UNIQUE:${h}`);
  }
  for (const row of raw.rows || []) {
    try {
      const id = identity(row.href);
      if (!Number.isInteger(row.render_index) || row.render_index < 0) throw new Error('INVALID_RENDER_INDEX');
      if (seen.has(id.coin_id) || seenIndex.has(row.render_index)) throw new Error('DUPLICATE_ID_OR_INDEX');
      seen.add(id.coin_id); seenIndex.add(row.render_index);
      const problems = [];
      const single = (values, unit = 'USD', signed = false) => {
        if (!Array.isArray(values) || values.length > 1) { problems.push('AMBIGUOUS_METRIC'); return amount(null, unit); }
        const parsed = amount(values[0] ?? null, unit, signed);
        if (parsed.state === 'INVALID') problems.push('INVALID_METRIC');
        return parsed;
      };
      let metrics;
      let fee;
      if (raw.feed === 'migrated') {
        const rowChain = CHAINS[row.chain_attr];
        const address = rowChain === 'robinhood' ? row.address_attr?.toLowerCase() : row.address_attr;
        if (id.chain !== rowChain || id.address !== address ||
          row.key_attr !== `${row.address_attr}-${row.chain_attr}` || row.lane_attr !== 'Completed') throw new Error('CARD_IDENTITY_OR_LANE_MISMATCH');
        metrics = { market_cap_usd: single(row.metrics?.mc), volume_usd: single(row.metrics?.volume),
          net_buy_usd: single(row.metrics?.net_buy, 'USD', true), transactions: single(row.metrics?.transactions, 'count') };
        metrics.volume_usd.window = null; // V is not evidence of a 24h window.
        const icons = row.fee_icons || [];
        const expectedIcon = id.chain === 'solana' ? 'IconSolanabal14pxS' : 'IconRobinhoodeth16pxS';
        if (icons.length !== 1 || icons[0] !== expectedIcon) problems.push('NATIVE_FEE_UNIT_UNVERIFIED');
        fee = single(row.fee_values, NATIVE[id.chain]);
        if (icons.length !== 1 || icons[0] !== expectedIcon) fee = { ...fee, value: null, state: 'UNVERIFIED_UNIT' };
      } else {
        const expectedKey = `${id.chain === 'solana' ? 'sol' : id.chain}_${id.address}`;
        if (!row.row_keys?.length || row.row_keys.some(k => typeof k !== 'string' || k.toLowerCase() !== expectedKey.toLowerCase()) ||
          (id.chain === 'solana' && row.row_keys.some(k => k !== expectedKey))) throw new Error('TABLE_IDENTITY_MISMATCH');
        const cell = h => row.cells?.[headers.indexOf(h)];
        const dollars = h => single((cell(h)?.leaves || []).filter(v => /^\$|^[\uE000-\uF8FF🔥\s]+\$/u.test(v)));
        metrics = { market_cap_usd: dollars('mc'), ath_market_cap_usd: dollars('ath mc'),
          liquidity_usd: dollars('liq'), volume_usd: dollars(volumeHeaders[0]),
          transactions: single(cell(transactionHeaders[0])?.leaves?.slice(0, 1), 'count'),
          holders: single(cell('holders')?.leaves, 'count') };
        metrics.volume_usd.window = volumeHeaders.length === 1 ? volumeHeaders[0].split(' ')[0] : null;
        const feeText = cell('total fees')?.text;
        const match = typeof feeText === 'string' && /^(.*?)\s+(SOL|ETH)$/.exec(feeText);
        fee = match ? amount(match[1], match[2]) : amount(null, NATIVE[id.chain]);
        if (!match || match[2] !== NATIVE[id.chain] || fee.state === 'INVALID') {
          problems.push('NATIVE_FEE_UNIT_UNVERIFIED'); fee = { ...fee, value: null, state: 'UNVERIFIED_UNIT' };
        }
      }
      if (!row.symbol?.trim()) problems.push('SYMBOL_MISSING');
      if (metrics.market_cap_usd.state !== 'OBSERVED_ROUNDED') problems.push('MARKET_CAP_UNAVAILABLE');
      if (metrics.volume_usd.state !== 'OBSERVED_ROUNDED') problems.push('VOLUME_UNAVAILABLE');
      rows.push({ ...id, render_index: row.render_index, index_basis: row.index_basis,
        symbol: row.symbol ?? null, name: row.name ?? null, displayed_age: row.displayed_age ?? null,
        quote_asset: row.quote_asset ?? null, logo_url: row.logo_url ?? null, metrics, native_fees: fee,
        // Preserve repeated links and original query strings. A link is not fetched X evidence.
        social_links: (row.social_urls || []).map(sourceLink),
        observed_at: observedAt, upstream_updated_at: null, quality: problems.length ? 'DEGRADED' : 'DOM_QUALIFIED', problems });
      errors.push(...problems.map(p => `${p}:${id.coin_id}`));
    } catch (error) { errors.push(`${error.message}:index=${row.render_index ?? 'unknown'}`); }
  }
  const scope = { ...(raw.scope || {}), selected_chains: (raw.scope?.selected_chains || []).map(c => CHAINS[c] || c).sort() };
  if (!scope.selection_observed || !scope.selected_chains.length) errors.push('SELECTED_CHAINS_UNVERIFIED');
  if (scope.selected_chains.some(c => !NATIVE[c]) || new Set(scope.selected_chains).size !== scope.selected_chains.length) errors.push('UNSUPPORTED_OR_DUPLICATE_CHAIN');
  if (rows.some(r => !scope.selected_chains.includes(r.chain))) errors.push('ROW_OUTSIDE_SELECTED_CHAINS');
  if (!scope.window) errors.push('WINDOW_UNVERIFIED');
  return { version: 1, feed: raw.feed, page_url: raw.page_url,
    capture_started_at: captureStartedAt, observed_at: observedAt, scope, rows,
    scroll: raw.scroll ?? null, visible_indexes: raw.visible_indexes || [],
    explicit_empty: raw.explicit_empty === true, terminal_evidence: raw.terminal_evidence ?? null,
    errors, raw };
}

async function captureFrame(tab, feed) {
  const captureStartedAt = new Date().toISOString();
  const raw = await tab.playwright.evaluate(readDom, { feed });
  return normalizeFrame(raw, { captureStartedAt, observedAt: new Date().toISOString() });
}

module.exports = { readDom, captureFrame, normalizeFrame, identity, amount, sourceLink };
