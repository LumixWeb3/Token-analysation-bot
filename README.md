# AlphaHands V2

An ongoing agentic research system for narrative-driven tokens. V2 gathers source-qualified market and social evidence, maintains a living strategy and watches, and supports separate main and review agents.

## Included

- Trending and Migrated discovery with explicit chain, filter and freshness coverage.
- Exact-token market, chart and top-20 holder evidence with source provenance.
- Codex SDK transport with separate ChatGPT sign-in and main/review model roles.
- Web research, dedicated-browser tools and recorded discovery-filter changes.
- Research checkpoints, shared strategy context and offline regression tests.

The `v2/agent` directory contains instructions, transport, research and evidence handling. The `v2/market` directory contains collectors, filters and public schema fixtures. Six shared root modules provide chain definitions, Chrome discovery, saved-profile locking, the token-page parser and the optional read-only X client used by V2.

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

For Axiom research, use the separate Axiom profile.

```sh
npm run browser:login -- --site=axiom
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

The Axiom command currently inventories selected response metadata. Its research adapter is still under verification.

### 7. Optional X data service

The X client expects a separately configured read-only service at `http://127.0.0.1:4010`. `.env.example` documents the connection settings. V2 reads settings from the process environment, so configure them in your terminal or hosting environment. Supply that service's source login locally. The research browser can provide fallback evidence only when an owned-browser controller is connected by the host.

## Starting the complete bot

This snapshot provides the bounded commands above and a programmatic `runResearchSession` entry point. Continuous discovery, agent scheduling, source-controller ownership and paper-position execution still need an integrated host. A successful collector or model connection check alone cannot qualify an overnight trading run.

## Development status

This release is a V2 research prototype. A complete unattended strategy, account and position loop still needs integration and live qualification. Source availability, browser authentication and future data correctness require deployment-specific verification. Performance remains unproven.

## Publication scope

This repository has fresh source-only history. Authentication, credentials, browser profiles, personal operating notes, real account records, private lessons, model transcripts and original Git history are excluded. Historical public fixtures exercise parsing and validation.

Run npm run privacy:check before publishing changes. Keep deployment-specific state in ignored local paths.
