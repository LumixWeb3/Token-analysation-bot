'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createResearchBrowser } = require('./research-browser-owner');
const { createOwnedBrowserController } = require('./research-browser');
const { collectXFromPage } = require('./x-browser-source');
const { observeAxiomTokenResponses } = require('./axiom-token-evidence');
const AXIOM_MINT = '8rHoAfpdE89bi1SRRKaYUWfng3YpntoxZQyEQy9GPmZV';

async function verifyBrowserAccounts({headless=true}={}) {
  const owner = createResearchBrowser({headless});
  let lease, observer, stage='BROWSER_ACQUIRE';
  try {
    lease = await owner.acquirePage({ service: 'web' });
    const page = lease.page;
    let xStatus=null;
    page.on('response',response=>{try{if(response.request().isNavigationRequest()&&new URL(response.url()).hostname==='x.com')xStatus=response.status();}catch{}});
    stage='X_NAVIGATION';
    let x;
    try{
    await page.goto('https://x.com/solana', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]') &&
      Array.from(document.querySelectorAll('article[data-testid="tweet"]')).some(article =>
        /\/solana\/status\//i.test(article.querySelector('time')?.closest('a[href]')?.getAttribute('href') || '') &&
        article.querySelector('[data-testid="tweetText"]')?.textContent.trim()), {}, { timeout: 20000 }).catch(() => {});
    stage='X_SOURCE_CHECK';
    const xLoggedIn = await page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').count() > 0;
    const xSource = await collectXFromPage({ page, request: {
      kind: 'x_link', input: 'https://x.com/solana', reason: 'Verify saved research login and exact-author public data.'
    } });
    x={logged_in_ui_observed:xLoggedIn,exact_public_source_qualified:xSource.qualified,
      reason:xSource.reason,http_status:xStatus,checked:xSource.checked_count,qualified:xSource.qualified_count,
      unverified:xSource.unverified_count,unchecked:xSource.unchecked_count};
    }catch(error){x={logged_in_ui_observed:false,exact_public_source_qualified:false,
      reason:/net::(ERR_[A-Z_]+)/.exec(error.message)?.[1]??error.name,http_status:xStatus,checked:0,unchecked:null};}
    await lease.release();
    lease = null;

    stage='AXIOM_NAVIGATION';
    observer = observeAxiomTokenResponses(page, AXIOM_MINT);
    let axiomRefreshSucceeded = false;
    const refresh = response => {
      const url = new URL(response.url());
      if (/^api\d*\.axiom\.trade$/.test(url.hostname) && url.pathname === '/refresh-access-token' && response.status() === 200)
        axiomRefreshSucceeded = true;
    };
    page.on('response', refresh);
    const controller = createOwnedBrowserController({ acquirePage: owner.acquirePage });
    const axiom = await controller.perform({ action: 'navigate',
      url: 'https://axiom.trade/token/' + AXIOM_MINT + '?chain=sol', reason: 'Verify saved Axiom login and public holder-panel capture.' });
    page.off('response', refresh);
    const publicResponses = await observer.finish();
    observer = null;
    const axiomMetadata = publicResponses.observations.some(item => item.identity_basis === 'EXACT_REQUEST_AND_RESPONSE_TOKEN');
    const axiomAggregates = publicResponses.observations.some(item => item.raw_public.holderStats);
    const outputDir = path.resolve(__dirname, '../../v2-runtime/browser-accounts-' + crypto.randomUUID());
    fs.mkdirSync(outputDir, { recursive: true });
    const result = { verified_at: new Date().toISOString(), output_dir: outputDir,
      x,
      axiom: { authenticated_refresh_observed: axiomRefreshSucceeded, public_browser_status: axiom.status,
        reason: axiom.reason, exact_token_metadata_observed: axiomMetadata, holder_aggregates_observed: axiomAggregates,
        source_failures: publicResponses.failures, top20: 'UNVERIFIED' },
      trading_enabled: false, browser_closed_on_return: true };
    fs.writeFileSync(path.join(outputDir, 'verification.json'), JSON.stringify(result, null, 2));
    return result;
  } catch(error) {
    const failure=Error('BROWSER_ACCOUNT_CHECK_FAILED');
    failure.details={stage,code:/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:
      /net::(ERR_[A-Z_]+)/.exec(error.message)?.[1]??error.name};
    throw failure;
  } finally {
    try { if (observer) await observer.finish(); }
    finally { if (lease) await lease.release(); await owner.close(); }
  }
}

if (require.main === module) {
  if (!process.argv.includes('--live') || process.argv.slice(2).some(arg=>!['--live','--headed'].includes(arg))) {
    process.stderr.write('Explicit --live required.\n'); process.exitCode = 1;
  } else verifyBrowserAccounts({headless:!process.argv.includes('--headed')}).then(result => {
    process.stdout.write(JSON.stringify(result) + '\n');
    if (!result.x.logged_in_ui_observed || !result.x.exact_public_source_qualified ||
      !result.axiom.authenticated_refresh_observed || result.axiom.public_browser_status !== 'COLLECTED' ||
      !result.axiom.exact_token_metadata_observed || !result.axiom.holder_aggregates_observed) process.exitCode = 1;
  }, error => { process.stderr.write(JSON.stringify({error:error.message,details:error.details??null})+'\n'); process.exitCode = 1; });
}

module.exports = { verifyBrowserAccounts };
