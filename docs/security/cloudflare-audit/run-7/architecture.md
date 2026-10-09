# Architecture, run 7

OpenSesame is a dual-plane authorization fabric: the **Host** (`crates/gateway`, default `127.0.0.1:8787`) authorizes ConnectionRef + intent, invokes connectors, and returns receipts; the **Identity API** (`packages/control-plane`, `:8788`) answers who is signed in; **clients** (Pages PWA, extension, `opensesame-id`, MCP) hold E2EE vaults and ceremonies. Lower-trust principals include unauthenticated webhook edges (HMAC-gated), browser grants (DPoP + capability ceiling), agent-capability bearers, guests in an isolated tomb, join observers, and the local daemon’s UDS peers. Protected resources are vault plaintext, brokered credentials, org membership, observation runs, tailnet credentials, and child-process environments reached through credential helpers.

**Audited source:** commit `d1ce497fbc40e5c8ea4756674d08d74b116cdaae` on the NV fix stack (`cursor/cf-audit-wallet-custom-scheme-d641` ancestry); run-7 artifact branch tip `68dff5a9` adds only audit docs. **Prior runs:** run-1–4 produced real hunter/verifier evidence; run-5 and run-6 are **not counted** (scripted regeneration, see #847/#848). This run re-hunts from a reset ledger (54 units) with Cursor-only hunters (Grok 402 at start).

**Stack (offline on this VM):** Rust 1.88 (`rust-toolchain.toml`), pnpm 9.15 / Node 22, Turbo/Biome/Vitest/Playwright (Chromium at `/opt/pw-browsers/chromium` when present). No Docker, Wine, or Android emulator in the cloud image (`docs/security/cloudflare-audit/run-5/architecture.md` limits still apply). `unshare` user+net namespaces work for `verify:live-netns`-class checks; `cargo test` with `wasm-runtime,fixtures` exercises `opensesame-sandbox`.

**Comparable baseline:** `docs/research/competitors/index.md` (pass, Infisical-class agent proxy, Bitwarden bridges, Vault/OpenBao providers). Gaps are in scope only when *this* repo’s principal can cross a boundary, not when a peer product would.

**Entry surfaces (high signal):**

- Host HTTP: `crates/gateway/src/routes/mod.rs` — `POST /api/v1/intents` (invoke), connections/OAuth, device login, browser pairings, agent-hooks intercept (native session only), web-login runs, sync pages (ciphertext only), signed `POST /webhooks/{connection}/{route}`, GitHub webhooks, NATS callout, optional Bitwarden-compat and mTLS admission (`crates/gateway/src/transport/`).
- Identity HTTP: `packages/control-plane/src/app.ts` — OIDC/Better Auth, interactions, SCIM/SAML/LDAP, notification callbacks (signature + replay ledger), push enrolment, wallet-native/OID4VCI/VP routes when mounted.
- Daemon: `crates/daemon/src/lib.rs` — loopback/UDS operator token, `invoke_through`, agent launch handle, tailnet admin (credential never to pages), plugin settings only.
- Clients: Pages (`apps/pages` + `packages/app-core`) device identity routes, join ceremony (`packages/app-core/src/lib/join/`), live WebRTC (`lib/live/`), extension runner; CLIs and MCP stdio/HTTP.
- Files/IPC: sealed store, vault files, SQLite sealed columns, credential helpers via daemon.

**Trust boundaries and controls (source-visible):**

- Session claims digest-keyed; sessions cannot override org via header (`middleware/auth.rs`). Operator token separate; `Caller::Operator` break-glass (`auth.rs`).
- Agent-capability path map closed; agent-hooks intercept refused for non-native sessions (`agent_hooks.rs`, `agent_grants.rs`).
- Browser grants capped; join ceiling `host.join` (`browser_pairings.rs`, `join/client.ts`).
- Invoke L3/materialize denied (`intents.rs`); OpenFGA optional skip when unconfigured (`intents_projection.rs`).
- Daemon rejects `Origin` on operator routes; UDS peer UID allowlist (`daemon/lib.rs`, `agent_capability.rs`).
- Guest tomb isolation (`vault/store.ts`); capability modules load only after consent plan (`apps/pages/src/main.tsx`).
- Egress prefix gate on L2 URLs (`crates/domain`); sandbox grant expiry rechecked at spawn and broker import (`crates/sandbox/src/runtime/mod.rs`, `imports.rs`) — fixed on this stack.
- Wallet custom-scheme handoff must pass `validate_platform_invocation` / `validateCredentialOfferSchemeHandoff` (Android/iOS + `authenticator-core`) — fixed on this stack.
- Compose NATS publish bound to `127.0.0.1:4222` (`ops/compose/docker-compose.yml`); static test `scripts/test/compose-nats-bind.test.mjs`.

**Prior coverage consequences:** Six run-3 `needs_validation` items have product fixes on this tip (`run-3-needs-validation-resolutions.md`); hunters must re-read sources and verifiers must reproduce or reject with file:line + test/command. Same-source covered units remain in the ledger as `prior_covered_same_source` but require hunter pass or critic reopen before `covered`. Run-5/6 verifier JSON under `run-5/agents/` is narrative only, not evidence for this run.

**Companion selection (summary):** `WEB-PROTOCOL-AND-AUTH.md` for HTTP/OAuth/federation; `DATA-ISOLATION-AND-LIFECYCLE.md` for backup/sync/tenant scope; `AI-AND-LLM.md` for delegations/agent-hooks; `DESKTOP-MOBILE-AND-LOCAL-IPC.md` for wallet URLs, helpers, daemon IPC; `CLOUD-AND-DEPLOYMENT.md` for compose/ingress; `CLIENT-SIDE.md` for extension/SW; `PROTOCOLS-RPC-AND-MESSAGING.md` for NATS/taskbus; `RESOURCE-EXHAUSTION-AND-AVAILABILITY.md` for body limits and relay. Memory-safety companions attach only on unsafe/FFI parsers in assigned paths.

**Deferred surfaces (not seeded until critic accepts):** Bitwarden-compat id lookups, anonymous/provisional edge cases, full control-plane OAuth surface as separate units beyond ledger, OCI wasm fetch, operator header ignore paths — listed in run-3 architecture § tail; wave-2 critic may add units.
