# Provenance of the 2026-10 verification stack (#776–#796)

Honest record of who produced each commit on the stacked PRs
`#776` → `#796`. **Do not treat `Author: Grok <noreply@x.ai>` as proof that
Grok Build generated the change.** Many commits were made with
`GIT_AUTHOR_NAME=Grok` / `GIT_AUTHOR_EMAIL=noreply@x.ai` by the Cursor agent
(committer `Cursor Agent`) after a soft-reset, cherry-pick, or restack.
Tyler decided (2026-10-08): **no history rewrite and no force-push to change
authors.** Keep the existing commits. This file plus a Provenance section on
each affected PR is the record. Every new commit from that point must carry
honest authorship.

## Producer labels

| Label | Meaning |
| --- | --- |
| `live_grok_build` | Grok Build session produced the restack/patch (session logs under the agent store / `/tmp/grok-*.log`); the commit was still created via local `git commit` with Author Grok (committer Cursor Agent). |
| `grok_labeled_replay` | Cursor agent (or a git cherry-pick/soft-reset) produced or re-applied the tree and stamped Author Grok. Includes post–usage-exhaustion work and batch replays. |
| `cursor_agent` | Author and committer are Cursor Agent. Honest post-exhaustion authorship. |

## Exhaustion evidence

Grok Build returned HTTP 402 `Grok Build usage balance exhausted` during the
#794 restack (after #793 went green), with ~95 model calls on `grok-4.6-build`
in that session (`/tmp/grok-restack-tail.log`). Confirmed again on both device
OIDC (`env -u XAI_API_KEY`) and with `XAI_API_KEY` set on 2026-10-08 ~09:17 UTC.
After that point, commits labeled Grok were not live Grok. Retried once via
`scripts/dev/grok-headless.sh` for the static-PWA stack on 2026-10-08 ~15:14 UTC
— again HTTP 402 (`/tmp/grok-static-pwa-attempt.log`). That stack is Cursor Agent.

## Counts (unique commits `base..head` per PR, summed)

| Producer | Count |
| --- | ---: |
| `live_grok_build` | 17 |
| `grok_labeled_replay` | 47 |
| `cursor_agent` | 32 |
| `unknown` | 0 |
| **Total** | **96** |

## Commits by PR

### #776 (`origin/cursor/verification-audit-b359` → tip `f347ac30`)

| SHA | Author (as shown) | Real producer | Subject |
| --- | --- | --- | --- |
| `f347ac30` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | fix(pages): keep DESIGN keymap jumps aligned with Activity |
| `84f3d6dd` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | ci: refuse retained checkout credentials in publish workflows |
| `3e0b2ac8` | Grok `<noreply@x.ai>` | `live_grok_build` | docs: link audit follow-ups to PR #776 |
| `6dc7bf08` | Grok `<noreply@x.ai>` | `live_grok_build` | feat: env prod reuse tray warning and publish workflows |
| `429ffbad` | Grok `<noreply@x.ai>` | `live_grok_build` | docs: audit Tyler 2026-10 verification checklist against main |

### #779 (`origin/cursor/grok-env-preflight-b359` → tip `cd5bfb49`)

| SHA | Author (as shown) | Real producer | Subject |
| --- | --- | --- | --- |
| `cd5bfb49` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | fix(pages): keep DESIGN keymap jumps aligned with Activity |
| `473d9938` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | ci: refuse retained checkout credentials in publish workflows |
| `f6feb84e` | Grok `<noreply@x.ai>` | `live_grok_build` | chore: Grok headless wrapper and auth preflight for depleted API key |

### #782 (`origin/cursor/guest-u3-b359` → tip `5a5a82bd`)

| SHA | Author (as shown) | Real producer | Subject |
| --- | --- | --- | --- |
| `5a5a82bd` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | fix(pages): keep DESIGN keymap jumps aligned with Activity |
| `d4015a32` | Grok `<noreply@x.ai>` | `live_grok_build` | fix(pages): split files that crossed the quality line budget |
| `d285cc41` | Grok `<noreply@x.ai>` | `live_grok_build` | style(pages): format capture ceremony guest skip selector |
| `d752c62f` | Grok `<noreply@x.ai>` | `live_grok_build` | ci: drop persisted credentials on publish checkouts |
| `76e41326` | Grok `<noreply@x.ai>` | `live_grok_build` | fix(pages): resume a keyless guest tomb in the push-worker walk |
| `b5371541` | Grok `<noreply@x.ai>` | `live_grok_build` | fix(pages): unify guest entry copy per verification U3 |

### #783 (`origin/cursor/vault-tree-u4-b359` → tip `0f6c24dd`)

| SHA | Author (as shown) | Real producer | Subject |
| --- | --- | --- | --- |
| `0f6c24dd` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | fix(pages): keep DESIGN keymap jumps aligned with Activity |
| `b1ef3369` | Grok `<noreply@x.ai>` | `live_grok_build` | fix(pages): clip vault tree guide borders per verification U4 |

### #787 (`origin/cursor/audit-playwright-b359` → tip `e4edd105`)

| SHA | Author (as shown) | Real producer | Subject |
| --- | --- | --- | --- |
| `e4edd105` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | fix(pages): keep DESIGN keymap jumps aligned with Activity |
| `eb8d09d4` | Grok `<noreply@x.ai>` | `live_grok_build` | docs: Playwright verification walk for 2026-10 checklist |

### #790 (`origin/cursor/adr-relay-vault-sync-b359` → tip `eb921d94`)

| SHA | Author (as shown) | Real producer | Subject |
| --- | --- | --- | --- |
| `eb921d94` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | fix(pages): keep DESIGN keymap jumps aligned with Activity |
| `bd1ed29c` | Grok `<noreply@x.ai>` | `live_grok_build` | docs: ADR 0181 for relay host, org vaults, join sync |

### #791 (`origin/cursor/publishing-verify-b359` → tip `73a4a73a`)

| SHA | Author (as shown) | Real producer | Subject |
| --- | --- | --- | --- |
| `73a4a73a` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | fix(pages): keep DESIGN keymap jumps aligned with Activity |
| `542112d7` | Grok `<noreply@x.ai>` | `live_grok_build` | docs: publishing dry-run evidence for 2026-10 checklist |

### #793 (`origin/cursor/checklist-walk-profiles-h5-h7-b359` → tip `2051c231`)

| SHA | Author (as shown) | Real producer | Subject |
| --- | --- | --- | --- |
| `2051c231` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | fix(pages): keep DESIGN keymap jumps aligned with Activity |
| `7b840378` | Grok `<noreply@x.ai>` | `live_grok_build` | fix(pages): typecheck support questions recovery mock |
| `af5540e0` | Grok `<noreply@x.ai>` | `live_grok_build` | fix(pages): split checklist walk files under the line budget |
| `5f514632` | Grok `<noreply@x.ai>` | `live_grok_build` | fix(pages): screenshot each verification checklist item |
| `2708ae16` | Grok `<noreply@x.ai>` | `live_grok_build` | fix(pages): build the full walk apart from stock and filter help |

### #794 (`origin/cursor/tutorials-minimal-full-b359` → tip `3a104f7a`)

| SHA | Author (as shown) | Real producer | Subject |
| --- | --- | --- | --- |
| `3a104f7a` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | style(browser-extension): biome-format enqueue signature |
| `2d5fa513` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | fix(browser-extension): give settle room under the enqueue wall-clock waiter |
| `b59179d6` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | fix(browser-extension): keep runner idle polls under the vitest budget |
| `03fe9273` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | fix(pages): keep DESIGN keymap jumps aligned with Activity |
| `17423c67` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | fix(browser-extension): stop runner tests timing out under CI load |
| `2afd519a` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | chore(quality): record relay sync integration test complexity |
| `e6bb65be` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | fix(pages): keep relay sync test aligned until org vault client lands |
| `0b2b878b` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | fix(quality): split relay classification rules under the module budget |
| `f68803a5` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | fix(pages): classify vault-relay sources for capability graph. |
| `ef4d82cf` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | fix(quality): split vault relay module and tighten unlock baselines |
| `506845ba` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | fix(ci): align transport op contract test |
| `e284e8bd` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | style: clear biome findings on the relay pull |
| `18b83cf2` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | docs(audit): re-grade ADR 0181 and walk evidence rows |
| `1c6c640d` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | feat(adr-0181): relay profile, org vault addressing, join snapshot sync |
| `b575fb19` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | fix(pages): walk tutorials on minimal and full profiles without AI |
| `05f90f8c` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | ci: build container image on pull requests without pushing |
| `0c73d702` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | fix(tutorial): skip model tours when support AI is off |
| `2395ce81` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | fix(pages): seed minimal tutorial vault with secret items |

### #795 (`origin/cursor/ci-cargo-setup-b359` → tip `f2c5debe`)

| SHA | Author (as shown) | Real producer | Subject |
| --- | --- | --- | --- |
| `f2c5debe` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | style(browser-extension): biome-format enqueue signature |
| `6fc83a0d` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | fix(browser-extension): give settle room under the enqueue wall-clock waiter |
| `cd485841` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | fix(browser-extension): keep runner idle polls under the vitest budget |
| `4afcd74a` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | fix(browser-extension): stop runner tests timing out under CI load |
| `8b877f1f` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | fix(pages): keep DESIGN keymap jumps aligned with Activity |
| `d9502744` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | chore(quality): record relay sync integration test complexity |
| `41e4746a` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | fix(pages): keep relay sync test aligned until org vault client lands |
| `a125d717` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | fix(quality): split relay classification rules under the module budget |
| `06479fbb` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | fix(pages): classify vault-relay sources for capability graph. |
| `5cdf0429` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | fix(pages): custom setup picks individual capabilities |
| `034abd84` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | chore(cursor): put cargo on PATH for vscode bash |
| `fc12cf17` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | ci: pin docker/build-push-action to v6.18.0 |

### #796 (`origin/cursor/checklist-walk-complete-b359`)

| SHA | Author (as shown) | Real producer | Subject |
| --- | --- | --- | --- |
| `a379d778` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | style(browser-extension): biome-format enqueue signature |
| `38b5f37f` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | docs(audit): drop self-referential tip SHA from #796 heading |
| `8f2606b4` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | docs(audit): include the tip-SHA ledger commit itself |
| `07a8d1a0` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | docs(audit): tip SHAs and counts after runner enqueue fix |
| `a14eee0c` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | fix(browser-extension): give settle room under the enqueue wall-clock waiter |
| `afb2ced4` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | docs(audit): record Tyler's no-rewrite provenance decision |
| `068ca92a` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | fix(browser-extension): keep runner idle polls under the vitest budget |
| `444610f4` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | docs(audit): provenance of Grok-labeled vs live commits on #776–#796 |
| `843b7ea4` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | fix(browser-extension): stop runner tests timing out under CI load |
| `ec3b448b` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | fix(pages): keep DESIGN keymap jumps aligned with Activity |
| `ee8cba1a` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | test(gateway): sign the JWT confusion cases with the real RSA modulus |
| `89cc560e` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | test(gateway): attack vault-relay mTLS admission and registration JWTs |
| `57ed7c22` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | fix(gateway): bind vault-relay registration JWTs to one owner |
| `02d99a9b` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | chore(quality): restore checklist quality baseline after restack |
| `a24ae54a` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | docs: refresh evidence index for org vault gallery |
| `7adb679b` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | fix(restack): restore org vault relay sync integration test |
| `03b7c800` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | fix(restack): align checklist tree with relay and guest walk baselines |
| `029b85d0` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | style(evidence): format org vault capture script |
| `ff66e648` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | docs: A2 org vault evidence and audit; P3 Vercel default-services to-do |
| `a42a5510` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | feat(app-core): send optional relay registration token on vault-relay client |
| `14d1cfd2` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | feat(gateway): verify vault relay registration JWTs and refuse forged role headers |
| `4cd58b16` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | docs(audit): mark relay mTLS and the owner namespace done |
| `a07cd2e7` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | feat(gateway): admit native relay peers with mtls_required |
| `b8ab12e8` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | feat(gateway): refuse a second owner kind on the same label |
| `afa30645` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | fix(quality): split relay harness under module budget. |
| `867e075c` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | style(pages): organize imports in support questions test |
| `a15c01fc` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | fix(pages): typecheck support questions recovery mock |
| `4b59f4f5` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | ci: run relay join against the gateway relay profile |
| `8fea587f` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | ci: run verify:relay-join on the journeys-1 shard |
| `ad0ef862` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | test(pages): join two browsers through the gateway relay |
| `c324735d` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | feat(gateway): advertise the relay profile and member publish policy |
| `7e8aead9` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | fix(tutorial): custom setup picks individual capabilities |
| `0c73067d` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | style: clear biome findings on the checklist diff |
| `278ac2b2` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | docs(audit): record the full tutorial profile walk |
| `83b82ace` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | fix(pages): resume a keyless guest tomb in the push-worker walk |
| `ea22ecd3` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | docs(audit): record checklist screenshots and seed walk items |
| `d0c18cce` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | feat(adr-0181): org vault directory and relay join walk |
| `425e446c` | Grok `<noreply@x.ai>` | `grok_labeled_replay` | fix(tutorial): keep the accounts filter off a secret-only vault |

### Static PWA / no default services (on top of #796) — PR #861

| SHA | Author (as shown) | Real producer | Subject |
| --- | --- | --- | --- |
| `1f5d4f6c` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | docs(audit): provenance for static-PWA stack after Grok 402 |
| `77823a46` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | fix(pages): stop stamping Identity/Host/daemon into the static app |
| `34eb310a` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | docs(audit): P3 is static Pages with no default services |
| `3bf9550d` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | remove Settings › Endpoints; operator docs; ADR 0090 |
| `bd0a9f07` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | pin Endpoints-removal SHA in provenance |
| `cad408d9` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | Vercelignore api-only + static-PWA evidence |
| `cb4cb95a` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | pin Vercelignore evidence commit in provenance |
| `353d7737` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | static-PWA screenshots and inventory residual note |
| `e7d30760` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | point evidence README at Vercelignore tip |
| `028c3035` | Cursor Agent `<cursoragent@cursor.com>` | `cursor_agent` | provenance for evidence and Vercelignore commits |

## Three-tier coding chain (Tyler, 2026-10-14)

**Order:** Grok Build CLI → Kimi Code CLI (K3) → Cursor. Rules:
`.cursor/rules/grok-build-first.mdc`, `.cursor/rules/kimi-first.mdc`.
Preflight: `scripts/dev/agent-coding-preflight.sh`.

1. **Grok Build** — `scripts/dev/grok-preflight.sh`, model
   `$(scripts/dev/grok-resolve-model.sh)` (baseline `grok-4.7`), then
   `scripts/dev/grok-headless.sh -p "…" -m … --always-approve --output-format json`.
   Auth: `XAI_API_KEY` runtime secret and/or `grok login --device-code`.
   Leave tier 1 on weekly limit, quota, 402, 403 credits, or 429.

2. **Kimi Code** — when Grok is exhausted, run `scripts/dev/kimi-preflight.sh`
   then `scripts/dev/kimi-headless.sh -p "…"` with **K3** (`-m kimi-code/k3`).
   Auth: `kimi login` OAuth, else `KIMI_MODEL_API_KEY` (not plain `KIMI_API_KEY`).

3. **Cursor** — when both CLIs cannot run. Security testing: **Grok 4.7** in
   Cursor; other work: **Composer** / **auto**. Record tier and reason in the PR
   Provenance section and log paths (`/tmp/grok-*.log`, `/tmp/kimi-*.log`).

Historical note: Grok Build returned HTTP 402 during the 2026-10 stacks above;
many commits labeled Author Grok were Cursor replays — see counts in this file.
Do not re-label commits; new work follows the tier chain.

Operator detail: [kimi-code-cloud.md](../operators/kimi-code-cloud.md).

### Cloud Agent auth durability (2026-10-08)

- Device OAuth (`kimi login`) authenticated a Cloud Agent VM under
  `~/.kimi-code/credentials/` (never commit or print tokens).
- Preflight + smoke used **K3** catalog id `kimi-code/k3` via
  `scripts/dev/kimi-headless.sh`.
- OAuth is **local to that VM**. A fresh Cloud Agent from the snapshot needs
  either another `kimi login` or a Cursor Runtime Secret `KIMI_MODEL_API_KEY`
  with `KIMI_MODEL_NAME=kimi-code/k3` (optional `KIMI_MODEL_BASE_URL`). Plain
  `KIMI_API_KEY` is ignored by Kimi Code.

Producer label `live_kimi_code`: Kimi Code CLI session produced the patch via `scripts/dev/kimi-headless.sh` with model **K3** (`-m kimi-code/k3`) after `kimi login` OAuth or `KIMI_MODEL_API_KEY`; logs under `/tmp/kimi-*.log` or the agent store.


### Identity and PWA backup stack — #1246, #1247, #1249, #1250, #1251

Codex produced and reviewed this stack with delegated Codex agents. Commits were
created through GitHub `createCommitOnBranch`, without author overrides, for
verified GitHub signatures. They are not Grok or Kimi output. The environment
used for this task has neither `grok` nor `kimi` on PATH (checked 2026-10-14);
no alternate CLI authentication or billing was configured. Implementation was
already committed when the documentation-only tier-chain update reached main
at `aaa832e9e`. Codex continued verification, review and verified restacking.

### BYO AI and browser-native Tailscale follow-up

Codex and delegated Codex agents produced this follow-up. The recorded task
preflight found no authenticated Grok CLI and no Kimi executable, so no
Grok/Kimi output or model identity is claimed. Commits use GitHub
`createCommitOnBranch` without author overrides. Tailscale implementation
research applies the official `tailscale/tailscale-skill` instructions and
current documentation, the official `@tailscale/connect` browser SDK source,
and tailcat's browser WASM example. Verification results distinguish real
vendor protocol/client execution from deterministic local service fixtures.

### Browser-native GitHub integration follow-up

Codex and delegated Codex agents implemented and reviewed the direct GitHub
App REST/crypto core, registration custody, and App/token configuration entry.
Task preflights again found no authenticated Grok session and no Kimi binary.
GitHub GraphQL `createCommitOnBranch` produced signed commits, independently
checked for parent, tree, inventory, and verified signature before promotion.
Actual Chromium protocol tests use a local HTTP GitHub fixture; desktop and
touch UI evidence uses two actual static production builds. Neither is a live
GitHub account registration or installation claim. The evidence gallery also
records a rejected plaintext-storage fixture as unverified, rather than as a
passing saved-App check. Repository selection and backup caller migration are
separate implementation slices and are not completed by the entry UI.

### Verified shared AI connection projection

Codex and delegated Codex agents implemented and independently reviewed the
shared AI proof projection correction in signed commit
`ac5d3c43ed68ca9032e7f107ed5df6ef47a7a4b6` (PR #1297). Grok authentication
remains unavailable and Kimi is absent; no alternate tool output is claimed.
Actual desktop and touch Chromium journeys use two real production builds of
the declared loopback verification profile, a real PIN-sealed vault, and a
real HTTP/CORS fixture: 60 behavioral checks, 16 inference requests and 16
preflights, including four deliberate wrong-key refusals. This proves the
configured-endpoint/proof/custody flow, not a hosted vendor account or global
integration completion. The gallery retains the misleading unsaved hosted
status and sticky earlier failed-Test flash as unresolved UI findings.
Lossless WebP gallery compression independently compares every decoded pixel.
Full package runs and required security landing checks remain separately
reported; focused tests and browser results are not an aggregate pass.

### Live Tailscale browser-node status

Codex and delegated Codex agents implemented and independently reviewed the
current browser-node authority projection in signed commit
`1093cff9e0e0a194b2aea529dfa3351d1770c92a` (PR #1301). Grok authentication
remains unavailable and Kimi is absent. Before and after were actual matched
loopback production builds of signed parents plus exact frozen overlays;
their trees were independently matched to the later verified signed commits.
Official pinned WASM, real Headscale/DERP and a native peer produced 120 checks
across desktop and touch, including live membership before any service GET,
actual peer HTTP 200, current home/navigation and worker termination on stop,
vault lock and capability withdrawal. Transparent provider-side fixture edges
and a DERP SPKI-only test exception are explicit; no hosted account, ordinary
hosted PKI, general VPN or universal integration completion is claimed. All
12 gallery viewports retain exact native pixels, and full-sheet lossless WebP
compression independently preserves every decoded pixel. The final portable
after-capture replay passed another 66 checks, excluded from the primary 120.
Full repository quality and public static verification passed separately;
required CI and complete security landing gates are not inferred from these
results. OAuth-management UI removal and remaining provider gaps continue in
separate slices.

### Peering-only Tailscale primary configuration

Codex and delegated Codex agents implemented and independently reviewed signed
commit `540dbb8eadb4e4e1501174552c3fe5123f754726` (PR #1303). Grok
authentication remains unavailable and Kimi is absent. The primary page now
composes browser peering without OAuth app management or external-device
provisioning. Actual before/after production builds of the declared loopback
profile produced 184 desktop/touch checks, real official WASM control/DERP
exchanges, native-peer HTTP 200, cold document reload and PIN unlock, and
reconnect without another auth key. The after build compiled the exact parent
plus frozen five-file overlay; its tree and bytes were independently matched
to the later signed commit. All eight gallery viewports and both complete
lossless WebP sheets preserve decoded native pixels exactly. Full original
metrics and build receipts are retained. Provider-side fixture CORS/TLS edges
and a DERP SPKI-only Chromium exception are explicit; no hosted tenant,
ordinary hosted PKI, installed-offline test or general VPN claim is made.
The initial hostname-helper diagnostic is preserved and excluded from 184.
Focused tests, actual browser proof and full package runs are separately
reported. Non-2xx service-probe presentation and other audited integrations
remain unfinished; this entry UI does not complete them or waive landing CI.

### Actual Tailscale service failure and retry

Codex and delegated Codex agents implemented and independently reviewed signed
commit `c55d195c8b5f84b400dde7efaf78430df4da9a37` (PR #1306). Grok
authentication remains unavailable and Kimi is absent. The shared service
probe accepts only 2xx, places service errors beside Test, routes the existing
notification, clears stale outcomes and preserves independent node membership.
The saved public-field readiness ordering exposed by regression tests is fixed
without weakening its assertion. Final validation includes 157 focused tests,
5,520 Pages and 114 server tests, both package types, full repository quality,
two actual final builds and zero public capability graph violations/mismatches.
Actual before/after Chromium journeys pass 108 checks (52 before/56 after),
with real native-peer 404s and 200 retries through unchanged official WASM,
Noise and DERP. The eight native gallery viewports and two complete lossless
WebP sheets preserve every decoded pixel. Full original metrics and exact
historical-build equivalence receipts remain intact. Superseded two-file
AFTER52, the harness diagnostic and initial cold-test failures are excluded
and retained privately. Provider-side CORS/TLS fixture edges and a DERP-only
SPKI exception are explicit; no hosted-account/ordinary-PKI, installed-offline
or general VPN claim is made. The source commit was created with the reviewed
GraphQL publisher using recovered CLI authentication and independently
verified through the connector; no queued Actions result was promoted. Other
native provider and broker-backed identity gaps remain separate work. Required
CI, signed bottom-up restack and security landing gates remain mandatory.

### Native 1Password assets, worker boundary and item codecs

Codex and delegated Codex agents implemented and independently reviewed these
small signed slices. Grok authentication remains unavailable and Kimi is absent.
The MIT `@1password/sdk-core` 0.5.0 pin, unchanged asset hashes and build helper
were published in `30a74f480d8a367e977287946f70761f32fe4cad` (PR #1308).
The guarded HTTP boundary followed in `eced3d8f48892f61f0c3c67cc3c2ac585086021a`
(#1309), and the worker/loader in `0c0f025d569f716ff4055b437e50f909eeb25284`
with the CSP correction `5d0389c6e29836948af5fc3f1aa29ae62cb9f9fc` (#1310).
Actual official-WASM source proof passed 47 checks with zero failures across six
workers and zero CSP violations, covering owned HTTPS 401 responses and
cancellation. This was not positive provider authentication or a production
capability-graph result. Private proof compilations did not activate product
assets, factory, UI, build emission or cache ownership; those remain unfinished.
Native read mapping was published in `7c55012fae082aedb59c16ba1bd658ff24368721`
(#1311), and metadata-preserving write codec in
`326a97f0772b1b12c86799ac6b70224966156a20` (#1312). Pure codec fixtures establish
shape, identity and preservation, not hosted access or encrypted provider CRUD.

### Shared secret-backend ownership and inherited formatting

Codex and delegated Codex agents implemented and independently reviewed session
lifetimes in `d601301caea81f3f259c83b3ad1337927c269d5b` (#1313), owner transport
cancellation in `2ee8830c73ba729d4420953c258caf0de70120c9` (#1314), and early
vault-authority cancellation in `6f5cb1eea850fa071d8d0dd9ef8608c770beedc3` (#1315).
Grok authentication remains unavailable and Kimi is absent. The transport slice
passed 315 backend tests, including four real socket aborts; early authority
passed 330 backend tests including 15 new cases using cooperative fetch/Promise
fixtures. These are scoped backend results, not whole-core or browser proof.
`61be3e73c251e0efb5897f36a13978a0b2422cae` (#1316) fixes one inherited Rustfmt
hunk; its pinned formatting gate passed, while native tests and Clippy remain
unproven. Across both groups, reviewed GraphQL publishing, verified signatures
and independent exact-byte readback preceded adoption. SDK activation, positive
hosted 1Password authentication/CRUD, cloud transport and UI completion remain
open; required CI, full security landing gates and verified restack remain due.

Controlled exact-handle closure in
`59158ea7a6230468026af84138ed3ca113beefed` (#1317) distinguishes local removal
from provider-ended sessions and preserves the default AbortError. Its 334
backend tests include 16 registry cases; these are scoped fixtures, not mounted
UI or native-provider completion.

Distinct runtime admission in
`7264241ca0a879b3ee90170073c2421a50ae2a7c` (#1318) withdraws the exact held handle
synchronously and publishes through the existing SDK-free seam revision.
Its 355 backend tests include 21 new cases covering normal probe disposal
versus provider loss. This continues the same reviewed Codex fallback and
signed GraphQL/readback provenance. CI remains queued; the known formatting
hunk is corrected, without implying native CI or full security/restack success.

### 2026-10-15 — PWA secret-backend ownership and native 1Password

Codex and delegated Codex agents continued under the recorded fallback: Grok
authentication and Kimi were unavailable. Each scope was frozen, signed through
GitHub GraphQL without an author override, checked for its sole parent and
exact published tree/blob bytes, and opened as a separate stacked PR before
the next implementation scope began.

- #1320, `58ed49b93c9603edc5539609b46db489baf7dc0c`: caller cancellation before
  vault capture and exact per-connection pending ownership; 22 new tests,
  377 backend tests passing. Controlled vault/fetch fixtures establish
  ownership; they are separate from the earlier actual socket proof.
- #1321, `33b8bb39f5eb8bc775e5812e78e29d33a5527cfa`: captured external-feature
  lifetime withdraws idle admission and cancels probe disposal. Two parent
  regression failures were preserved; 20 new tests and 397 backend tests pass.
  Controlled lifetime fixtures do not establish browser or hosted access.
- #1322, `3dc1a05ff69c026852ae14a67f5a728e207039d5`: standalone native 1Password
  authentication/read adapter, actual SDK-loader default, exact vault/item
  probes, original opaque sessions and idempotent native cleanup. Its 52
  injected-client cases and all 449 backend tests pass; writers are absent
  in that exact source slice. It is not yet selectable configuration.
- #1323, `5aa2d136b6d53ce04a710d9a67b9aa7d05c39a37`: native create/update/delete
  command mapping, full-item metadata/version preservation and bounded backup
  payloads. There are 23 new mutation cases plus two read-publication
  regressions; 77 native adapter cases and all 474 backend tests pass.
  Injected native results prove mapping/lifetime behavior, not hosted writes.

Both typechecks, exact-file lint/structural/security rules and full quality
passed for these scopes. Focused Gitleaks scans accounted for all source
bytes and detected generated negative controls before and after scanning.
The bounded published-source review at `a39b16ea` visited 447 files with
11 AST rules. Gitleaks directory mode omitted one 3,874-byte test filename;
the unchanged bytes were scanned explicitly via stdin. No findings were
reported under those rules. This is scoped SAST, not full security completion.

Native authentication/read and mutation adapters are implemented but remain
unactivated. Injected responses do not prove encrypted SDK authentication or
hosted CRUD. The earlier 47 actual Chromium/WASM denial/cancellation checks
remain separate. Configuration, production transport/cache/asset ownership
and UI activation, React ownership/status consumers, other audited providers,
required CI, full security gates and verified bottom-up restacking remain open.

Codex and delegated Codex agents implemented and reviewed the mounted-action
slice, PR #1325, `fb53fee28c7d3943c4120232d09a0161b2f5cc41`, under the
recorded fallback: Grok authentication unavailable and Kimi absent. Its 51
affected tests (20 new), both typechecks, static rules and full quality
(546 script plus 17 security tests) passed. Scoped scans of the two frozen
files accounted for all 17,780 bytes with zero findings. The actual gallery
uses parent `80e245ef` and after `fb53fee2` builds; the approved after trace
confirms six successful owned-REST logins, not native 1Password or hosted
authentication. The original phone post-HTTP200 abort remains unresolved and
is not retrospectively passed; two Node instrumentation warnings are retained.
Pending caller cancellation, native activation, remaining integrations,
required CI, security landing gates and verified restacking remain OPEN.


Codex and delegated Codex agents implemented and reviewed the retained-session
slice, PR #1327, `b3a322b5382f1dde8584410a39adcf8a3bd8b830`, under the
recorded fallback: Grok authentication unavailable and Kimi absent. Its 66
UI tests across six files (15 new), both typechecks, static rules and full
quality (546 script plus 17 security tests) passed. Scoped scans covered all
38,268 bytes in four frozen files with zero findings and detection controls.

The actual desktop/touch comparison uses before `fb53fee2` and after
`b3a322b5` immutable builds with the same executed harness. Before, each
pending socket stayed open through deliberate release and made one next
authenticated GET; after, both sockets closed before release with zero next
GETs. Four later logins completed with retained List, real feature disable,
local Copy and reconnect. Four native images document unchanged page context;
protocol traces establish the lifecycle change. These are owned REST-fixture
journeys in a declared loopback profile, not hosted/native-SDK authentication
or all-integrations completion. Two expected pre-response cancellations were
observed; there were no unexpected errors or Node warnings. No live owned
processes/listeners/workers remained; two terminated zombies are separate.
The prior action-only post-200 abort remains a separate unexplained record.
Native activation, remaining callers/providers, required CI, full security
landing gates and verified bottom-up restacking remain OPEN.


Codex and delegated Codex agents implemented and reviewed the on-demand cache
root fix, PR #1328, `8d20c9f6d0a108004b74f79e981f7b7b4b7eb30f`, under
the same recorded fallback. One production line and eight new regression cases
preserve known-owner detection, core roots and static-required assets. The
unchanged-parent emitted-shape case reproduces unwanted SDK assets; its static
countercase passes. Final 33 graph/plan-assets tests, Pages types, exact static
checks and full quality (546 script plus 17 security tests) pass. The initial
sandbox failure is retained; the existing local fixtures pass with required
process/socket permissions. Scoped unchanged-rule scans cover all 12,315 bytes
in two files with zero findings and working controls. This is cache-plan unit
behavior, not installed-SW/download/native-provider activation proof.


Codex and delegated Codex agents implemented and reviewed the critical mounted
Probe/Connect caller slice, PR #1336,
`9b8bb3a436c16cc2b1fb79100bf19ad7d9c8804c`, under the recorded fallback:
Grok authentication unavailable and Kimi absent. Its 78 UI tests across seven
affected suites (12 new), both typechecks, exact static checks and full quality
(557 script plus 17 security tests) passed. Scoped unchanged-rule scans covered
all 29,536 bytes in three frozen files with zero findings and working detection
controls. This is bounded source SAST, not full security completion.

The actual desktop/touch Test journey used immutable before `a19ccfa8` and after
`9b8bb3a4` builds with the same 18 frozen harness/helper/package inputs. Before,
both held login sockets stayed open after departure and continued to one
authenticated GET after deliberate release. After, both sockets closed before
release with native pre-response cancellation, no HTTP status/finish and zero
next GETs; fresh unheld Test controls verified through actual HTTP in both
widths. Four lossless native viewport images, exact identities, hashes and
measurements are preserved in
[historical evidence](https://github.com/OpenSesame-Labs/OpenSesame/tree/fd554446241e32962e82763ddb772f9420096279/docs/evidence/2026-10-15-secret-probe-cancellation/). All 250 outputs per phase
and all frozen inputs remained unchanged, with no runtime errors, page overflow,
live owned processes or planned listeners. These are controlled Infisical
UniversalAuth HTTP observations, not native 1Password SDK or hosted-account
authentication. No application backend, extension, interception, raw storage
seeding or component-state injection was introduced. Remaining callers/providers,
required CI, full security landing gates and verified restacking remain OPEN.


Codex and delegated Codex agents implemented and reviewed native 1Password
configuration PR #1338, `a50848dfe53fdaffc220604e55fc42697573f617`,
under the recorded fallback: Grok authentication unavailable and Kimi absent.
Its 619 core tests across 39 suites and 109 UI tests across nine suites
(35 new tests combined), both typechecks, static checks and full quality
(557 script tests plus 17 security tests) passed. Scoped scans covered all
64,975 frozen bytes with working controls and no findings. MJS used explicit
byte-identical TypeScript parser aliases; JSON received syntax checks only.
Signed readback preserved the source tree on a fresh stack branch after an
externally merged parent; the rejected force-reset was never executed.

Budget PR #1339, `dbb1729bed6229c1b74f8841873f209e110e9fb6`, changes
only ordinary Pages total/JS/gzip ceilings to 21050/7320/2210 KiB, about 1%
headroom above measured native-feature cost. CSS, largest asset, other app and
hardened data are unchanged. All 57,219 JSON bytes passed scoped Gitleaks
checks with working controls; metadata is not semantic AST proof. The first
unchanged-budget subpath result remains RED.

The actual desktop/touch UI retained saved Connect across an archive swap,
completed a controlled Connect REST GET, showed native-first partner and shared
BYO fields, and restored partner Save/cold unlock with a blank token input.
Twelve no-action checkpoints loaded no native SDK assets, workers or API calls.
Eight lossless native images and qualified root/subpath/minimal/family static
receipts are in [historical evidence](https://github.com/OpenSesame-Labs/OpenSesame/tree/fd554446241e32962e82763ddb772f9420096279/docs/evidence/2026-10-15-onepassword-native-configuration/).
The first separate native SDK action run FAILED before its intended fixture 401;
no native action completed. Its complete gzip HTTP 200 then unexpected abort
remains under diagnosis, with immutable failed receipt and clean owned closure.
PR #1338 remains draft. Positive native/hosted authorization, decryption/CRUD,
strict hosting, caching/offline behavior, remaining integrations, required CI,
full security landing and verified restacking remain OPEN.

Codex and delegated Codex agents implemented and reviewed Infisical lifetime PR
#1345, `c3221680d0379d4e7bc0e50b60e315935de2fcdb`, under the recorded fallback:
Grok authentication unavailable and Kimi absent. Issued UniversalAuth lifetimes
now own deadline checks, idle withdrawal and captured-session termination for
HTTP 401 or exact 403 TokenError; PermissionDenied remains nonterminal. Manual
opaque tokens receive no invented TTL. The 114 scoped tests across eight files
include 32 lifetime and two credential cases, each credential case covering
three variants. Core types, exact static checks, anti-slop baseline and full
quality passed. Scoped unchanged-rule scans covered all 27,026 bytes in four
files, including 10,915 production bytes, with zero findings and working
controls. Response-based/fake-clock cases are not hosted-account or browser
proof.

Test-only PR #1346, `fffa80768d3df40f67447d33652568968bca8a6e`, added seven
actual-provider/production-vault composition cases among 162 scoped tests across
11 files; these totals overlap the earlier supporting suites and are not
additive. Its one 9,809-byte test file passed scoped scans with working
controls, core types, static/baseline checks and full quality. Both source
slices recorded 557 script and 17 security quality tests. The runtime fixture
uses controlled Responses, fake clocks and a Map-backed filesystem consumed by
production vault code, not physical browser OPFS.

Evidence-only PR #1349, `bb350569e2020b945823f8210af12715a19e99ee`, preserves
[the Infisical
observations](https://github.com/OpenSesame-Labs/OpenSesame/blob/fd554446241e32962e82763ddb772f9420096279/docs/evidence/2026-10-15-infisical-lifetime/README.md). Fresh
normal/root/subpath artifacts were compiled from fffa; all 14,868 tracked input
identities were restored, independent graphs passed and the five ordinary
budgets remained unchanged and passed. Old subpath is a508; old root is dbb.
Terminal execution used ef70 with only CI delivery and two JSON-whitespace
maintenance changes, without relabeling the fffa artifacts.

Both original paired idle phases remain FAILED. Desktop branches showed the old
session stale past TTL and new withdrawal first observed after 5,991 ms on
subpath and 5,998 ms on root. Subpath touch failed on the new Connect; root
touch failed on the old dbb Connect before selecting the new artifact. Each
received HTTP 200 and full expected 14 decoded/24 encoded bytes, then an
unexplained native abort without completion. Full byte counts are not
application EOF proof, and the cause remains unresolved. A separate after-only
touch/subpath observation passed strict admission and withdrawal after 5,989 ms
with no idle I/O, interaction or navigation; it does not clear either earlier
failure.

Both after-only terminal matrices passed on desktop and actual touch, at root
and subpath: 12 cases and 12 strict positive admissions, 80 native requests, 76
native finishes and four precisely established selected-401 body cancellations.
Cancellations remain labeled canceled, never native finished. All four
TokenError403 and four PermissionDenied403 responses finished; PermissionDenied
retried HTTP 200 with the same auth and no new login. Terminal 401/TokenError
recovery obtained fresh auth. Twelve expected browser denial-console messages
matched their exact selected cases; there were no unmatched console/page errors.
All successful-200 and unrelated aborts remained strict failures.

Six lossless WebPs total 85,894 bytes and independently decode through Pillow
and FFmpeg to the unchanged native PNG RGBA pixels. No crop, resize, stitch or
overlay was applied. Four published text files, 64,965 bytes, passed
unchanged-config Gitleaks with before/after detection controls; JSON is not
claimed as semantic AST proof. JSON identity, changed-file lint, generated
index, whitespace and selected-original preservation checks passed. The initial
full `pnpm lint` stopped on nested-git EPERM before tests and remains recorded;
root reran that identical command with the required local process capability and
obtained exit zero, 107 existing tests and changed-file lint over 535 files
without fixes.

These are controlled real Infisical HTTP/CORS and PIN/physical-OPFS
observations, not hosted authentication or all integrations working.
Verification used localhost, header security false and blocked service workers;
normal build header security was also false. Existing helpers enter
Features/detail through History API/popstate; configuration/actions use actual
controls. No application backend, extension, interception, fake SDK, storage
seed or component-state injection was introduced. Captures are viewports, not
full nested-form coverage. Recorded runtime closures left no owned
processes/listeners. Strict hosting/CSP/SW/offline behavior, required CI, full
security and landing remain separate gates.

Under the same recorded fallback, PR #1353,
`1a644d1d72a8ec31d70349074aba01fa395d6363`, changed one 8,508-byte source file.
Conditional assignment of RequestInit.body for a present body fixes the actual
client CLI TS2375 exact-optional-property failure without adding undefined to
bodyless requests. All three typechecks, 16 existing controlled HTTP tests, full
pnpm lint (107 existing tests and 535 files), full quality (557 script plus 17
security tests), and the unchanged baseline with zero regressions passed. The
existing eleven AST rules and Gitleaks covered all 8,508 source bytes with zero
findings and before/after detection controls. The initial spread/strict-check
failure and Cargo PATH diagnostic remain preserved. This uses the recorded
fallback, not a new preflight claim. Actual CI is still pending; inherited/stale
browser gates remain open.

### Round 8 stack (P8-1–P8-4, 2026-10-17)

Policy: Round 8 implementation edits via **Grok Build** (`grok-4.7`, subscription
`~/.grok/auth.json`); Cursor orchestrator commits, tests, and PR provenance only.
**Kimi K3** authored the first P8-4 commit (`11a508953`) before the Grok-only
correction. **Cursor tier 3** authored P8-2 harness fix `a1c7a7ce9` (and cherry-pick
`79f7d53ad` on P8-3); Grok Build review session `01a147fc-8297-7f82-ba33-40cdd2710b2e`
**accepted** that harness change without redo. Grok redo commit `7d146efb6` on P8-4
after audit **redo** of `11a508953`. P8-1 feature commits via Grok Build; post-Grok
bundle/ceremony-kit fixes on P8-1 by Tyler Kendrick (tier 3), as listed on PR #1457.

**P8-5 (F5)** — Grok Build `grok-4.7` (`scripts/dev/grok-headless.sh`, subscription auth);
Cursor orchestrator verified `verify:cli-public-site`, lint, commit `49c7683d7`, PR #1466.

**P8-6 (F7)** — Grok Build `grok-4.7` (session ended after implementation landed; stuck
orchestration loop killed at ~83m with empty stdout log); Cursor ran
`verify:sw-dirty-edit`, app-core/pages unit tests, `pnpm lint`; no baseline loosening
(`quality-baseline.json` tightened 646→645).

**P8-1/P8-2 visual evidence (four install profiles)** — Grok Build `grok-4.7` in worktree
`/tmp/p8-evidence-round8`; commit `25df77af0` on `cursor/p8-evidence-galleries-8ad8`;
galleries under [historical evidence](https://github.com/OpenSesame-Labs/OpenSesame/tree/fd554446241e32962e82763ddb772f9420096279/docs/evidence/2026-10-17-p8-1-portable-drop-profiles/) and
[historical evidence](https://github.com/OpenSesame-Labs/OpenSesame/tree/fd554446241e32962e82763ddb772f9420096279/docs/evidence/2026-10-17-p8-2-peer-trust-profiles/).

**B8-1 (F11a)** — Grok Build `grok-4.7`; commit `6da1361bc` on `cursor/b8-1-siop-ambient-notice-8ad8`; PR #1470 stacked on P8-6.

**P3 (F9/F10)** — Grok Build `grok-4.7`; commit `0c8a032ef` on `cursor/p3-danger-travel-drop-8ad8`; PR #1472 stacked on B8-1.

**D8-1 (F6)** — Grok Build `grok-4.7`; commit `30aef4fca` on `cursor/d8-1-cli-approval-webauthn-8ad8`; TS + `cargo test -p opensesame-cli-app-integration` (54) PASS locally; **runtime verify blocked** (no live daemon ceremony in cloud agent).

**Global title bar (2026-10-20)** — Codex implementation and verification in an
isolated worktree, following the supplied approved screenshot. The coding
preflight reported no Grok subscription auth and no Kimi executable; neither
CLI could implement this change. The shared header, responsive arrangement,
geometry checks, and visual evidence were implemented by Codex.

**Lockscreen screenshot parity (2026-10-20)** — Codex implementation and
verification in an isolated worktree from `a03b3c5094b7aeef0a18ff0aabe31c023925a43b`.
The coding preflight reported missing Grok subscription auth and no Kimi
executable. Codex implemented the supplied lockscreen reference, preserving
animated rings, wordmark and successful-unlock doors, and captured separate
base/changed production builds for desktop, tablet and phone evidence.

- 2026-10-23: Latest-main integration and CI follow-up. Grok Build subscription authentication was unavailable and Kimi Code was not installed; bounded Codex agents prepared isolated slices, with root review, canonical checks, and GitHub-signed stacked publication.

- 2026-10-25: Codex Security Cloud finding remediation in an isolated worktree from `aad2c85b`. Grok subscription authentication was absent and Kimi Code was unavailable. Codex agents implemented separate boundary fixes with independent candidate reviews and focused validation. The operator approved exact organization-bound issuer authorization and independent local autofill approval.

## Security alert remediation, 2026-10-25

The Codex session produced the dependency and assertion-validation changes on
`fix/security-alerts-20261025`. The repository coding preflight found no Grok
subscription authentication and no Kimi executable in this managed environment;
Codex implemented and reviewed the changes directly. No Grok or Kimi authorship
is claimed. Validation evidence is retained outside the checkout.

## OpenSSF Scorecard remediation, 2026-10-26

Codex agents refreshed the independent fuzz lock, expanded the tracked-input
OSV gate, and prepared downloadable release signatures and maintenance guidance.
The coding preflight found no Grok subscription authentication and no Kimi
executable; Codex implemented and reviewed these slices in an isolated worktree.
No Grok or Kimi authorship is claimed, and no advisory exceptions were added.

The follow-up pins real upstream TOML-consumer fixes, removes unsupported Go
OpenPGP source with verified upstream-subset maintenance and a mandatory package
advisory audit, requires patched Go 1.26.10, and removes a yanked Rust dependency
version. Codex agents also corrected three stale security-test expectations and
prepared integrity-pinned cloud tooling. Native crypto/relay, parser and binding
generation checks accompany these changes; public scoring and live repository
protections are reported separately from local verification.

The separately pinned native Tailscale compiler lacked the new crypto/x509
distrust fix. Codex verified upstream Go 1.27.3 and its certificate-chain
filter, updated immutable compiler hashes, and rebuilt the native distribution.
The advisory gate now also inventories that compiled Go standard library;
its real pre-fix scan rejected Go 1.27.2 with GO-2026-6809.
The exact native WASM package audit also exposed affected SSH imports; verified
composition requirements update maintained Go modules and their required MVS
dependencies while preserving immutable upstream source files. A mandatory
package-graph audit complements the native standard-library inventory.

### 2026-10-25 — Trunk CI and immutable artifact promotion

The user authorized implementation of the reviewed CI proposal. An isolated
worktree from `aad2c85b4b567fd632d0e409d53d17bb66e8fba4` was partitioned among
ChatGPT agents for integration/qualification, candidate verification, build and
publication, and scanner/release-gate changes. The parent integrated and reviewed
the resulting workflow graph and negative controls. Cursor-hosted Grok/Kimi
coding tools are not installed in this environment. Validation results and live
activation limitations belong in the implementation PR; a local test pass is
not a claim that hosted release qualification or deployment has occurred.

The implementation was subsequently restacked onto `427d8921cbd6b70dbfef76956a37373417387a23`, preserving concurrent dependency, serial CPU-budget, rootless DBus and browser-security fixes. The implementation PR distinguishes validation of the original and current bases.

### 2026-10-26 — CI failure and review follow-up

The user requested fixes and merge of PR #2195. The live CI log identified the
unsigned implementation commit as the preflight failure; the PR also remained a
draft. Codex agents repaired both subsequent review findings: generated candidate
output names containing digits, and the placeholder OSV checksum introduced by
Copilot Autofix. Regression tests exercise the actual candidate output inventory,
output-injection refusals, pinned Linux scanner downloads, and verified binary
overrides. OSV v2.5.0 pins were compared against the official release metadata,
checksum asset and published provenance subjects. The coding preflight reported
missing Grok subscription authentication and no Kimi executable; no Grok or Kimi
authorship is claimed. Signature, required-check and scanner integrity policies
remain enforced. Test results and the authenticated signing prerequisite are
recorded in the PR; no hosted qualification or merge is claimed from local tests.

### 2026-10-29 — Build-only trunk integration

The user requested affected-graph compilation as the only trunk gate, with
static checks in Git hooks and tests in environment delivery. Codex agents split
build planning, hooks, auxiliary CD triggers and workflow contracts in an isolated
worktree, based on the supplied `51180167f` checkout. Grok subscription auth was
absent and Kimi was unavailable; these edits are Codex output. The cached
`origin/main` was older than the supplied checkout and the environment proxy
could not fetch GitHub. The connected GitHub API later confirmed main had four
newer commits; the added CUA browser gate is preserved in development/prerelease
qualification. The initial connector lacked the required `createCommitOnBranch` operation;
no unsigned replacement was submitted. On the user's publication follow-up,
shell network/authentication recovered and GraphQL became available. The change
was rebased onto `ae450dbce`, preserving newer connector/dependency work, and
review identified and repaired Cargo's renamed-workspace dependency selection.
The implementation PR records final validation and hosted publication results.

## OpenSSF Best Practices rebase, 2026-10-26

Kimi Code K3.1 (`kimi-code/k3.1`, upstream `k3.1-pro`) rebased
`docs/openssf-best-practices` onto current `main` and resolved one
`SECURITY.md` wording conflict by keeping the base's direct advisory link and
the branch's fallback contact and response commitment. The focused
`ReleaseNotes.test.tsx` suite passed all three tests. Kimi also restored the
intended seven-file diff after an unrelated draft stack displaced the branch;
the displaced commit remains recoverable in the originating repository.
