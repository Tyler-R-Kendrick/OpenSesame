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
