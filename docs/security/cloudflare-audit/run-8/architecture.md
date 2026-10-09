# Architecture, run 8

OpenSesame is a dual-plane authorization fabric: the **Host** (`crates/gateway`, default `127.0.0.1:8787`) authorizes ConnectionRef + intent, invokes connectors, and returns receipts; the **Identity API** (`packages/control-plane`, `:8788`) answers who is signed in; **clients** (Pages PWA, extension, `opensesame-id`, MCP) hold E2EE vaults and ceremonies. Lower-trust principals include unauthenticated webhook edges (HMAC-gated), browser grants (DPoP + capability ceiling), agent-capability bearers, guests in an isolated tomb, join observers, and the local daemon’s UDS peers.

**Audited product commit:** `cfa60722e1c26403c0d833fb230c48a5db07bd44` — stack tip on `cursor/cf-audit-wallet-custom-scheme-d641` (#846), including NV fixes #839–#846 (egress encoded path, sandbox grant expiry, CLI `open_url`, compose NATS loopback, gateway observation role-evidence fence, wallet custom-scheme validation) plus quality-gate splits on that branch. **Artifact branch:** `cursor/cf-audit-run-8-artifacts-d641` stacked on counted run 7 (#859); hunters work in worktree `/tmp/wt-run8-stack` at the product commit.

**Prior counted run:** run 7 (#859) — 0 confirmed, 0 needs_validation, 23 rejected carry-forward. Run 5 and run 6 are not counted.

**Agents:** Cursor **Composer 2.5** subagents in parallel worktrees; no Grok Build / `XAI_API_KEY`.

**Stack (offline on this VM):** Rust 1.88, pnpm 9.15 / Node 22, Playwright Chromium at `/opt/pw-browsers/chromium` when needed. No Docker/Android emulator in the default cloud image.

**Entry surfaces and controls** match run 7 `architecture.md` with these stack-tip fixes verified on `cfa60722`: `EgressBinding::allows_url` encoded-path gate (`authority_egress.rs`), sandbox `grant_expiry` integration tests, `connect_open_url.rs` HTTPS/loopback gate, compose NATS `127.0.0.1:4222`, `ensure_browser_observe_ceiling` on observation control + hook records, `validateCredentialOfferSchemeHandoff` / `custom_scheme_*` tests in `authenticator-core`.

**Run 8 hunt contract:** each of 54 ledger units must record `read_ranges` (path + line spans actually read), at least two `hypotheses` tested (with rejected/accepted), and an optional `candidate` object when a plausible finding is ruled out or promoted.
