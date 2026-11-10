# AlphaHands V2

An ongoing agentic research system for narrative-driven tokens. V2 gathers source-qualified market and social evidence, maintains a living strategy and watches, and supports separate main and review agents.

## Included

- Trending and Migrated discovery with explicit chain, filter and freshness coverage.
- Exact-token market, chart and top-20 holder evidence with source provenance.
- Codex SDK transport with separate ChatGPT sign-in and main/review model roles.
- Web research, dedicated-browser tools and recorded discovery-filter changes.
- Research checkpoints, shared strategy context and offline regression tests.

The `v2/agent` directory contains instructions, transport, research and evidence handling. The `v2/market` directory contains collectors, filters and public schema fixtures. Shared root modules provide chain definitions, Chrome discovery, saved-profile locking, the token-page parser, paper accounting and the optional read-only X client used by V2.

## Local setup

The tested environment is Windows with Node.js 22 or later and installed Google Chrome. The manual browser-login helper also supports installed Chrome on Linux with a graphical desktop. Remote and headless-only environments require separate browser setup.

### 1. Download and install

Your GitHub account needs access to this private repository.

```sh
git clone https://github.com/LumixWeb3/Token-analysation-bot.git
cd Token-analysation-bot
npm ci
npx playwright install chromium
```

For an existing checkout, run `git pull --ff-only` and `npm ci` after preserving any local changes. Keep at least 2.25 GB of free RAM before opening a collector browser.

### 2. Run the offline checks

```sh
npm test
npm run privacy:check
npm run prompt:check
```

Tests use fixtures and locally intercepted browser pages. Passing tests establishes those tested paths. Live data, login validity and unattended operation require their own checks.

### 3. Sign in to ChatGPT

```sh
npm run auth:login
npm run auth:status
```

Complete the browser sign-in when prompted. The official SDK uses its own local login directory. Each person supplies their own ChatGPT account. Model availability and usage limits depend on that account.

### 4. Check the two model connections

```sh
npm run check:recal
npm run check:main
```

These commands consume subscription usage. Each model must call the diagnostic `discovery_read` tool and return its marker with `trading_enabled` set to `false`. The main model also performs one official-documentation web search. The main model defaults to `gpt-6.1-sol` at medium effort and the review model to `gpt-6-luna` at medium effort. Unavailable models or the usage-reserve gate produce an explicit failure.

### 5. Create your local source logins

Close any previous dedicated collector window, then open the source you need.

```sh
npm run browser:login -- --site=gmgn
```

Axiom and X share one dedicated research profile. Sign in to each site separately and close its window before opening the next.

```sh
npm run browser:login -- --site=axiom
npm run browser:login -- --site=x
```

Each command opens ordinary installed Chrome. Log in manually, then close that dedicated window completely before starting a collector. Its terminal command finishes when Chrome exits. Authentication stays in the ignored local profile. Regular Chrome login and collector-profile login are separate.

### 6. Start a bounded market-data check

```sh
npm run collect:check
```

This opens the saved GMGN profile, checks the configured Trending and Migrated feeds for about 60 seconds after initialization, saves local evidence under `v2-runtime`, and closes its browser. Check the reported readiness, reasons and chain/feed row counts. Saved output is marked disconnected when collection stops. An empty, stale, blocked or incomplete source must be investigated before research can use it.

For a manual Axiom source inspection, run the following command and close its dedicated window when finished.

```sh
npm run axiom:inspect
```

The Axiom window inventories selected public response metadata. For a bounded exact-token check, replace the sample Solana mint with the token you want to inspect.

```sh
node v2/agent/inspect-axiom.js --probe-token=8rHoAfpdE89bi1SRRKaYUWfng3YpntoxZQyEQy9GPmZV
```

This command collects allowlisted token metadata and holder aggregates for about 20 seconds, saves the result locally and closes its window. It fails if the expected token response or holder aggregates were not observed. Top-20 wallet ranking, native wallet labels and percentage normalization remain explicitly unverified. Axiom's complete research adapter is still in development.

### 7. Optional X data service

The X client expects a separately configured read-only service at `http://127.0.0.1:4010`. `.env.example` documents the connection settings. V2 reads settings from the process environment, so configure them in your terminal or hosting environment. Supply that service's source login locally. The host connects its owned research browser automatically and can use it for exact-source fallback. X and Axiom authentication stays local in that research profile.

## Verify browser access

After closing the login windows, check source accounts and model-driven navigation.

```sh
npm run check:accounts
npm run check:browser
```

The browser check consumes subscription usage. It requires the model to navigate a public page, follow its link and read a source sentence. The account check qualifies exact-author X content plus Axiom authenticated token/holder aggregates. Ranked Axiom top20 coverage remains unverified. Close the diagnostic before starting another source session.

## Start an explicitly authorized paper session

The runner requires an existing valid local paper-account file. It preserves balances, positions, fills, costs and risk limits. Missing or corrupt accounts fail before source startup. A migrated deployment needs its account file transferred privately outside Git.

For a fresh developer installation only, explicitly create a new local simulation account. Running this command against an existing account preserves it.

```sh
node -e "new (require('./paper-ledger-core').PaperAccount)().initialize(30)"
```

Supply the absolute path to that file. Replace the example path with your checkout location.

```sh
npm run start:paper -- --account-file=C:/AlphaHands/paper-account.json --seconds=600
```

This starts a bounded ten-minute paper session. Installed Chrome opens visibly by default because the latest background GMGN check was blocked while normal visible access passed. The source collector shares its GMGN profile with an exclusive token-research tab. X/Axiom use one additional lazy research browser. Keep RAM available. A source challenge requires manual completion.

After the bounded deployment qualifies, the same runner can continue until you stop it.

```sh
npm run start:paper -- --account-file=C:/AlphaHands/paper-account.json --continuous
```

Stop with Ctrl+C. Shutdown preserves holdings and closes owned resources. Source/auth/usage failures and unresolved state errors block affected work. The runner never enables a real wallet.

The main model observes both configured feed scopes, forms the strategy and considers new arrivals. Luna handles recurring watch/position reviews against that shared strategy. Ordinary recals default to five minutes and a main refresh to ten minutes, with coalesced earlier wakes for arrivals or due watches. Fixed observation cohorts expire after ten minutes and retain their original source timestamps.

Paper proposals are accepted only through the structured action interface. New exposure requires an accepted strategy, qualified exact-token/chart/linked-X evidence, current account revision and a fresh USD quote inside the proposed entry range. Existing costs, 25 percent cash/per-coin caps, five-position limit and action cooldown remain enforced. Reductions use remaining holdings. A replay reconciles the original receipt. It cannot create a duplicate fill.

Local health, accepted strategy, review history and action outcomes are under ignored `v2-runtime/bot`. The paper ledger retains fills and realised PnL. Missing fresh valuation leaves unrealised PnL unavailable. Discovery failure still permits held-position reviews and qualified reductions, while entries stay blocked.

## Verification status and remaining work

Offline accounting, model handoff, scheduling and recovery fixtures pass. Bounded live discovery, exact-token/chart capture, shared-profile research and a genuine model-driven browser check passed in development. These checks establish the observed components. The complete natural strategy-to-fill session and overnight uptime remain unverified.

Automatic Trending mutation requires an integrated live UI/query verifier and currently reports unavailable in this runner. Native Axiom ranked top20 order, labels and freshness need qualification. Abandoned locks or interrupted ACTIVE research checkpoints require deliberate revalidation. The browser destination screen also needs deployment-level network isolation for stronger redirect/DNS-rebinding containment.

A bounded paper deployment must qualify these operational paths before calling the bot ready for an unattended full run. Profitability remains unproven.

## Publication scope

This repository has fresh source-only history. Authentication, credentials, browser profiles, personal operating notes, real account records, private lessons, model transcripts and original Git history are excluded. Historical public fixtures exercise parsing and validation.

Run npm run privacy:check before publishing changes. Keep deployment-specific state in ignored local paths.
