'use strict';

// D-24: USD simulation only. No wallet, swap client or real execution path.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeCoinReference } = require('./chain-registry');
const DEFAULT_PATH = path.join(__dirname, 'paper-account.json');
const SCHEMA = 'paper-account.v1';
const COSTS = Object.freeze({ fee_bps: 100, slippage_bps: 100, fixed_fee_usd: 0.05 });
const money = n => Math.round(n * 1e8) / 1e8;
const positive = n => typeof n === 'number' && Number.isFinite(n) && n > 0;
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonnegative = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const validId = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,180}$/.test(v)
    && !['__proto__', 'constructor', 'prototype'].includes(v);
const actionFingerprint = a => crypto.createHash('sha256').update(JSON.stringify({ action: a.action, percent: a.percent, reason: a.reason.trim() })).digest('hex');
const reservationFingerprint = r => crypto.createHash('sha256').update(JSON.stringify(r)).digest('hex');

function validatedQuote(coinId, quote, now = Date.now()) {
    const identity = normalizeCoinReference(coinId);
    if (quote?.ok !== true || quote.coin_id !== identity.coin_id || quote.chain !== identity.chain || quote.address !== identity.address) {
        throw new Error('PAPER_QUOTE_IDENTITY_INVALID');
    }
    const at = Date.parse(quote.scraped_at);
    if (!Number.isFinite(at) || at > now + 5000 || now - at > 120000) throw new Error('PAPER_QUOTE_STALE');
    if (!positive(quote.price_usd)) throw new Error('PAPER_USD_PRICE_UNAVAILABLE');
    return { price_usd: quote.price_usd, market_cap_usd: quote.market_cap_usd ?? null, observed_at: quote.scraped_at, source: 'GMGN_EXACT_TOKEN_PAGE', coin_id: coinId };
}

function initialEntryFill(state, tradeId) {
    const trade = state.trades[tradeId], fill = state.receipts[`initial:${tradeId}`];
    const opened = Date.parse(trade?.opened_at), filled = Date.parse(fill?.filled_at);
    // Older writes took separate clock samples for creation and the actual fill.
    // Preserve those bytes; monitoring uses the recorded FIRST FILL timestamp.
    if (!trade || !fill || fill.action !== 'BUY' || fill.trade_id !== tradeId || fill.coin_id !== trade.coin_id
        || fill.quote?.coin_id !== trade.coin_id || !positive(fill.quote?.market_cap_usd)
        || !positive(fill.quote?.price_usd) || trade.meta?.entryMC !== fill.quote.market_cap_usd
        || (trade.meta.runId && trade.meta.runId !== tradeId)
        || !Number.isFinite(opened) || !Number.isFinite(filled) || filled < opened || filled - opened > 5000) {
        throw new Error('PAPER_ENTRY_FILL_HISTORY_CONFLICT');
    }
    return fill;
}

function validateState(s) {
    if (s?.schema_version !== SCHEMA || !validId(s.account_id) || !Number.isFinite(Date.parse(s.created_at))
        || !Number.isSafeInteger(s.revision) || s.revision < 0 || !positive(s.initial_cash_usd) || !nonnegative(s.cash_usd)
        || !Array.isArray(s.fills) || !record(s.trades) || !record(s.reservations) || !record(s.receipts)) throw new Error('PAPER_ACCOUNT_INVALID');
    if (!Number.isFinite(s.costs?.fee_bps) || s.costs.fee_bps < 0 || s.costs.fee_bps > 1000
        || !Number.isFinite(s.costs.slippage_bps) || s.costs.slippage_bps < 0 || s.costs.slippage_bps > 1000
        || !Number.isFinite(s.costs.fixed_fee_usd) || s.costs.fixed_fee_usd < 0) throw new Error('PAPER_COSTS_INVALID');
    let cash = s.initial_cash_usd;
    const balances = Object.create(null);
    const ids = new Set();
    for (const f of s.fills) {
        if (!record(f) || !validId(f.fill_id) || !validId(f.trade_id) || ids.has(f.fill_id)
            || !['BUY', 'SELL'].includes(f.action) || !positive(f.quantity) || !positive(f.fill_price_usd)
            || !nonnegative(f.remaining_quantity) || !Number.isFinite(Date.parse(f.filled_at))
            || !Number.isFinite(f.cash_delta_usd) || !Number.isFinite(f.cost_basis_delta_usd)
            || !Number.isFinite(f.realized_pnl_usd) || !s.trades[f.trade_id]
            || f.coin_id !== s.trades[f.trade_id].coin_id) throw new Error('PAPER_FILL_INVALID');
        ids.add(f.fill_id);
        if (JSON.stringify(s.receipts[f.fill_id]) !== JSON.stringify(f)) throw new Error('PAPER_RECEIPT_RECONCILIATION_FAILED');
        if (f.action === 'BUY' && (f.cash_delta_usd >= 0 || f.cost_basis_delta_usd !== -f.cash_delta_usd || f.realized_pnl_usd !== 0)) throw new Error('PAPER_BUY_FILL_INVALID');
        if (f.action === 'SELL' && (f.cash_delta_usd < 0 || f.cost_basis_delta_usd > 0
            || Math.abs(f.realized_pnl_usd - money(f.cash_delta_usd + f.cost_basis_delta_usd)) > 1e-7)) throw new Error('PAPER_SELL_FILL_INVALID');
        cash = money(cash + f.cash_delta_usd);
        const b = balances[f.trade_id] ||= { quantity: 0, basis: 0, realized: 0 };
        b.quantity += f.action === 'BUY' ? f.quantity : -f.quantity;
        b.basis = money(b.basis + f.cost_basis_delta_usd);
        b.realized = money(b.realized + f.realized_pnl_usd);
        if (Math.abs(b.quantity - f.remaining_quantity) > Math.max(1e-7, Math.abs(b.quantity) * 1e-10)) throw new Error('PAPER_FILL_QUANTITY_RECONCILIATION_FAILED');
        if (b.quantity < -1e-7 || b.basis < -1e-7 || cash < -1e-7) throw new Error('PAPER_LEDGER_OVERSPENT');
    }
    if (Math.abs(cash - s.cash_usd) > 1e-6) throw new Error('PAPER_CASH_RECONCILIATION_FAILED');
    for (const [id, t] of Object.entries(s.trades)) {
        const b = balances[id];
        if (!validId(id) || !record(t) || t.trade_id !== id || normalizeCoinReference(t.coin_id).coin_id !== t.coin_id
            || !nonnegative(t.cost_basis_usd) || !Number.isFinite(t.realized_pnl_usd)
            || !nonnegative(t.bought_quantity) || !nonnegative(t.sold_quantity)
            || Math.abs(t.bought_quantity - t.sold_quantity - t.quantity) > Math.max(1e-7, t.bought_quantity * 1e-10)
            || t.mark?.coin_id !== t.coin_id || !positive(t.mark?.price_usd) || !Number.isFinite(Date.parse(t.mark?.observed_at))
            || !Number.isFinite(Date.parse(t.opened_at)) || !Number.isFinite(Date.parse(t.last_action_at))
            || !b || !nonnegative(t.quantity) || Math.abs(b.quantity - t.quantity) > Math.max(1e-7, t.quantity * 1e-10)
            || Math.abs(b.basis - t.cost_basis_usd) > 1e-6 || Math.abs(b.realized - t.realized_pnl_usd) > 1e-6
            || !['OPEN', 'CLOSED'].includes(t.status) || (t.status === 'CLOSED' && (t.quantity !== 0 || t.cost_basis_usd !== 0))
            || (t.status === 'OPEN' && t.quantity <= 0)) throw new Error('PAPER_POSITION_RECONCILIATION_FAILED');
    }
    if (Object.keys(balances).some(id => !s.trades[id])) throw new Error('PAPER_ORPHAN_FILL');
    if (Object.keys(s.receipts).some(id => !ids.has(id))) throw new Error('PAPER_ORPHAN_RECEIPT');
    const activeCoins = new Set(Object.values(s.trades).filter(t => t.status === 'OPEN').map(t => t.coin_id));
    if (activeCoins.size !== Object.values(s.trades).filter(t => t.status === 'OPEN').length) throw new Error('PAPER_DUPLICATE_POSITION');
    for (const [id, r] of Object.entries(s.reservations)) {
        if (!validId(id) || !record(r) || r.trade_id !== id || s.trades[id] || !positive(r.budget_usd)
            || !positive(r.buy_cash_percent) || r.buy_cash_percent > 25 || !Number.isFinite(Date.parse(r.created_at))
            || normalizeCoinReference(r.coin_id).coin_id !== r.coin_id || activeCoins.has(r.coin_id)
            || !positive(r.meta?.entry_low_mc) || !positive(r.meta?.entry_high_mc) || r.meta.entry_low_mc > r.meta.entry_high_mc) throw new Error('PAPER_RESERVATIONS_INVALID');
        activeCoins.add(r.coin_id);
    }
    if (activeCoins.size > 5) throw new Error('PAPER_POSITION_CAP');
    const reserved = Object.values(s.reservations).reduce((n, r) => n + r.budget_usd, 0);
    if (!Number.isFinite(reserved) || reserved < 0 || reserved > s.cash_usd + 1e-6) throw new Error('PAPER_RESERVATIONS_INVALID');
    // Additive v1 audit map: older accounts without it remain valid, not reset.
    if (s.entry_resolutions !== undefined && !record(s.entry_resolutions)) throw new Error('PAPER_ENTRY_RESOLUTIONS_INVALID');
    for (const [id, resolution] of Object.entries(s.entry_resolutions || {})) {
        const r = resolution?.reservation;
        if (!validId(id) || resolution?.status !== 'NOT_ENTERED' || resolution.reason !== 'DECISION_EXPIRED'
            || !record(r) || r.trade_id !== id || s.trades[id] || s.reservations[id]
            || normalizeCoinReference(r.coin_id).coin_id !== r.coin_id || !positive(r.budget_usd)
            || !positive(r.buy_cash_percent) || r.buy_cash_percent > 25
            || !positive(r.meta?.entry_low_mc) || !positive(r.meta?.entry_high_mc) || r.meta.entry_low_mc > r.meta.entry_high_mc
            || resolution.reservation_sha256 !== reservationFingerprint(r)
            || !Number.isFinite(Date.parse(resolution.resolved_at)) || !Number.isFinite(Date.parse(r.created_at))
            || Date.parse(resolution.resolved_at) - Date.parse(r.created_at) <= 120000
            || resolution.publication?.run_id !== id || resolution.publication?.coin_id !== r.coin_id
            || typeof resolution.publication.channel_id !== 'string' || !resolution.publication.channel_id.trim()
            || !/^[a-f0-9]{64}$/.test(resolution.publication.story_sha256)
            || typeof resolution.publication?.alphy_message_id !== 'string' || !resolution.publication.alphy_message_id.trim()
            || typeof resolution.publication?.trixy_message_id !== 'string' || !resolution.publication.trixy_message_id.trim()
            || resolution.publication.alphy_message_id === resolution.publication.trixy_message_id
            || !Number.isFinite(Date.parse(resolution.publication.published_at))
            || Date.parse(resolution.publication.published_at) > Date.parse(resolution.resolved_at) + 5000
            || Date.parse(resolution.publication.published_at) < Date.parse(r.created_at) - 5000) throw new Error('PAPER_ENTRY_RESOLUTIONS_INVALID');
    }
    return s;
}

class PaperAccount {
    constructor({ filePath = DEFAULT_PATH, now = () => Date.now(), renameFn = fs.renameSync,
        waitFn = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
        publishedIdentity = () => { throw new Error('PAPER_PUBLICATION_PROOF_UNAVAILABLE'); } } = {}) {
        this.filePath = filePath;
        this.publishedIdentity = publishedIdentity;
        this.now = now;
        this.renameFn = renameFn;
        this.waitFn = waitFn;
    }
    read() {
        if (!fs.existsSync(this.filePath)) throw new Error('PAPER_ACCOUNT_NOT_INITIALIZED');
        return validateState(JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
    }
    initialize(initialCash = 30) {
        if (fs.existsSync(this.filePath)) return this.read();
        if (!positive(initialCash)) throw new Error('PAPER_INITIAL_CASH_INVALID');
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        const s = { schema_version: SCHEMA, account_id: crypto.randomUUID(), created_at: new Date(this.now()).toISOString(),
            initial_cash_usd: initialCash, cash_usd: initialCash, costs: { ...COSTS }, costs_basis: 'SIMULATION_ASSUMPTIONS_NOT_ACTUAL_VENUE_FEES',
            revision: 0, trades: {}, reservations: {}, receipts: {}, fills: [] };
        // Exclusive create: never reset an existing or corrupt account.
        const fd = fs.openSync(this.filePath, 'wx');
        try { fs.writeSync(fd, JSON.stringify(s, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        return s;
    }
    transact(change) {
        // Fail closed if another writer (or an interrupted write) owns the lock.
        const lock = `${this.filePath}.lock`;
        const fd = fs.openSync(lock, 'wx');
        try {
            const s = this.read();
            const result = change(s);
            validateState(s);
            s.revision += 1;
            const tmp = `${this.filePath}.${process.pid}.tmp`;
            const out = fs.openSync(tmp, 'w');
            try { fs.writeSync(out, JSON.stringify(s, null, 2)); fs.fsyncSync(out); } finally { fs.closeSync(out); }
            // OneDrive/Windows may briefly hold a reader lock on the ledger.
            // Retry replacement of these exact validated bytes only; never
            // rerun the trade action or remove the existing ledger to force it.
            for (let attempt = 0; ; attempt += 1) {
                try { this.renameFn(tmp, this.filePath); break; }
                catch (error) {
                    if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 7) throw error;
                    this.waitFn(100);
                }
            }
            return result;
        } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
    }
    snapshot(coinId = null, tradeId = null, { state = null, now = this.now() } = {}) {
        // Read-only reports can bind all fields to one validated ledger revision.
        const s = state === null ? this.read() : validateState(state);
        const reserved = money(Object.values(s.reservations).reduce((n, r) => n + r.budget_usd, 0));
        const trades = Object.values(s.trades);
        const open = trades.filter(t => t.status === 'OPEN');
        const marked = open.map(t => {
            const age = now - Date.parse(t.mark?.observed_at);
            const fresh = Number.isFinite(age) && age >= -5000 && age <= 120000;
            const value = fresh ? money(t.quantity * t.mark.price_usd) : null;
            const net = fresh ? money(Math.max(0, value * (1 - s.costs.slippage_bps / 10000) * (1 - s.costs.fee_bps / 10000) - s.costs.fixed_fee_usd)) : null;
            return { ...t, mark_fresh: !!fresh, market_value_usd: value, estimated_liquidation_value_usd: net,
                average_remaining_cost_usd: t.quantity > 0 ? t.cost_basis_usd / t.quantity : null,
                unrealized_return_percent: net !== null && t.cost_basis_usd > 0 ? money((net / t.cost_basis_usd - 1) * 100) : null,
                unrealized_pnl_usd: net === null ? null : money(net - t.cost_basis_usd) };
        });
        const complete = marked.every(t => t.mark_fresh);
        return { schema_version: SCHEMA, account_id: s.account_id, mode: 'PAPER_ONLY', initial_cash_usd: s.initial_cash_usd,
            cash_usd: s.cash_usd, reserved_cash_usd: reserved, available_cash_usd: money(s.cash_usd - reserved),
            realized_pnl_usd: money(trades.reduce((n, t) => n + t.realized_pnl_usd, 0)),
            estimated_equity_usd: complete ? money(s.cash_usd + marked.reduce((n, t) => n + t.estimated_liquidation_value_usd, 0)) : null,
            valuation_complete: complete, costs: s.costs, costs_basis: s.costs_basis,
            pending_entries: Object.values(s.reservations).map(r => ({ trade_id: r.trade_id, coin_id: r.coin_id, budget_usd: r.budget_usd,
                created_at: r.created_at, expired: now - Date.parse(r.created_at) > 120000 })),
            limits: { max_buy_cash_percent: 25, default_initial_buy_cash_percent: 20, min_order_usd: 1, max_open_positions: 5,
                max_coin_cost_basis_usd: this.riskCap(s), action_cooldown_seconds: 300 },
            positions: marked, position: marked.find(t => (!coinId || t.coin_id === coinId) && (!tradeId || t.trade_id === tradeId)) || null,
            recent_fills: s.fills.filter(f => (!coinId || f.coin_id === coinId) && (!tradeId || f.trade_id === tradeId)).slice(-10),
            review_queue: trades.filter(t => t.status === 'CLOSED').map(t => ({ trade_id: t.trade_id, coin_id: t.coin_id, name: t.name, closed_at: t.closed_at, realized_pnl_usd: t.realized_pnl_usd })) };
    }
    riskCap(s) { return money(Math.max(0, s.initial_cash_usd + Object.values(s.trades).reduce((n, t) => n + t.realized_pnl_usd, 0)) * 0.25); }
    buyBudget(s, percent, existing = null) {
        if (!positive(percent) || percent > 25) throw new Error('PAPER_BUY_PERCENT_INVALID');
        const available = s.cash_usd - Object.values(s.reservations).reduce((n, r) => n + r.budget_usd, 0);
        const budget = money(Math.min(available * percent / 100, this.riskCap(s) - (existing?.cost_basis_usd || 0)));
        if (budget < 1) throw new Error('PAPER_INSUFFICIENT_CASH_OR_RISK_CAP');
        return budget;
    }
    reserveBuy(tradeId, coinId, percent, quote, meta = {}) {
        validatedQuote(coinId, quote, this.now());
        if (!validId(tradeId) || !positive(percent) || percent > 25) throw new Error('PAPER_BUY_PERCENT_INVALID');
        if (!positive(meta.entry_low_mc) || !positive(meta.entry_high_mc) || meta.entry_low_mc > meta.entry_high_mc) throw new Error('PAPER_ENTRY_BOUNDS_REQUIRED');
        return this.transact(s => {
            if (s.entry_resolutions?.[tradeId]) throw new Error('PAPER_ENTRY_ALREADY_RESOLVED');
            if (s.reservations[tradeId]) {
                const prior = s.reservations[tradeId];
                if (prior.coin_id !== coinId || prior.buy_cash_percent !== percent
                    || JSON.stringify(prior.meta) !== JSON.stringify(meta)) throw new Error('PAPER_ORDER_ID_CONFLICT');
                return s.reservations[tradeId];
            }
            if (s.trades[tradeId] || Object.values(s.trades).some(t => t.coin_id === coinId && t.status === 'OPEN')
                || Object.values(s.reservations).some(r => r.coin_id === coinId)) throw new Error('PAPER_DUPLICATE_POSITION');
            if (Object.values(s.trades).filter(t => t.status === 'OPEN').length + Object.keys(s.reservations).length >= 5) throw new Error('PAPER_POSITION_CAP');
            const r = { trade_id: tradeId, coin_id: coinId, budget_usd: this.buyBudget(s, percent), buy_cash_percent: percent,
                created_at: new Date(this.now()).toISOString(), meta };
            s.reservations[tradeId] = r;
            return r;
        });
    }
    releaseReservation(tradeId) { return this.transact(s => { delete s.reservations[tradeId]; return true; }); }
    resolveExpiredEntry(tradeId, coinId, expectedHash, job) {
        const proof = this.publishedIdentity(job, this.now());
        if (proof.run_id !== tradeId || proof.coin_id !== coinId) throw new Error('PAPER_ENTRY_IDENTITY_CONFLICT');
        if (job.paper_entry_intent && (job.paper_entry_intent.reservation_sha256 !== expectedHash
            || reservationFingerprint(job.paper_entry_intent.reservation) !== expectedHash)) throw new Error('PAPER_ENTRY_INTENT_CONFLICT');
        const prior = this.read().entry_resolutions?.[tradeId];
        if (prior) {
            if (prior.reservation.coin_id !== coinId || prior.reservation_sha256 !== expectedHash
                || JSON.stringify(prior.publication) !== JSON.stringify(proof)) throw new Error('PAPER_ENTRY_RESOLUTION_CONFLICT');
            return prior;
        }
        return this.transact(s => {
            const r = s.reservations[tradeId];
            if (s.trades[tradeId] || s.receipts[`initial:${tradeId}`] || !r || r.coin_id !== coinId
                || reservationFingerprint(r) !== expectedHash) throw new Error('PAPER_ENTRY_RESOLUTION_CONFLICT');
            if (Date.parse(job.created_at) < Date.parse(r.created_at) - 5000) throw new Error('PAPER_ENTRY_DECISION_TIME_INVALID');
            if (this.now() - Date.parse(r.created_at) <= 120000) throw new Error('PAPER_ENTRY_NOT_EXPIRED');
            const resolution = { status: 'NOT_ENTERED', reason: 'DECISION_EXPIRED', reservation: r,
                reservation_sha256: expectedHash, publication: proof, resolved_at: new Date(this.now()).toISOString() };
            s.entry_resolutions ||= {};
            s.entry_resolutions[tradeId] = resolution;
            delete s.reservations[tradeId]; // cash/fills unchanged; only availability returns
            return resolution;
        });
    }
    commitBuy(tradeId, quote, expectedReservationHash = null) {
        const state = this.read(), existing = state.trades[tradeId];
        if (state.entry_resolutions?.[tradeId]) throw new Error('PAPER_ENTRY_ALREADY_RESOLVED');
        if (existing) return state.receipts[`initial:${tradeId}`];
        return this.transact(s => {
            if (s.entry_resolutions?.[tradeId]) throw new Error('PAPER_ENTRY_ALREADY_RESOLVED');
            if (s.trades[tradeId]) return s.receipts[`initial:${tradeId}`];
            const r = s.reservations[tradeId];
            if (!r) throw new Error('PAPER_BUY_NOT_RESERVED');
            if (expectedReservationHash && reservationFingerprint(r) !== expectedReservationHash) throw new Error('PAPER_ENTRY_INTENT_CONFLICT');
            if (Date.parse(r.created_at) > this.now() + 5000) throw new Error('PAPER_ENTRY_DECISION_TIME_INVALID');
            if (this.now() - Date.parse(r.created_at) > 120000) throw new Error('PAPER_ENTRY_DECISION_EXPIRED_RECONCILIATION_REQUIRED');
            const q = validatedQuote(r.coin_id, quote, this.now());
            if (!positive(q.market_cap_usd) || q.market_cap_usd < r.meta.entry_low_mc || q.market_cap_usd > r.meta.entry_high_mc) throw new Error('PAPER_ENTRY_OUT_OF_BOUNDS');
            const t = { trade_id: tradeId, coin_id: r.coin_id, name: r.meta.name || r.coin_id, status: 'OPEN', quantity: 0, cost_basis_usd: 0,
                realized_pnl_usd: 0, bought_quantity: 0, sold_quantity: 0, opened_at: new Date(this.now()).toISOString(),
                meta: { ...r.meta, entryMC: q.market_cap_usd }, mark: q };
            s.trades[tradeId] = t;
            delete s.reservations[tradeId];
            return this.fill(s, t, 'BUY', r.budget_usd, q, `initial:${tradeId}`, 'initial validated signal', null);
        });
    }
    fill(s, t, action, amount, q, key, reason, requestFingerprint) {
        const before = { quantity: t.quantity, basis: t.cost_basis_usd };
        const price = q.price_usd * (1 + (action === 'BUY' ? 1 : -1) * s.costs.slippage_bps / 10000);
        let quantity, cashDelta, basisDelta, realized = 0;
        if (action === 'BUY') {
            if (amount > s.cash_usd + 1e-8) throw new Error('PAPER_INSUFFICIENT_CASH');
            const notional = (amount - s.costs.fixed_fee_usd) / (1 + s.costs.fee_bps / 10000);
            if (!positive(notional)) throw new Error('PAPER_FEE_EXCEEDS_ORDER');
            quantity = notional / price; cashDelta = -amount; basisDelta = amount;
            t.quantity += quantity; t.bought_quantity += quantity;
        } else {
            quantity = amount === 100 ? t.quantity : t.quantity * amount / 100;
            const proceeds = quantity * price * (1 - s.costs.fee_bps / 10000) - s.costs.fixed_fee_usd;
            if (amount !== 100 && proceeds < 1) throw new Error('PAPER_SELL_TOO_SMALL_AFTER_COSTS');
            // Full-exit dust is explicitly written off for zero proceeds. We
            // never manufacture a profit or leave an unsellable paper holding.
            cashDelta = money(Math.max(0, proceeds)); basisDelta = -money(before.basis * quantity / before.quantity);
            realized = money(cashDelta + basisDelta);
            t.quantity = amount === 100 ? 0 : t.quantity - quantity; t.sold_quantity += quantity;
        }
        t.cost_basis_usd = money(t.cost_basis_usd + basisDelta);
        t.realized_pnl_usd = money(t.realized_pnl_usd + realized);
        t.last_action_at = new Date(this.now()).toISOString(); t.mark = q;
        if (action === 'BUY' && before.quantity === 0) t.opened_at = t.last_action_at;
        if (t.quantity === 0) { t.status = 'CLOSED'; t.closed_at = t.last_action_at; }
        s.cash_usd = money(s.cash_usd + cashDelta);
        const f = { fill_id: key, trade_id: t.trade_id, coin_id: t.coin_id, action, quantity, fill_price_usd: price,
            cash_delta_usd: cashDelta, cost_basis_delta_usd: basisDelta, realized_pnl_usd: realized,
            quote: q, costs: { ...s.costs }, reason, request_fingerprint: requestFingerprint,
            settlement: action === 'SELL' && cashDelta === 0 ? 'DUST_WRITE_OFF_NO_PROCEEDS' : 'SIMULATED_FILL',
            filled_at: t.last_action_at, remaining_quantity: t.quantity };
        s.fills.push(f); s.receipts[key] = f;
        return f;
    }
    act(tradeId, key, action, quote) {
        if (!validId(tradeId) || !validId(key) || !['BUY', 'SELL'].includes(action?.action) || !positive(action.percent)
            || action.percent > (action.action === 'BUY' ? 25 : 100) || typeof action.reason !== 'string'
            || !action.reason.trim() || action.reason.length > 500) throw new Error('PAPER_ACTION_INVALID');
        const fingerprint = actionFingerprint(action);
        return this.transact(s => {
            if (s.receipts[key]) {
                if (s.receipts[key].trade_id !== tradeId || s.receipts[key].request_fingerprint !== fingerprint) throw new Error('PAPER_ACTION_ID_CONFLICT');
                return s.receipts[key];
            }
            const t = s.trades[tradeId];
            if (!t || t.status !== 'OPEN') throw new Error('PAPER_POSITION_NOT_OPEN');
            const q = validatedQuote(t.coin_id, quote, this.now());
            if (!['BUY', 'SELL'].includes(action.action) || !positive(action.percent) || action.percent > (action.action === 'BUY' ? 25 : 100)
                || typeof action.reason !== 'string' || !action.reason.trim()) throw new Error('PAPER_ACTION_INVALID');
            if (action.action === 'BUY' || action.percent !== 100) {
                if (this.now() - Date.parse(t.last_action_at) < 300000) throw new Error('PAPER_ACTION_COOLDOWN');
            }
            const amount = action.action === 'BUY' ? this.buyBudget(s, action.percent, t) : action.percent;
            return this.fill(s, t, action.action, amount, q, key, action.reason.trim(), fingerprint);
        });
    }
    mark(tradeId, quote) {
        return this.transact(s => {
            const t = s.trades[tradeId];
            if (!t || t.status !== 'OPEN') throw new Error('PAPER_POSITION_NOT_OPEN');
            t.mark = validatedQuote(t.coin_id, quote, this.now());
            return t.mark;
        });
    }
}

module.exports = { PaperAccount, validatedQuote, validateState, DEFAULT_PATH, reservationFingerprint, initialEntryFill };
