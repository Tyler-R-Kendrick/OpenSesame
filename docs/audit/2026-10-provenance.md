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

