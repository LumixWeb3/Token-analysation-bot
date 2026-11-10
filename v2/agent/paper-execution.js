'use strict';

// One atomic simulated action. The existing account remains the sole ledger.
const { PaperAccount, validatedQuote } = require('../../paper-ledger-core');
const { hash } = require('../market/network-feed');
const { coinIdentity } = require('./token-evidence');
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const actionSchema = { type: 'object', additionalProperties: false, properties: {
  action: { type: 'string', enum: ['BUY', 'ADD', 'TRIM', 'EXIT'] },
  coin_id: { type: 'string' }, expected_account_revision: { type: 'integer', minimum: 0 },
  percent: { type: 'number', exclusiveMinimum: 0, maximum: 100 },
  entry_low_mc: { anyOf: [{ type: 'number' }, { type: 'null' }] },
  entry_high_mc: { anyOf: [{ type: 'number' }, { type: 'null' }] },
  reason: { type: 'string' }
}, required: ['action', 'coin_id', 'expected_account_revision', 'percent', 'entry_low_mc', 'entry_high_mc', 'reason'] };

function validateAction(action) {
  if (!action || Object.keys(action).sort().join() !== [...actionSchema.required].sort().join() ||
      !['BUY', 'ADD', 'TRIM', 'EXIT'].includes(action.action) ||
      !Number.isSafeInteger(action.expected_account_revision) || action.expected_account_revision < 0 ||
      !positive(action.percent) || action.percent > 100 ||
      typeof action.reason !== 'string' || !action.reason.trim() || action.reason.length > 500)
    throw Error('V2_PAPER_ACTION_INVALID');
  if (coinIdentity(action.coin_id).coin_id !== action.coin_id) throw Error('V2_PAPER_IDENTITY_INVALID');
  if (['BUY', 'ADD'].includes(action.action)) {
    if (action.percent > 25 || !positive(action.entry_low_mc) || !positive(action.entry_high_mc) ||
        action.entry_low_mc > action.entry_high_mc) throw Error('V2_PAPER_ENTRY_LIMITS');
  } else if (action.entry_low_mc !== null || action.entry_high_mc !== null ||
      (action.action === 'EXIT' ? action.percent !== 100 : action.percent >= 100))
    throw Error('V2_PAPER_REDUCTION_INVALID');
  return action;
}

function createPaperExecution({ filePath, now = () => Date.now() } = {}) {
  if (typeof filePath !== 'string' || !require('node:path').isAbsolute(filePath)) throw Error('V2_EXISTING_ACCOUNT_PATH_REQUIRED');
  const ledger = new PaperAccount({ filePath, now });
  // Deliberately no initialize call. Missing/corrupt accounts need explicit action.
  function context() {
    const state = ledger.read();
    return { ...ledger.snapshot(null, null, { state, now: now() }), revision: state.revision };
  }
  function receipt(runId) {
    const state=ledger.read();
    return state.receipts['v2:'+runId]??state.receipts['initial:v2-'+runId]??null;
  }
  function execute({ runId, action, quote, strategy, evidenceQualified = false, marketReady = false }) {
    validateAction(action);
    if (typeof runId !== 'string' || !/^[a-f0-9-]{36}$/.test(runId)) throw Error('V2_PAPER_RUN_ID_REQUIRED');
    const key = action.action==='BUY'?'initial:v2-'+runId:'v2:'+runId;
    const fingerprint = hash({ action, strategy_version: strategy?.version });
    const existing=receipt(runId);
    if(existing){if(existing.request_fingerprint!==fingerprint)throw Error('V2_PAPER_ACTION_ID_CONFLICT');return existing;}
    return ledger.transact(state => {
      const prior = state.receipts[key];
      if (prior) {
        if (prior.request_fingerprint !== fingerprint) throw Error('V2_PAPER_ACTION_ID_CONFLICT');
        return prior;
      }
      if (state.revision !== action.expected_account_revision) throw Error('V2_PAPER_ACCOUNT_REVISION_CHANGED');
      const exposure = ['BUY', 'ADD'].includes(action.action);
      if (exposure && (strategy?.strategy_status !== 'RESEARCHED' || !marketReady || !evidenceQualified))
        throw Error('V2_PAPER_ENTRY_NOT_QUALIFIED');
      const q = validatedQuote(action.coin_id, quote, now());
      if (exposure && (!positive(q.market_cap_usd) || q.market_cap_usd < action.entry_low_mc || q.market_cap_usd > action.entry_high_mc))
        throw Error('PAPER_ENTRY_OUT_OF_BOUNDS');
      let trade = Object.values(state.trades).find(item => item.coin_id === action.coin_id && item.status === 'OPEN');
      if (action.action === 'BUY') {
        if (trade || Object.values(state.reservations).some(item => item.coin_id === action.coin_id)) throw Error('PAPER_DUPLICATE_POSITION');
        if (Object.values(state.trades).filter(item => item.status === 'OPEN').length + Object.keys(state.reservations).length >= 5)
          throw Error('PAPER_POSITION_CAP');
        const tradeId = 'v2-' + runId;
        if (state.trades[tradeId]) throw Error('V2_PAPER_ACTION_ID_CONFLICT');
        trade = { trade_id: tradeId, coin_id: action.coin_id, name: action.coin_id, status: 'OPEN', quantity: 0,
          cost_basis_usd: 0, realized_pnl_usd: 0, bought_quantity: 0, sold_quantity: 0,
          opened_at: new Date(now()).toISOString(), meta: { runId:tradeId, model_run_id:runId, entryMC: q.market_cap_usd,
            strategy_version: strategy.version, entry_low_mc: action.entry_low_mc, entry_high_mc: action.entry_high_mc }, mark: q };
        state.trades[tradeId] = trade;
      } else if (!trade) throw Error('PAPER_POSITION_NOT_OPEN');
      if (action.action !== 'BUY' && action.action !== 'EXIT' && now() - Date.parse(trade.last_action_at) < 300000)
        throw Error('PAPER_ACTION_COOLDOWN');
      const amount = exposure ? ledger.buyBudget(state, action.percent, trade) : action.percent;
      return ledger.fill(state, trade, exposure ? 'BUY' : 'SELL', amount, q, key, action.reason.trim(), fingerprint);
    });
  }
  return { context, execute, receipt, mark: (tradeId,quote)=>ledger.mark(tradeId,quote) };
}

module.exports = { createPaperExecution, validateAction, actionSchema };
