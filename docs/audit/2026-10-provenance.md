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

The per-commit inventory for the full stack lives on branch
`cursor/verification-audit-b359`; this copy on `main` holds the producer
vocabulary and routing rules that apply repo-wide.

## Producer labels

| Label | Meaning |
| --- | --- |
| `live_grok_build` | Grok Build session produced the restack/patch (session logs under the agent store / `/tmp/grok-*.log`); the commit was still created via local `git commit` with Author Grok (committer Cursor Agent). |
| `grok_labeled_replay` | Cursor agent (or a git cherry-pick/soft-reset) produced or re-applied the tree and stamped Author Grok. Includes post–usage-exhaustion work and batch replays. |
| `live_kimi_code` | Kimi Code CLI session produced the patch via `scripts/dev/kimi-headless.sh` with model **K3** (`-m kimi-code/k3`) after `kimi login` OAuth or `KIMI_MODEL_API_KEY`; logs under `/tmp/kimi-*.log` or the agent store. Commits may still be created locally with honest Author/committer metadata. |
| `cursor_agent` | Author and committer are Cursor Agent. Honest post-exhaustion authorship. |

## Exhaustion evidence

Grok Build returned HTTP 402 `Grok Build usage balance exhausted` during the
#794 restack (after #793 went green), with ~95 model calls on `grok-4.6-build`
in that session (`/tmp/grok-restack-tail.log`). Confirmed again on both device
OIDC (`env -u XAI_API_KEY`) and with `XAI_API_KEY` set on 2026-10-08 ~09:17 UTC.
After that point, commits labeled Grok were not live Grok. Retried once via
`scripts/dev/grok-headless.sh` for the static-PWA stack on 2026-10-08 ~15:14 UTC
— again HTTP 402 (`/tmp/grok-static-pwa-attempt.log`). That stack is Cursor Agent.

## Kimi vs Grok vs Cursor (Tyler, 2026-10-08)

**Remaining automation should go through Kimi first:** run
`scripts/dev/kimi-preflight.sh`, then `scripts/dev/kimi-headless.sh -p "…"`
with **K3** pinned (`-m kimi-code/k3`). Auth order is OAuth from `kimi login`, else
optional Runtime Secret `KIMI_MODEL_API_KEY` (not plain `KIMI_API_KEY`).

Use **Cursor Agent** only when Kimi cannot run (quota/payment/auth failure
after preflight, or headless `-p` errors that are not fixable in-env). Record
where and why in the PR Provenance section and any `/tmp/kimi-*.log` path.
Grok Build stays available but was exhausted for the 2026-10 stacks above;
prefer Kimi over re-labeling commits as Grok.

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

