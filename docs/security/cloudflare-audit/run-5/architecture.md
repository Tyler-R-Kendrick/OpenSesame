# Architecture, run 5

OpenSesame at `3928d033cf999e3adf7b8b00cc874cd76944deb5` is the six-PR NV fix stack on top of run 3 artifacts (#829) and run 4 regression (#834). The Host gateway (`crates/gateway`), daemon (`crates/daemon`), connection broker, sandbox wasm runtime, Pages relay, control plane, CLI, compose reference, and mobile wallet authenticators share one authorization fabric: ConnectionRef grants, browser pairings with `config_authorization_roles`, and sealed credentials at the last hop.

Run 5 is a **standard** full pass at this tip. Phase 1 reconnaissance re-read the tree with four parallel `research` agents (product stack, principals, entry surfaces, offline execution). Prior runs 1–4 and incompatible bogus run 5/6 ledgers were read for coverage consequences only; ledger bytes were **not** copied from run 3.

**Tip deltas since run 3 (`33ecab02`):** stacked fixes #839–#846 land encoded-path egress decoding in `EgressBinding::allows_url`, grant `expires_at` enforcement in `Sandbox::spawn` and broker imports (`grant_expiry` tests), HTTPS-only browser open with empty Windows `start` title, loopback-bound NATS publish in compose, observation **control** role-evidence fence via `ensure_browser_observe_ceiling`, and custom-scheme wallet handoffs through `validateCredentialOfferSchemeHandoff` on Android and iOS.

Trust boundaries unchanged from run 3: unauthenticated HTTP to gateway/control-plane, browser extension runner against armed origins, daemon loopback proxy, task-bus NATS callout, level-2 broker invoke, sandbox broker imports, and exported mobile VIEW handlers.

**Coverage plan:** 54 ledger units seeded from recon (same surface×boundary×attack-class grid as run 3, regenerated in this run). Wave 1 carried forward as `prior_covered_same_source` where source unchanged. Wave 2 revalidated the six run-3 `needs_validation` fingerprints against fix commits with **fresh hunters** in `/tmp/wt-cf-audit-run5-h1` and `/tmp/wt-cf-audit-run5-h2` and **independent verifiers** in `/tmp/wt-cf-audit-run5-v1` (detached worktrees at `3928d033cf999e3adf7b8b00cc874cd76944deb5`). No new hunter fingerprints were opened.

**Offline limits:** Linux cloud agent, no Android emulator, no Docker, no Wine/cmd.exe execution. Decisive checks use source re-read plus `cargo test` for sandbox grant expiry and domain egress on the tip worktrees.

**Comparable baseline:** pass/KeePassXC/Bitwarden-class vault plus agent-authority peers (Infisical, Tailscale) per `docs/research/competitors/index.md`; calibrates effort only.

Prior bogus run 5 ledger md5 `31fb49f4…` (byte-identical to run 3) is void. This run ledger md5 `0c0c52eef9c9022e41dd9c91f724749b`.
