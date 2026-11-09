/**
 * gmgn-token-page-scraper.js
 *
 * Scrapes everything visible on a supported GMGN token page in one pass and
 * captures the chart region as a base64 screenshot.
 *
 * Two public functions:
 *   scrapeTokenPage(mint, opts?)        → returns the full structured data object
 *   captureChartScreenshot(mint, opts?) → returns { base64, width, height, captured_at }
 *
 * Both accept an existing { page } in opts so the persistent-browser pattern
 * can reuse one Chromium instance across many calls (Phase 2 / Task 12 spec).
 * If no page is passed, the function launches its own one-shot browser.
 *
 * Selector strategy (verified against a live dump 2026-05-20):
 *   - Sentry component anchors are stable across reloads — every block we
 *     care about has a `data-sentry-component="<Name>"` attribute. We bind
 *     to those, then walk inward by label text rather than by class names
 *     (which are Tailwind-compiled and may change on a deploy).
 *   - Mint + symbol are exposed as ids #token-base-address + #token-base-symbol
 *     with `data-addr` / `data-symbol` attributes — those are the most
 *     stable selectors on the page.
 *
 * Naming rationale: every field returns null (not 0, not empty string) when
 * the page doesn't expose it. Callers must distinguish "unknown" from "zero".
 */

const { chromium } = require('playwright');
const {
    createCoinIdentity,
    getChainConfig,
    gmgnTokenUrl,
    normalizeCoinReference,
    normalizeAddress
} = require('./chain-registry');

const TOKEN_PAGE_URL = (tokenReference, options = {}) => gmgnTokenUrl(tokenReference, options);
const NAV_TIMEOUT_MS = 30_000;
const SETTLE_MS = 4_000;   // post-load wait so React renders price/holders into the DOM
const GMGN_FALLBACK_SCHEMA_VERSION = 'gmgn-fallback.v2';

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function hasValue(value) {
    return value !== null && value !== undefined && value !== '';
}

/**
 * Coverage is deliberately field-based. A successful page navigation is not
 * proof that GMGN rendered the data we care about, and zero is a valid value
 * for fields such as snipers/dev holdings/bundler percentage.
 */
function assessTokenPageCoverage(data = {}) {
    const sectionFields = {
        identity: ['address', 'symbol'],
        market: ['market_cap_usd', 'liquidity_usd', 'volume_24h_usd', 'total_fees_native'],
        holders: ['holders_count', 'top10_concentration_pct', 'bundler_pct_gmgn'],
        developer: ['dev_wallet', 'dev_funding_source', 'dev_token_count'],
        social: ['socials'],
        pool_telemetry: ['pool_amm_address', 'pool_total_liquidity_usd']
    };

    const sections = {};
    for (const [name, fields] of Object.entries(sectionFields)) {
        const present = fields.filter(field => {
            if (field === 'socials') return data.socials && Object.keys(data.socials).length > 0;
            return hasValue(data[field]);
        });
        const missing = fields.filter(field => !present.includes(field));
        sections[name] = {
            status: missing.length === 0 ? 'COMPLETE' : present.length > 0 ? 'PARTIAL' : 'MISSING',
            present_fields: present,
            missing_fields: missing
        };
    }

    const coreMissing = [
        ...sections.identity.missing_fields,
        ...sections.market.missing_fields,
        ...sections.holders.missing_fields
    ];
    const status = sections.identity.status !== 'COMPLETE'
        ? 'FAILED_IDENTITY'
        : coreMissing.length > 0 ? 'PARTIAL' : 'COMPLETE';

    return {
        status,
        core_missing_fields: Array.from(new Set(coreMissing)),
        sections,
        note: data.chain === 'solana'
            ? 'Pool telemetry is descriptive only for pump.fun tokens and is not a contract-risk verdict.'
            : 'Pool telemetry is descriptive market context and is not a contract-risk verdict.'
    };
}

function finalizeTokenPageData(data, { expectedIdentity, expectedMint, chain = 'solana', sourceUrl, scrapedAt } = {}) {
    const requested = expectedIdentity
        ? normalizeCoinReference(expectedIdentity, { defaultChain: chain })
        : expectedMint
            ? normalizeCoinReference(expectedMint, { defaultChain: 'solana' })
            : null;
    const renderedAddress = data?.address || data?.mint;
    const renderedChain = requested?.chain || data?.chain || chain;
    if (!renderedAddress) throw new Error('GMGN token identity did not render');

    let rendered;
    try {
        rendered = createCoinIdentity(renderedChain, renderedAddress, {
            addressOriginal: data.address_original || renderedAddress
        });
    } catch (error) {
        throw new Error(`GMGN rendered invalid ${renderedChain} identity: ${error.message}`);
    }
    if (requested && rendered.coin_id !== requested.coin_id) {
        const noun = requested.chain === 'solana' ? 'mint' : 'address';
        throw new Error(`GMGN ${noun} mismatch: requested ${requested.address}, rendered ${rendered.address}`);
    }

    const finalized = {
        ...data,
        ...rendered,
        source_provider: 'GMGN',
        schema_version: GMGN_FALLBACK_SCHEMA_VERSION,
        scraped_at: scrapedAt || new Date().toISOString(),
        source_url: sourceUrl || TOKEN_PAGE_URL(rendered)
    };
    const nativeAsset = rendered.native_asset;
    if (!hasValue(finalized.total_fees_native)) {
        finalized.total_fees_native = nativeAsset === 'SOL'
            ? finalized.total_fees_sol
            : finalized.total_fees_eth;
    }
    finalized.total_fees_unit = hasValue(finalized.total_fees_native) ? nativeAsset : null;
    if (nativeAsset === 'SOL') finalized.total_fees_sol = finalized.total_fees_native;
    if (nativeAsset === 'ETH') finalized.total_fees_eth = finalized.total_fees_native;
    if (!hasValue(finalized.pool_total_liquidity_native)) {
        finalized.pool_total_liquidity_native = nativeAsset === 'SOL'
            ? finalized.pool_total_liquidity_sol
            : finalized.pool_total_liquidity_eth;
    }
    if (nativeAsset === 'SOL') finalized.pool_total_liquidity_sol = finalized.pool_total_liquidity_native;
    if (nativeAsset === 'ETH') finalized.pool_total_liquidity_eth = finalized.pool_total_liquidity_native;
    finalized.coverage = assessTokenPageCoverage(finalized);
    return finalized;
}

/**
 * Organized, source-labelled view used by model tools and future run storage.
 * It does not decide provider precedence and therefore cannot silently replace
 * the primary holder/bundler backend.
 */
function buildGmgnFallbackSnapshot(result = {}) {
    if (!result.ok) {
        let requested = null;
        try {
            requested = normalizeCoinReference(result.coin_id || result.address || result.mint, {
                defaultChain: result.chain || (result.mint ? 'solana' : undefined)
            });
        } catch (_) {}
        return {
            ok: false,
            provider: 'GMGN',
            schema_version: GMGN_FALLBACK_SCHEMA_VERSION,
            coin_id: requested?.coin_id || result.coin_id || null,
            chain: requested?.chain || result.chain || null,
            address: requested?.address || result.address || result.mint || null,
            mint: requested?.mint || result.mint || null,
            error: result.error || 'GMGN scrape failed',
            provenance: {
                source_url: result.source_url || (requested ? TOKEN_PAGE_URL(requested) : null),
                fetched_at: result.scraped_at || new Date().toISOString(),
                requested_coin_id: requested?.coin_id || null,
                rendered_coin_id: null,
                coverage: {
                    status: 'FAILED',
                    core_missing_fields: ['identity', 'market', 'holders'],
                    sections: {}
                }
            },
            fallback_policy: {
                mode: 'COLLECT_ONLY',
                provider_precedence: 'NOT_YET_APPROVED'
            }
        };
    }

    const feeToMcNative = hasValue(result.total_fees_native) && result.market_cap_usd > 0
        ? (result.total_fees_native * 10_000) / result.market_cap_usd
        : null;
    const feeToMcSolEquivalent = result.chain === 'solana' ? feeToMcNative : null;

    return {
        ok: true,
        provider: 'GMGN',
        schema_version: result.schema_version || GMGN_FALLBACK_SCHEMA_VERSION,
        coin_id: result.coin_id,
        chain: result.chain,
        address: result.address,
        native_asset: result.native_asset,
        mint: result.mint || null,
        provenance: {
            source_url: result.source_url || null,
            fetched_at: result.scraped_at || null,
            rendered_coin_id: result.coin_id || null,
            rendered_address: result.address || null,
            coverage: result.coverage || assessTokenPageCoverage(result)
        },
        fallback_policy: {
            mode: 'COLLECT_ONLY',
            provider_precedence: 'NOT_YET_APPROVED',
            warning: 'Do not silently merge conflicting GMGN and primary-provider values.'
        },
        identity: {
            coin_id: result.coin_id,
            chain: result.chain,
            address: result.address,
            mint: result.mint || null,
            symbol: result.symbol,
            name: result.name || null,
            launchpad: result.launchpad || null,
            launchpad_url: result.launchpad_url || null,
            token_created_at_text: result.token_created_at_text,
            pool_created_at_text: result.pool_created_at_text
        },
        market: {
            market_cap_usd: result.market_cap_usd,
            market_cap_text: result.market_cap_text,
            price_usd: result.price_usd,
            price_text: result.price_text,
            liquidity_usd: result.liquidity_usd,
            liquidity_text: result.liquidity_text,
            volume_24h_usd: result.volume_24h_usd,
            volume_24h_text: result.volume_24h_text,
            total_fees_native: result.total_fees_native,
            total_fees_unit: result.total_fees_unit,
            total_fees_sol: result.chain === 'solana' ? result.total_fees_native : null,
            total_fees_eth: result.chain === 'robinhood' ? result.total_fees_native : null,
            total_fees_text: result.total_fees_text,
            fee_to_mc_native_per_10k_usd: feeToMcNative,
            fee_to_mc_sol_per_10k_usd: feeToMcSolEquivalent,
            fee_to_mc_sol_equivalent_per_10k_usd: feeToMcSolEquivalent,
            fee_to_mc_comparison_status: result.chain === 'robinhood'
                ? 'REQUIRES_FRESH_ETH_USD_AND_SOL_USD'
                : 'AVAILABLE',
            fee_to_mc_reference_sol_equivalent_per_10k_usd: 1,
            total_supply: result.total_supply,
            taxes_text: result.taxes_text,
            taxes_pct: result.taxes_pct,
            total_tax_text: result.total_tax_text,
            total_tax_pct: result.total_tax_pct,
            buy_tax_text: result.buy_tax_text,
            buy_tax_pct: result.buy_tax_pct,
            sell_tax_text: result.sell_tax_text,
            sell_tax_pct: result.sell_tax_pct,
            ath_market_cap_text: result.ath_market_cap_text,
            ath_market_cap_usd: result.ath_market_cap_usd,
            price_change_pct: {
                m1: result.price_change_1m,
                m5: result.price_change_5m,
                h1: result.price_change_1h,
                h24: result.price_change_24h
            }
        },
        holder_risk: {
            holders_count: result.holders_count,
            top10_concentration_pct: result.top10_concentration_pct,
            snipers: { percentage: result.snipers_pct, gmgn_flag: result.snipers_flag },
            insiders: { percentage: result.insiders_pct, gmgn_flag: result.insiders_flag },
            phishing: { percentage: result.phishing_pct, gmgn_flag: result.phishing_flag },
            bundler: {
                percentage: result.bundler_pct_gmgn,
                gmgn_flag: result.bundler_flag,
                groups: null,
                coverage_note: 'The base token page exposes a summary percentage, not wallet-level bundle groups.'
            },
            dev_holding: { percentage: result.dev_holding_pct, gmgn_flag: result.dev_holding_flag }
        },
        audit_telemetry: {
            rug_percent: result.rug_percent,
            nomint_passed: result.nomint_passed,
            no_blacklist_passed: result.no_blacklist_passed,
            burnt_pct: result.burnt_pct,
            burnt_text: result.burnt_text,
            dex_paid_text: result.dex_paid_text,
            usage_note: result.chain === 'solana'
                ? 'Pump.fun mint/freeze and LP mechanics are trusted platform properties, not primary decision signals.'
                : 'Robinhood audit fields are GMGN observations; missing values remain unknown and are not treated as zero.'
        },
        pool_telemetry: {
            usage: 'DESCRIPTIVE_ONLY',
            pair_text: result.pair_text,
            amm_address: result.pool_amm_address,
            total_liquidity_usd: result.pool_total_liquidity_usd,
            total_liquidity_native: result.pool_total_liquidity_native,
            total_liquidity_unit: result.native_asset || null,
            total_liquidity_sol: result.chain === 'solana' ? result.pool_total_liquidity_native : null,
            total_liquidity_eth: result.chain === 'robinhood' ? result.pool_total_liquidity_native : null,
            total_liquidity_text: result.pool_total_liquidity_text,
            lock_state: result.pool_lock_state,
            assets: result.pool_assets || []
        },
        developer: {
            wallet: result.dev_wallet,
            wallet_short: result.dev_wallet_short,
            native_balance: result.dev_native_balance,
            native_balance_unit: result.native_asset || null,
            sol_balance: result.chain === 'solana' ? result.dev_native_balance : null,
            eth_balance: result.chain === 'robinhood' ? result.dev_native_balance : null,
            holding_pct: result.dev_holding_pct,
            funding_source: result.dev_funding_source,
            funding_source_short: result.dev_funding_source_short,
            funding_native: result.dev_funding_native,
            funding_unit: result.native_asset || null,
            funding_sol: result.chain === 'solana' ? result.dev_funding_native : null,
            funding_eth: result.chain === 'robinhood' ? result.dev_funding_native : null,
            funding_age: result.dev_funding_age,
            funding_transaction: result.dev_funding_transaction,
            token_count: result.dev_token_count,
            history: result.dev_history || null
        },
        socials: result.socials || {},
        token_tags: result.token_tags || [],
        avatar_reused_tokens: result.avatar_reused_tokens || []
    };
}

// ============================================================
// PAGE LIFECYCLE
// ============================================================

async function withPage(opts, fn) {
    if (opts && opts.page) {
        // Caller-supplied persistent page. Caller owns lifecycle.
        return await fn(opts.page);
    }
    const browser = await chromium.launch({
        headless: true,
        args: [
            '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
            '--disable-gpu', '--disable-extensions', '--disable-background-networking',
            '--disable-default-apps', '--no-first-run'
        ]
    });
    try {
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            viewport: { width: 1920, height: 1080 }
        });
        context.setDefaultTimeout(NAV_TIMEOUT_MS);
        const page = await context.newPage();
        return await fn(page);
    } finally {
        await browser.close().catch(() => {});
    }
}

/**
 * Navigate the page to the token URL, wait for key anchors, dismiss the
 * GMGN popup. Returns once the page is ready for extraction.
 */
async function navigateToTokenPage(page, tokenReference, opts = {}) {
    const identity = normalizeCoinReference(tokenReference, { defaultChain: opts.chain });
    await page.goto(TOKEN_PAGE_URL(identity), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

    // Wait for the exact mint, not merely any token header. A persistent React
    // page can briefly retain the prior token's DOM during navigation; treating
    // that stale header as ready would attach another coin's data to this mint.
    await page.waitForFunction(
        ({ expectedAddress, evm }) => {
            const rendered = document.querySelector('#token-base-address')?.getAttribute('data-addr');
            if (!rendered) return false;
            return evm
                ? rendered.toLowerCase() === expectedAddress.toLowerCase()
                : rendered === expectedAddress;
        },
        { expectedAddress: identity.address, evm: identity.address_kind === 'EVM' },
        { timeout: NAV_TIMEOUT_MS }
    );
    await page.waitForSelector('[data-sentry-component="BaseInfoBar"]', { timeout: NAV_TIMEOUT_MS });

    // Dismiss any modal overlay with Escape — same approach as the persistent
    // trending browser (preserves React portal state, avoids DOM mutation).
    await page.keyboard.press('Escape').catch(() => {});
    // Stop waiting as soon as actual market/holder fields have rendered,
    // rather than sleeping on every already-ready page. The same coverage
    // validator still rejects missing/incorrect data after the bounded wait.
    const readyDeadline = Date.now() + SETTLE_MS;
    while (Date.now() < readyDeadline) {
        const data = await extractTokenPageData(page, { chain: identity.chain });
        if (assessTokenPageCoverage(data).status === 'COMPLETE') break;
        await delay(150);
    }
    await page.keyboard.press('Escape').catch(() => {});
    return identity;
}

// ============================================================
// SCRAPER
// ============================================================

/**
 * Extract every visible token-page field from an already-navigated page.
 * Exposed separately from scrapeTokenPage so the persistent-page manager
 * (token-page-manager.js) can run this every 60s on a page that stays
 * open between calls — zero navigation overhead per extract.
 *
 * The page must already be sitting on https://gmgn.ai/sol/token/<mint> with
 * the popup dismissed. Use navigateToTokenPage() (or the manager's open())
 * to get into that state first.
 */
async function extractTokenPageData(page, opts = {}) {
    const chain = opts.chain || 'solana';
    const config = getChainConfig(chain);
    return await page.evaluate(({ chainId, gmgnChain, nativeAsset }) => {
                const text = (el) => el ? el.textContent.trim() : null;
                const numFromText = (s) => {
                    if (!s) return null;
                    // Handle K/M/B suffix, dollar sign, commas, percent sign.
                    const clean = String(s).replace(/[$,%\s]/g, '');
                    // GMGN compresses very small prices using a subscript zero
                    // count: 0.0₃112 means 0.000112. Preserve the raw text but
                    // also normalize it so price_usd is not silently null.
                    const subscript = clean.match(/^([+-]?\d+)\.0([₀₁₂₃₄₅₆₇₈₉]+)(\d+)$/);
                    if (subscript) {
                        const digits = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9' };
                        const zeroCount = parseInt(Array.from(subscript[2]).map(ch => digits[ch]).join(''), 10);
                        if (Number.isFinite(zeroCount)) {
                            return parseFloat(`${subscript[1]}.${'0'.repeat(zeroCount)}${subscript[3]}`);
                        }
                    }
                    const m = clean.match(/^([+-]?\d*\.?\d+)([KMB])?$/i);
                    if (!m) return null;
                    const n = parseFloat(m[1]);
                    const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
                    return n * mult;
                };
                const pctFromText = (s) => {
                    if (!s) return null;
                    const m = String(s).match(/([+-]?[\d.]+)\s*%/);
                    return m ? parseFloat(m[1]) : null;
                };

                // ---- IDS (stable anchors) -------------------------------
                const mintEl = document.querySelector('#token-base-address');
                const symEl  = document.querySelector('#token-base-symbol');
                const mintAddr = mintEl?.getAttribute('data-addr') || null;
                const symbol   = symEl?.getAttribute('data-symbol') || text(symEl) || null;
                const symbolRow = symEl?.parentElement?.parentElement;
                const tokenName = text(symbolRow?.children?.[1]) || null;

                // ---- Helpers for the InfoItem / PoolItem patterns -------
                // InfoItem: <div><span class="info-item-title">LABEL</span><div class="info-item-value">VALUE</div></div>
                // PoolItem: <div data-sentry-component="PoolItem"><div>LABEL</div><div>VALUE</div></div>
                const findInfoItem = (root, label) => {
                    if (!root) return null;
                    const titles = Array.from(root.querySelectorAll('.info-item-title')).filter(t => t.textContent.trim() === label);
                    if (titles.length !== 1) return null;
                    // GMGN's November 2026 DOM keeps title/value classes but no longer
                    // marks each wrapper as InfoItem. Never cross the supplied section
                    // or select a value shared by multiple labels.
                    for (let owner = titles[0].parentElement; owner && root.contains(owner); owner = owner.parentElement) {
                        const values = owner.querySelectorAll('.info-item-value');
                        if (values.length) return values.length === 1 && owner.querySelectorAll('.info-item-title').length === 1
                            ? values[0].textContent.trim() : null;
                        if (owner === root) break;
                    }
                    return null;
                };
                const findPoolItem = (root, label) => {
                    if (!root) return null;
                    const items = root.querySelectorAll('[data-sentry-component="PoolItem"]');
                    for (const it of items) {
                        const divs = it.querySelectorAll('div');
                        if (divs[0] && divs[0].textContent.trim() === label) {
                            // The value div is the next sibling at the same level,
                            // identified by font-medium class. Fall back to last text.
                            const labelDiv = divs[0];
                            const valueDiv = labelDiv.parentElement?.querySelector('.font-medium')
                                          || labelDiv.nextElementSibling;
                            return valueDiv ? valueDiv.textContent.trim() : null;
                        }
                    }
                    return null;
                };

                // ---- Top bar (BaseInfoBar) — Price / Liq / 24h Vol ------
                const bar = document.querySelector('[data-sentry-component="BaseInfoBar"]');
                const priceText = findInfoItem(bar, 'Price');
                const liqText   = findInfoItem(bar, 'Liq');
                const vol24Text = findInfoItem(bar, '24h Vol');
                const totalFeesText = findInfoItem(bar, 'Total Fees');
                const topBarSupplyText = findInfoItem(bar, 'Total supply');
                const taxesText = findInfoItem(bar, 'Taxes');
                const totalTaxText = findInfoItem(bar, 'Total Tax');
                const buyTaxText = findInfoItem(bar, 'Buy Tax');
                const sellTaxText = findInfoItem(bar, 'Sell Tax');
                const launchpadLink = bar?.querySelector([
                    'a[href*="pump.fun/coin/"]',
                    'a[href*="bonk.fun/token/"]',
                    'a[href*="moonshot.money/"]',
                    'a[href*="long.xyz/"]',
                    'a[href*="pons.fun/"]',
                    'a[href*="bankr.bot/"]',
                    'a[href*="clanker.world/"]'
                ].join(', '));
                const launchpadHref = launchpadLink?.getAttribute('href') || '';
                const launchpad = launchpadHref.includes('pump.fun') ? 'pump.fun'
                    : launchpadHref.includes('bonk.fun') ? 'bonk.fun'
                    : launchpadHref.includes('moonshot.money') ? 'moonshot'
                    : launchpadHref.includes('long.xyz') ? 'long.xyz'
                    : launchpadHref.includes('pons.fun') ? 'pons.fun'
                    : launchpadHref.includes('bankr.bot') ? 'bankr'
                    : launchpadHref.includes('clanker.world') ? 'clanker'
                    : launchpadHref ? (() => {
                        try { return new URL(launchpadHref, location.href).hostname.replace(/^www\./, ''); }
                        catch (_) { return 'unknown'; }
                    })()
                    : null;
                // The BaseInfoPriceView's first InfoItem renders the MC headline
                // as the value of an unlabeled InfoItem — pull it directly.
                const headlineMcEl = document.querySelector(
                    '[data-sentry-component="BaseInfoPriceView"] [data-sentry-component="InfoItem"] .info-item-value'
                );
                const headlineMcText = headlineMcEl ? headlineMcEl.textContent.trim() : null;

                // ---- BasicInfo block (Market cap / Holders / Total supply / Pair / Token created / Pool created)
                const basic = document.querySelector('[data-sentry-component="BasicInfo"]');
                const marketCapText     = findPoolItem(basic, 'Market cap');
                const holdersText       = findPoolItem(basic, 'Holders');
                const totalSupplyText   = findPoolItem(basic, 'Total supply');
                const pairText          = findPoolItem(basic, 'Pair');
                const tokenCreatedText  = findPoolItem(basic, 'Token created');
                const poolCreatedText   = findPoolItem(basic, 'Pool created');
                const athMcText         = findPoolItem(basic, 'ATH MC')
                    || findPoolItem(basic, 'ATH')
                    || findInfoItem(bar, 'ATH MC')
                    || findInfoItem(bar, 'ATH');

                // ---- BaseInfoCard (Top 10 concentration) ----------------
                const baseCard = document.querySelector('[data-sentry-component="BaseInfoCard"]');
                const top10Text = findInfoItem(baseCard, 'Top 10');
                // Rug %: also an InfoItem, but the value div nests a red span — pull the matching span
                let rugPercentText = findInfoItem(baseCard, 'Rug %');
                if (!rugPercentText) {
                    // Fall back to the AuditRug component which renders the same number
                    const auditEl = document.querySelector('[data-sentry-component="AuditRug"] span span');
                    rugPercentText = auditEl ? auditEl.textContent.trim() : null;
                }

                // ---- AUDIT PANEL (Snipers / Insiders / Phishing / Bundler /
                //                   DEV / Dex Paid / NoMint / No Blacklist / Burnt)
                //
                // Two render patterns mixed in the audit panel:
                //   (a) holderTrendChartSub  — uses `.item-title` + `.item-value` (no
                //       `info-` prefix). Carries the % fields (Snipers, Insiders,
                //       Phishing, Bundler).
                //   (b) InfoItem            — uses `.info-item-title` + `.info-item-value`.
                //       Carries boolean flags (NoMint, No Blacklist) where the value
                //       is just a green check / red X icon, plus mixed-content fields
                //       (DEV, Dex Paid, Burnt) where the value is text or text+icon.
                //
                // For boolean icon fields we read the pass/fail signal from the
                // value div's class list: `!text-increase` (green = pass / safe) vs
                // `!text-decrease` (red = fail / risk). Returns true/false/null.

                const findHolderTrendItem = (label) => {
                    // Audit-panel fields use one of two component shapes (verified
                    // 2026-05-23 — GMGN restructures these periodically):
                    //   (a) holderTrendChartSub → .item-title + .item-value
                    //       (Insiders, Phishing, Bundler)
                    //   (b) CommonItemView      → .item-title-cn + .value-node-item
                    //       (Snipers, and likely future moves)
                    // Try both class conventions; first match wins. Avoids
                    // re-breaking on the next GMGN reshuffle.
                    const probes = [
                        { root: '[data-sentry-component="holderTrendChartSub"]', titleCls: '.item-title',    valueCls: '.item-value' },
                        { root: '[data-sentry-component="CommonItemView"]',      titleCls: '.item-title-cn', valueCls: '.value-node-item' }
                    ];
                    for (const probe of probes) {
                        const subs = document.querySelectorAll(probe.root);
                        for (const sub of subs) {
                            const t = sub.querySelector(probe.titleCls);
                            if (!t || t.textContent.trim() !== label) continue;
                            const v = sub.querySelector(probe.valueCls);
                            if (!v) return { text: null, color: null };
                            const cls = v.className || '';
                            const color = cls.includes('text-red')     ? 'red'
                                       : cls.includes('text-decrease') ? 'red'
                                       : cls.includes('text-green')    ? 'green'
                                       : cls.includes('text-increase') ? 'green'
                                       : null;
                            return { text: v.textContent.trim() || null, color };
                        }
                    }
                    return { text: null, color: null };
                };

                // InfoItem flag — returns true (passed/safe), false (failed/risk), or null
                const findInfoFlag = (label) => {
                    const items = document.querySelectorAll('[data-sentry-component="InfoItem"]');
                    for (const it of items) {
                        const titleEl = it.querySelector('.info-item-title');
                        if (!titleEl) continue;
                        // Title may be wrapped in a nested span — use textContent
                        if (titleEl.textContent.trim() !== label) continue;
                        const valEl = it.querySelector('.info-item-value');
                        if (!valEl) return null;
                        const cls = valEl.className || '';
                        if (cls.includes('text-increase') || cls.includes('text-green')) return true;
                        if (cls.includes('text-decrease') || cls.includes('text-red'))   return false;
                        // No color hint → fall back to text presence
                        const txt = valEl.textContent.trim();
                        if (!txt) return null;
                        return txt;
                    }
                    return null;
                };

                // InfoItem text — for fields where the value is plain text
                // (Burnt: "🔥 100%", Dex Paid: "$398 CTO", DEV: "0%" or icon)
                const findInfoText = (label) => {
                    const items = document.querySelectorAll('[data-sentry-component="InfoItem"]');
                    for (const it of items) {
                        const titleEl = it.querySelector('.info-item-title');
                        if (!titleEl || titleEl.textContent.trim() !== label) continue;
                        const valEl = it.querySelector('.info-item-value');
                        return valEl ? valEl.textContent.trim() : null;
                    }
                    return null;
                };

                // % fields (holderTrendChartSub)
                const snipers   = findHolderTrendItem('Snipers');
                const insiders  = findHolderTrendItem('Insiders');
                const phishing  = findHolderTrendItem('Phishing');
                const bundlerHT = findHolderTrendItem('Bundler');

                // DEV field — shown as icon when 0% (the audit "InfoItem" wraps
                // the label in nested <span>, so textContent strip is needed).
                // Try text first (when dev holds >0%, it shows the percentage);
                // fall back to flag interpretation if no text was rendered.
                const devText = findInfoText('DEV');
                const devFlag = findInfoFlag('DEV');

                // Burnt / Dex Paid — text content
                const burntText   = findInfoText('Burnt');
                const dexPaidText = findInfoText('Dex Paid');

                // Boolean safety flags
                const nomintPassed     = findInfoFlag('NoMint');
                const noBlacklistPassed = findInfoFlag('No Blacklist');

                // ---- PriceInfo block (1m / 5m / 1h / 24h tabs) ----------
                // Structure: <FilterGroup><div>1m</div><span>1m</span><span>+25%</span>...
                // Each tab is a div containing two spans (label, value).
                const priceTabs = {};
                const priceTabContainer = document.querySelector('[data-sentry-component="PriceInfo"] [data-sentry-component="FilterGroup"]');
                if (priceTabContainer) {
                    const tabDivs = priceTabContainer.querySelectorAll('div.flex.flex-col');
                    for (const t of tabDivs) {
                        const spans = t.querySelectorAll('span');
                        if (spans.length >= 2) {
                            const label = spans[0].textContent.trim().toLowerCase();
                            const valueSpan = spans[1];
                            const value = pctFromText(valueSpan.textContent.trim());
                            const styleColor = valueSpan.getAttribute('style') || '';
                            // Positive = green-ish RGB; negative = red-ish. Color hint helps disambiguate.
                            priceTabs[label] = { value, color: styleColor };
                        }
                    }
                }

                // ---- DevInfo block — wallet, balance, funding source ----
                const dev = document.querySelector('[data-sentry-component="DevInfo"]');
                let devWallet = null, devWalletShort = null, devNativeBalance = null;
                let devFundingSource = null, devFundingSourceShort = null;
                let devFundingNative = null, devFundingAge = null, devFundingTransaction = null;
                if (dev) {
                    const devLink = dev.querySelector(`a[href^="/${gmgnChain}/address/"]`);
                    if (devLink) {
                        devWallet = devLink.getAttribute('href').replace(`/${gmgnChain}/address/`, '').split(/[?#]/)[0];
                        const inner = devLink.textContent.trim();
                        devWalletShort = inner.split('(')[0].trim();
                        const escapedNative = nativeAsset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        const balMatch = inner.match(new RegExp(`\\(([\\d,.]+)\\s*${escapedNative}\\)`, 'i'));
                        devNativeBalance = balMatch ? numFromText(balMatch[1]) : null;
                    }
                    const fundSource = dev.querySelector('[data-sentry-component="DevFundsSource"]');
                    const fundEl = fundSource?.querySelector('a[href*="/address/"], a[href*="/account/"]');
                    if (fundEl) {
                        devFundingSource = fundEl.getAttribute('href').replace(/^.*\/(?:account|address)\//, '').split(/[?#]/)[0];
                        devFundingSourceShort = text(fundEl);
                    }
                    const fundingAmountEl = Array.from(fundSource?.querySelectorAll('span') || [])
                        .find(el => new RegExp(`(?:^|\\s)[\\d,.]+\\s*${nativeAsset}(?:\\s|$)`, 'i').test(text(el) || ''))
                        || fundSource?.querySelector('[data-icon*="bal" i]')?.parentElement;
                    if (fundingAmountEl) devFundingNative = numFromText((text(fundingAmountEl) || '').replace(nativeAsset, ''));
                    const fundingAgeLink = fundSource?.querySelector('a[href*="/tx/"]');
                    if (fundingAgeLink) {
                        devFundingAge = text(fundingAgeLink);
                        devFundingTransaction = (fundingAgeLink.getAttribute('href') || '')
                            .replace(/^.*\/tx\//, '').split(/[?#]/)[0] || null;
                    }
                }

                // Dev token count: lives in the "Dev Token N" tab label.
                let devTokenCount = null;
                const devTab = document.querySelector('#rc-tabs-0-tab-dev_token span');
                if (devTab) {
                    const m = devTab.textContent.trim().match(/Dev Token\s+([\d,]+)/i);
                    if (m) devTokenCount = parseInt(m[1].replace(/,/g, ''), 10);
                }

                // ---- PoolInfo — descriptive market telemetry ------------
                const poolInfo = document.querySelector('[data-sentry-component="PoolInfo"]');
                const poolLink = poolInfo?.querySelector('[data-sentry-component="PoolLink"]');
                const poolAmmAddress = poolLink ? (poolLink.getAttribute('href') || '').replace(/^.*\/(?:account|address)\//, '').split(/[?#]/)[0] : null;
                const poolTotalLiquidityText = findPoolItem(poolInfo, 'Total liq');
                const poolUsdMatch = poolTotalLiquidityText?.match(/(\$[\d,.]+[KMB]?)/i);
                const escapedNative = nativeAsset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const poolNativeMatch = poolTotalLiquidityText?.match(new RegExp(`\\(([\\d,.]+)\\s*${escapedNative}\\)`, 'i'));
                const poolTotalLiquidityUsd = poolUsdMatch ? numFromText(poolUsdMatch[1]) : null;
                const poolTotalLiquidityNative = poolNativeMatch ? numFromText(poolNativeMatch[1]) : null;
                const locked = poolInfo?.querySelector('[data-sentry-component="Locked"]');
                const lockIcon = locked?.querySelector('[data-icon]')?.getAttribute('data-icon') || '';
                const poolLockState = /unlock/i.test(lockIcon) ? 'UNLOCKED' : /lock/i.test(lockIcon) ? 'LOCKED' : null;

                const poolAssets = [];
                const pairInfo = poolInfo?.querySelector('[data-sentry-component="PairInfo"]');
                if (pairInfo) {
                    const cells = Array.from(pairInfo.children);
                    // First three direct children are the Pair/Liq-Initial/Value headings.
                    for (let i = 3; i + 2 < cells.length; i += 3) {
                        const asset = text(cells[i]);
                        const liquidityInitialText = text(cells[i + 1]);
                        const valueText = text(cells[i + 2]);
                        if (!asset) continue;
                        const amountParts = liquidityInitialText?.match(/^([^/]+)\/\s*([^()]+)(?:\(([^)]+)\))?/);
                        poolAssets.push({
                            asset,
                            liquidity_initial_text: liquidityInitialText,
                            current_amount: amountParts ? numFromText(amountParts[1]) : null,
                            initial_amount: amountParts ? numFromText(amountParts[2]) : null,
                            gmgn_annotation_text: amountParts?.[3] || null,
                            value_text: valueText,
                            value_usd: numFromText(valueText)
                        });
                    }
                }

                // ---- BaseLinkView — socials -----------------------------
                // Twitter, Telegram, Website are all <a> with aria-label.
                const socialAnchors = document.querySelectorAll('[data-sentry-component="BaseLinkView"] a[aria-label]');
                const socials = {};
                for (const a of socialAnchors) {
                    const label = (a.getAttribute('aria-label') || '').toLowerCase();
                    const href = a.getAttribute('href');
                    if (label && href && !socials[label]) socials[label] = href;
                }

                // ---- TokenTags — visible tag list -----------------------
                const tagsEl = document.querySelector('[data-sentry-component="TokenTags"]');
                const tagLabels = tagsEl
                    ? Array.from(tagsEl.querySelectorAll('span, div')).map(el => el.textContent.trim()).filter(Boolean)
                    : [];
                // Dedup + keep only short tag-like strings (filter out giant svg/text noise)
                const tokenTags = Array.from(new Set(tagLabels)).filter(t => t.length > 0 && t.length < 40);

                // Same-name tokens skipped — the GMGN section is buggy and
                // routinely surfaces unrelated tokens that share zero name
                // similarity. Avatar-reused tokens kept since the same data
                // path also drives it and it's been more reliable in practice.
                const allCards = document.querySelectorAll('[data-sentry-component="SimilarTokenCard"]');
                const avatarReusedTokens = [];
                for (const card of allCards) {
                    const listRoot = card.closest('[data-sentry-component="AvatarReuseTokens"]');
                    if (!listRoot) continue; // ignore SimilarTokenList (same-name section)
                    const href = card.getAttribute('href') || '';
                    const addressMatch = href.match(new RegExp(`/${gmgnChain}/token/([^/?#]+)`));
                    avatarReusedTokens.push({
                        address: addressMatch ? addressMatch[1] : null,
                        mint: chainId === 'solana' && addressMatch ? addressMatch[1] : null,
                        href,
                        text: card.textContent.replace(/\s+/g, ' ').trim().slice(0, 200)
                    });
                    if (avatarReusedTokens.length >= 20) break;
                }

                return {
                    chain: chainId,
                    address: mintAddr,
                    address_original: mintAddr,
                    mint: chainId === 'solana' ? mintAddr : null,
                    symbol,
                    name: tokenName,
                    launchpad,
                    launchpad_url: launchpadHref || null,
                    headline_mc_text: headlineMcText,

                    // Numeric fields
                    market_cap_usd:   numFromText(marketCapText || headlineMcText),
                    market_cap_text:  marketCapText || headlineMcText,
                    price_usd:        numFromText(priceText),
                    price_text:       priceText,
                    liquidity_usd:    numFromText(liqText),
                    liquidity_text:   liqText,
                    volume_24h_usd:   numFromText(vol24Text),
                    volume_24h_text:  vol24Text,
                    holders_count:    numFromText(holdersText),
                    total_supply:     numFromText(topBarSupplyText || totalSupplyText),
                    total_fees_native: numFromText(totalFeesText),
                    total_fees_sol:   chainId === 'solana' ? numFromText(totalFeesText) : null,
                    total_fees_eth:   chainId === 'robinhood' ? numFromText(totalFeesText) : null,
                    total_fees_text:  totalFeesText,
                    total_fees_unit:  totalFeesText ? nativeAsset : null,
                    taxes_text:       taxesText,
                    taxes_pct:        pctFromText(taxesText),
                    total_tax_text:   totalTaxText,
                    total_tax_pct:    pctFromText(totalTaxText),
                    buy_tax_text:     buyTaxText,
                    buy_tax_pct:      pctFromText(buyTaxText),
                    sell_tax_text:    sellTaxText,
                    sell_tax_pct:     pctFromText(sellTaxText),
                    ath_market_cap_text: athMcText,
                    ath_market_cap_usd: numFromText(athMcText),
                    top10_concentration_pct: pctFromText(top10Text),
                    rug_percent:      pctFromText(rugPercentText),

                    // ---- AUDIT PANEL (new) ----
                    // % fields — also include the color hint ("red"/"green"/null)
                    // so the AI knows when GMGN flagged something as risky vs safe.
                    snipers_pct:      pctFromText(snipers.text),
                    snipers_flag:     snipers.color,
                    insiders_pct:     pctFromText(insiders.text),
                    insiders_flag:    insiders.color,
                    phishing_pct:     pctFromText(phishing.text),
                    phishing_flag:    phishing.color,        // red here = HARD safety blocker
                    bundler_pct_gmgn: pctFromText(bundlerHT.text),
                    bundler_flag:     bundlerHT.color,

                    // DEV %: numeric when present, otherwise a boolean flag
                    // (true = dev holds 0% / passed, false = dev holds risky %)
                    dev_holding_pct:  pctFromText(devText),
                    dev_holding_flag: pctFromText(devText) === 0 ? 'safe'
                                    : devFlag === true ? 'safe'
                                    : devFlag === false ? 'risky'
                                    : null,

                    // Booleans (true = passed safety check, false = failed, null = unknown)
                    nomint_passed:        typeof nomintPassed === 'boolean' ? nomintPassed : null,
                    no_blacklist_passed:  typeof noBlacklistPassed === 'boolean' ? noBlacklistPassed : null,

                    // Mixed text fields
                    burnt_text:       burntText,             // e.g. "🔥 100%"
                    burnt_pct:        pctFromText(burntText),
                    dex_paid_text:    dexPaidText,           // e.g. "$398 CTO" — text is the signal, not the parse

                    // Price changes (% values)
                    price_change_1m:  priceTabs['1m']  ? priceTabs['1m'].value  : null,
                    price_change_5m:  priceTabs['5m']  ? priceTabs['5m'].value  : null,
                    price_change_1h:  priceTabs['1h']  ? priceTabs['1h'].value  : null,
                    price_change_24h: priceTabs['24h'] ? priceTabs['24h'].value : null,

                    // Timestamps (kept as the original text — GMGN's format is locale-dependent)
                    token_created_at_text: tokenCreatedText,
                    pool_created_at_text:  poolCreatedText,
                    pair_text:             pairText,
                    pool_amm_address:      poolAmmAddress,
                    pool_total_liquidity_text: poolTotalLiquidityText,
                    pool_total_liquidity_usd: poolTotalLiquidityUsd,
                    pool_total_liquidity_native: poolTotalLiquidityNative,
                    pool_total_liquidity_sol: chainId === 'solana' ? poolTotalLiquidityNative : null,
                    pool_total_liquidity_eth: chainId === 'robinhood' ? poolTotalLiquidityNative : null,
                    pool_lock_state:       poolLockState,
                    pool_assets:           poolAssets,

                    // Dev signals
                    dev_wallet:           devWallet,
                    dev_wallet_short:     devWalletShort,
                    dev_native_balance:   devNativeBalance,
                    dev_sol_balance:      chainId === 'solana' ? devNativeBalance : null,
                    dev_eth_balance:      chainId === 'robinhood' ? devNativeBalance : null,
                    dev_funding_source:   devFundingSource,
                    dev_funding_source_short: devFundingSourceShort,
                    dev_funding_native:   devFundingNative,
                    dev_funding_sol:      chainId === 'solana' ? devFundingNative : null,
                    dev_funding_eth:      chainId === 'robinhood' ? devFundingNative : null,
                    dev_funding_age:      devFundingAge,
                    dev_funding_transaction: devFundingTransaction,
                    dev_token_count:      devTokenCount,

                    // Socials (twitter, telegram, website…)
                    socials,

                    // Misc
                    token_tags:           tokenTags,
                    avatar_reused_tokens: avatarReusedTokens
                };
    }, { chainId: config.id, gmgnChain: config.gmgn_namespace, nativeAsset: config.native_asset });
}

/**
 * One-shot scrape: launches a browser (or reuses opts.page), navigates,
 * extracts, returns the structured envelope. Use this for ad-hoc /
 * tool-registry calls; the persistent recal cycle should use
 * TokenPageManager.extract() instead.
 */
async function scrapeTokenPage(tokenReference, opts = {}) {
    let identity;
    try {
        identity = normalizeCoinReference(tokenReference, { defaultChain: opts.chain });
    } catch (error) {
        return { ok: false, error: error.message };
    }
    return withPage(opts, async (page) => {
        try {
            await navigateToTokenPage(page, identity);
            const extracted = await extractTokenPageData(page, { chain: identity.chain });
            // Optional: also click the Dev Token tab and scrape dev history.
            // Costs ~3s; off by default. Pass { includeDevHistory: true } to enable.
            if (opts.includeDevHistory) {
                extracted.dev_history = await extractDevTokenHistory(page, { chain: identity.chain })
                    .catch(e => ({ ok: false, error: e.message }));
            }
            const data = finalizeTokenPageData(extracted, {
                expectedIdentity: identity,
                sourceUrl: page.url(),
                scrapedAt: new Date().toISOString()
            });
            return { ok: true, ...data };
        } catch (e) {
            return {
                ok: false,
                ...identity,
                error: e.message,
                source_url: page.url() || TOKEN_PAGE_URL(identity),
                scraped_at: new Date().toISOString()
            };
        }
    });
}

async function scrapeGmgnFallbackSnapshot(tokenReference, opts = {}) {
    const result = await scrapeTokenPage(tokenReference, opts);
    return buildGmgnFallbackSnapshot(result);
}

// ============================================================
// DEV TOKEN HISTORY — clicks the "Dev Token N" tab and scrapes
// both the per-token table and the right-sidebar Token Stats panel.
//
// This is the alpha cross-check: if a dev who launched a $3M ATH coin
// (e.g. "Epstein") just launched a new one, that's a very different
// signal than a serial 800-token launcher with zero hits.
// ============================================================

/**
 * Click the Dev Token tab on an already-navigated token page, wait for the
 * panel to render, then extract:
 *   - dev_stats: { dev_wallet, dev_sol_balance, funding_source, funding_sol,
 *                  funding_age, total_pairs, migrated, non_migrated,
 *                  migrated_pct, best_token: { name, ath_mc_text },
 *                  last_token_launched_text }
 *   - dev_tokens: [{ name, age, migrated, total_fees, ath_mc_text,
 *                    current_mc_text, liq_text, holders, mint? }, ...]
 *
 * Capped at MAX_DEV_TOKEN_ROWS rows so we don't dump 958 rows into Grok's
 * context on a serial launcher.
 */
const MAX_DEV_TOKEN_ROWS = 25;

async function extractDevTokenHistory(page, opts = {}) {
    const config = getChainConfig(opts.chain || 'solana');
    // Click the Dev Token tab. The id is rc-tabs-0-tab-dev_token; label is
    // "Dev Token <N>". We click the button (not just the inner span) so the
    // rc-tabs router actually switches panels.
    const tabClicked = await page.evaluate(() => {
        const tab = document.querySelector('#rc-tabs-0-tab-dev_token');
        if (!tab) return false;
        tab.click();
        return true;
    });
    if (!tabClicked) {
        return { ok: false, error: 'Dev Token tab not found' };
    }

    // Let the panel render. The first paint shows a skeleton; wait for actual
    // table cells instead of assuming a fixed delay is sufficient.
    await page.waitForSelector('#rc-tabs-0-panel-dev_token tbody tr td', { timeout: 10_000 }).catch(() => {});
    await delay(500);

    return await page.evaluate(({ maxRows, chainId, gmgnChain, nativeAsset }) => {
        const text = (el) => el ? el.textContent.replace(/\s+/g, ' ').trim() : null;
        const numFromText = (s) => {
            if (!s) return null;
            const clean = String(s).replace(/[$,%\s]/g, '');
            const m = clean.match(/^([+-]?\d*\.?\d+)([KMB])?$/i);
            if (!m) return null;
            const n = parseFloat(m[1]);
            const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
            return n * mult;
        };

        // ---- DEV TOKEN ROWS ----
        // The panel renders as a real <table> with <tr> rows and
        // <td> cells. GMGN removed data-sentry-component="TdCell" in its
        // current DOM, so that historical attribute must not be required.
        // Current column order (visually + DOM verified 2026-08-25):
        //   0 name+avatar+mint  1 age  2 migrated-icon  3 total_fees
        //   4 ATH MC            5 current MC  6 Liq  7 holders
        //   8 1h volume         9 bundler percentage
        const panel = document.querySelector('#rc-tabs-0-panel-dev_token');
        const rows = [];
        if (panel) {
            // Skip the header row by filtering to <tr> that contain cells.
            const trs = panel.querySelectorAll('tr');
            const seen = new Set();
            for (const tr of trs) {
                if (rows.length >= maxRows) break;
                const cells = tr.querySelectorAll('td');
                if (cells.length < 8) continue; // header rows or partial rows

                // td[0]: token link + name
                const anchor = cells[0].querySelector(`a[href*="/${gmgnChain}/token/"]`);
                const href   = anchor ? anchor.getAttribute('href') : '';
                const addressMatch = href.match(new RegExp(`/${gmgnChain}/token/([^/?#]+)`));
                const address = addressMatch ? addressMatch[1] : null;
                if (!address || seen.has(address.toLowerCase())) continue;
                seen.add(address.toLowerCase());

                // Inside the anchor: an avatar div followed by the name span.
                const nameSpan = cells[0].querySelector('span.font-medium')
                              || cells[0].querySelector('span:last-of-type');
                const name = text(nameSpan) || text(anchor);

                // td[2]: migrated icon — green check uses text-increase, red ✗ uses text-decrease.
                const migIcon = cells[2];
                const hasIncrease = !!migIcon.querySelector('[class*="text-increase"]');
                const hasDecrease = !!migIcon.querySelector('[class*="text-decrease"]');
                const migrated = hasIncrease && !hasDecrease;

                const ageText = text(cells[1]);
                const feesText = text(cells[3]);
                const athMcText     = text(cells[4]);
                const currentMcText = text(cells[5]);
                const liqText       = text(cells[6]);
                const holdersText   = text(cells[7]);
                const volume1hText  = cells[8] ? text(cells[8]) : null;
                const bundlerText   = cells[9] ? text(cells[9]) : null;

                // Optional trailing columns (8, 9, ...) — varies as the panel scrolls.
                const extras = [];
                for (let i = 8; i < cells.length; i++) extras.push(text(cells[i]));

                rows.push({
                    chain: chainId,
                    address,
                    mint: chainId === 'solana' ? address : null,
                    coin_id: `${chainId}:${chainId === 'robinhood' ? address.toLowerCase() : address}`,
                    href,
                    name,
                    age: ageText,
                    migrated,
                    // total_fees via numFromText so K/M/B suffixes apply (raw
                    // parseFloat turned "1.2K" into 1.2 — a 1000x undercount).
                    total_fees_text: feesText,
                    total_fees:      numFromText(feesText),
                    total_fees_native: numFromText(feesText),
                    total_fees_sol:  chainId === 'solana' ? numFromText(feesText) : null,
                    total_fees_eth:  chainId === 'robinhood' ? numFromText(feesText) : null,
                    total_fees_unit: nativeAsset,
                    ath_mc_text:     athMcText,
                    ath_mc_usd:      numFromText(athMcText),
                    current_mc_text: currentMcText,
                    current_mc_usd:  numFromText(currentMcText),
                    liq_text:        liqText,
                    liq_usd:         numFromText(liqText),
                    holders:         holdersText ? parseInt(holdersText.replace(/,/g, ''), 10) : null,
                    volume_1h_text:  volume1hText,
                    volume_1h_usd:   numFromText(volume1hText),
                    bundler_text:    bundlerText,
                    bundler_pct:     bundlerText ? numFromText(bundlerText) : null,
                    extras
                });
            }
        }

        // ---- TOKEN STATS SIDEBAR ----
        // GMGN now renders labels and values as adjacent elements without text
        // node whitespace (e.g. "Funding:FJXE...BW292.24154d"). Parse the
        // visible DOM relationships first; flattened body-text regexes silently
        // lost funding, migrated count and best-token data after this change.
        const stats = {};
        {
            const panelText = (document.body ? document.body.textContent : '')
                .replace(/\s+/g, ' ').trim();

            const findExact = (label) => Array.from(document.querySelectorAll('span, div'))
                .find(el => text(el) === label) || null;
            const numericSibling = (label) => {
                const raw = text(findExact(label)?.nextElementSibling);
                if (!raw) return null;
                const parsed = parseInt(raw.replace(/,/g, ''), 10);
                return Number.isFinite(parsed) ? parsed : null;
            };

            stats.total_pairs = numericSibling('Total Pairs:');
            stats.migrated = numericSibling('Migrated:');
            stats.non_migrated = numericSibling('Non Migrated:');

            // Retain compact-text fallbacks for future layouts where the
            // sibling labels disappear but equivalent visible text remains.
            if (stats.total_pairs == null) {
                const m = panelText.match(/Total Pairs[:\s]*([\d,]+)/i);
                if (m) stats.total_pairs = parseInt(m[1].replace(/,/g, ''), 10);
            }
            if (stats.migrated == null) {
                const m = panelText.match(/(?<!Non[- ])Migrated[:\s]*([\d,]+)\b(?!\s*%)/i);
                if (m) stats.migrated = parseInt(m[1].replace(/,/g, ''), 10);
            }
            if (stats.non_migrated == null) {
                const m = panelText.match(/Non[- ]?Migrated[:\s]*([\d,]+)/i);
                if (m) stats.non_migrated = parseInt(m[1].replace(/,/g, ''), 10);
            }

            const migPct = panelText.match(/(\d+(?:\.\d+)?)\s*%\s*Migrated/i);
            if (migPct) stats.migrated_pct = parseFloat(migPct[1]);

            const bestLabel = findExact("Dev's Best Token");
            const bestValue = bestLabel?.nextElementSibling;
            if (bestValue) {
                const spans = Array.from(bestValue.querySelectorAll('span'));
                const name = text(bestValue.querySelector('[class*="max-w-"]'))
                    || text(bestValue.firstElementChild);
                const ath = spans.map(text).find(value => /^\$[\d.]+[KMB]?$/i.test(value || '')) || null;
                if (name || ath) stats.best_token = { name: name || null, ath_mc_text: ath };
            }
            if (!stats.best_token) {
                const bestMatch = panelText.match(/Dev'?s Best Token\s*([^(]+?)\s*\(ATH MC\s*(\$[\d.]+[KMB]?)\s*\)/i);
                if (bestMatch) {
                    stats.best_token = {
                        name: bestMatch[1].trim(),
                        ath_mc_text: bestMatch[2]
                    };
                }
            }

            const lastLabel = findExact('Last Token Launched:');
            stats.last_token_launched_text = text(lastLabel?.nextElementSibling);
            if (!stats.last_token_launched_text) {
                const lastLaunch = panelText.match(/Last Token Launched[:\s]*([^.]+?ago)/i);
                if (lastLaunch) stats.last_token_launched_text = lastLaunch[1].trim();
            }

            const devLabel = findExact('DEV:');
            const devAnchor = devLabel?.parentElement?.querySelector(`a[href^="/${gmgnChain}/address/"]`);
            if (devAnchor) {
                const devText = text(devAnchor);
                const escapedNative = nativeAsset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const devMatch = devText?.match(new RegExp(`^(.*?)\\s*\\(([\\d,.]+)\\s*${escapedNative}\\)$`, 'i'));
                if (devMatch) {
                    stats.dev_wallet_short = devMatch[1].trim();
                    stats.dev_native_balance = numFromText(devMatch[2]);
                    if (chainId === 'solana') stats.dev_sol_balance = stats.dev_native_balance;
                    if (chainId === 'robinhood') stats.dev_eth_balance = stats.dev_native_balance;
                }
                stats.dev_wallet = (devAnchor.getAttribute('href') || '')
                    .replace(`/${gmgnChain}/address/`, '').split(/[?#]/)[0] || null;
            }

            const fundingLabel = findExact('Funding:');
            const fundingRow = fundingLabel?.parentElement;
            if (fundingRow) {
                const fundingAnchor = fundingRow.querySelector('a[href*="/address/"], a[href*="/account/"]');
                if (fundingAnchor) {
                    stats.funding_source_short = text(fundingAnchor);
                    stats.funding_source = (fundingAnchor.getAttribute('href') || '')
                        .replace(/^.*\/(?:account|address)\//, '').split(/[?#]/)[0] || null;
                }
                const amountEl = Array.from(fundingRow.querySelectorAll('span'))
                    .find(el => new RegExp(`(?:^|\\s)[\\d,.]+\\s*${nativeAsset}(?:\\s|$)`, 'i').test(text(el) || ''))
                    || fundingRow.querySelector('[data-icon*="bal" i]')?.parentElement;
                const amount = numFromText((text(amountEl) || '').replace(nativeAsset, ''));
                if (Number.isFinite(amount)) {
                    stats.funding_native = amount;
                    if (chainId === 'solana') stats.funding_sol = amount;
                    if (chainId === 'robinhood') stats.funding_eth = amount;
                }
                const ageLink = fundingRow.querySelector('a[href*="/tx/"]');
                if (ageLink) stats.funding_age = text(ageLink);
            }

            // Backward-compatible text fallbacks for DEV/funding layouts.
            if (!stats.dev_wallet_short) {
                const escapedNative = nativeAsset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const devLineMatch = panelText.match(new RegExp(`DEV:\\s*(\\S+?)\\s*\\(([\\d,.]+)\\s*${escapedNative}\\)`, 'i'));
                if (devLineMatch) {
                    stats.dev_wallet_short = devLineMatch[1];
                    stats.dev_native_balance = numFromText(devLineMatch[2]);
                    if (chainId === 'solana') stats.dev_sol_balance = stats.dev_native_balance;
                    if (chainId === 'robinhood') stats.dev_eth_balance = stats.dev_native_balance;
                }
            }
            if (!stats.funding_source_short) {
                const fundMatch = panelText.match(/Funding:\s*(\S+?)\s+([\d.]+)\s+(\d+[dhw])/i);
                if (fundMatch) {
                    stats.funding_source_short = fundMatch[1];
                    stats.funding_native = parseFloat(fundMatch[2]);
                    if (chainId === 'solana') stats.funding_sol = stats.funding_native;
                    if (chainId === 'robinhood') stats.funding_eth = stats.funding_native;
                    stats.funding_age = fundMatch[3];
                }
            }

            // Resolve any remaining full addresses from the page anchors.
            const addressAnchors = Array.from(document.querySelectorAll(`a[href^="/${gmgnChain}/address/"]`));
            for (const a of addressAnchors) {
                const innerTxt = text(a);
                const fullAddr = (a.getAttribute('href') || '').replace(`/${gmgnChain}/address/`, '').split(/[?#]/)[0];
                if (stats.dev_wallet_short && innerTxt.includes(stats.dev_wallet_short) && !stats.dev_wallet) {
                    stats.dev_wallet = fullAddr;
                }
            }
            if (!stats.funding_source) {
                const fundScan = document.querySelector('a[href*="/address/"], a[href*="/account/"]');
                if (fundScan) stats.funding_source = (fundScan.getAttribute('href') || '')
                    .replace(/^.*\/(?:account|address)\//, '').split(/[?#]/)[0];
            }
        }

        const visibleRowCount = panel ? panel.querySelectorAll('tbody tr').length : 0;
        const expectedRows = Number.isFinite(stats.total_pairs) ? stats.total_pairs : null;
        const emptyDespiteReportedPairs = expectedRows > 0 && rows.length === 0;
        const coverage = emptyDespiteReportedPairs
            ? 'FAILED_EMPTY'
            : (expectedRows != null && rows.length < expectedRows ? 'PARTIAL_CAPPED' : 'COMPLETE');

        return {
            ok: !emptyDespiteReportedPairs,
            error: emptyDespiteReportedPairs ? `GMGN reports ${expectedRows} dev pairs but no token rows were parsed` : null,
            coverage,
            dev_stats: stats,
            dev_tokens: rows,
            row_count: rows.length,
            visible_row_count: visibleRowCount,
            reported_total_pairs: expectedRows,
            row_cap: maxRows,
            row_cap_reached: rows.length >= maxRows
        };
    }, {
        maxRows: MAX_DEV_TOKEN_ROWS,
        chainId: config.id,
        gmgnChain: config.gmgn_namespace,
        nativeAsset: config.native_asset
    });
}

// ============================================================
// CHART SCREENSHOT
// ============================================================

/**
 * Capture the TradingView chart region from an already-navigated page.
 * Reusable so the persistent manager can re-screenshot every 30s without
 * re-navigating.
 */
async function captureChartFromPage(page) {
    await page.waitForSelector('[data-sentry-component="TradingView"]', { timeout: NAV_TIMEOUT_MS }).catch(() => {});
    // Settle so candles render inside the iframe before the snapshot.
    await delay(2500);

    const locator = page.locator('[data-sentry-component="TradingView"]').first();
    const box = await locator.boundingBox().catch(() => null);
    if (!box || box.width < 10 || box.height < 10) {
        return { ok: false, error: 'TradingView container not found or invisible' };
    }
    const buffer = await locator.screenshot({ type: 'png' });
    return {
        ok: true,
        width: Math.round(box.width),
        height: Math.round(box.height),
        bytes: buffer.length,
        base64: buffer.toString('base64'),
        captured_at: new Date().toISOString()
    };
}

async function captureChartScreenshot(tokenReference, opts = {}) {
    let identity;
    try {
        identity = normalizeCoinReference(tokenReference, { defaultChain: opts.chain });
    } catch (error) {
        return { ok: false, error: error.message };
    }
    return withPage(opts, async (page) => {
        try {
            await navigateToTokenPage(page, identity);
            const result = await captureChartFromPage(page);
            return result.ok ? { ...identity, ...result } : { ok: false, ...identity, ...result };
        } catch (e) {
            return { ok: false, ...identity, error: e.message };
        }
    });
}

// ============================================================
// STANDALONE TEST MODE
// ============================================================

if (require.main === module) {
    const tokenReference = process.argv[2];
    if (!tokenReference) {
        console.error('Usage: node gmgn-token-page-scraper.js <coin_id|solana-mint> [--chain=solana|robinhood] [--fallback] [--dev-history]');
        process.exit(1);
    }
    (async () => {
        const chainArg = process.argv.find(arg => arg.startsWith('--chain='));
        const opts = {
            chain: chainArg ? chainArg.slice('--chain='.length) : undefined,
            includeDevHistory: process.argv.includes('--dev-history')
        };
        console.log(`Scraping token page for ${tokenReference}...`);
        const result = process.argv.includes('--fallback')
            ? await scrapeGmgnFallbackSnapshot(tokenReference, opts)
            : await scrapeTokenPage(tokenReference, opts);
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.ok ? 0 : 1);
    })();
}

module.exports = {
    // One-shot entry points
    scrapeTokenPage,
    scrapeGmgnFallbackSnapshot,
    captureChartScreenshot,
    // Persistent-page helpers — used by token-page-manager.js so the same
    // page can extract data + capture chart over and over without re-navigating
    extractTokenPageData,
    extractDevTokenHistory,
    captureChartFromPage,
    navigateToTokenPage,
    _internal: {
        withPage,
        assessTokenPageCoverage,
        finalizeTokenPageData,
        buildGmgnFallbackSnapshot,
        GMGN_FALLBACK_SCHEMA_VERSION
    }
};
