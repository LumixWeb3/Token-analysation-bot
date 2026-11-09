# AlphaHands V2

An ongoing agentic research system for narrative-driven tokens. V2 gathers source-qualified market and social evidence, maintains a living strategy and watches, and supports separate main and review agents.

## Included

- Trending and Migrated discovery with explicit chain, filter and freshness coverage.
- Exact-token market, chart and top-20 holder evidence with source provenance.
- Codex SDK transport with separate ChatGPT sign-in and main/review model roles.
- Web research, dedicated-browser tools and recorded discovery-filter changes.
- Research checkpoints, shared strategy context and offline regression tests.

The v2/agent directory contains instructions, transport, research and evidence handling. The v2/market directory contains collectors, filters and public schema fixtures. Five root modules provide chain definitions, saved-profile locking, the token-page parser and optional read-only X client used by V2.

## Local setup

Use Node.js 22 or later and installed Google Chrome. Install with npm ci, then run npm test, npm run privacy:check and npm run prompt:check.

Tests use offline fixtures, including intercepted pages in local headless browsers. Playwright needs its Chromium test browser installed. If missing, install it with npx playwright install chromium.

For explicit ChatGPT sign-in, run node v2/agent/codex-auth.js --login. The official SDK stores that installation's login separately. Browser profiles and locally generated evidence stay outside Git. The optional X client connects to a separately configured read-only service, whose default address appears in .env.example.

The main research model defaults to gpt-6.1-sol at medium effort and the review model to gpt-6-luna at medium effort. Model availability is checked at runtime.

## Development status

This release is a V2 research prototype. A complete unattended strategy, account and position loop still needs integration and live qualification. Source availability, browser authentication and future data correctness require deployment-specific verification. Performance remains unproven.

## Publication scope

This repository has fresh source-only history. Authentication, credentials, browser profiles, personal operating notes, real account records, private lessons, model transcripts and original Git history are excluded. Historical public fixtures exercise parsing and validation.

Run npm run privacy:check before publishing changes. Keep deployment-specific state in ignored local paths.
