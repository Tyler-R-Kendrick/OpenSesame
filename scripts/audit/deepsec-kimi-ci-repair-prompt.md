You are repairing CI on one branch of the OpenSesame deepsec P0 fix stack. You MUST make all code and config edits yourself in this worktree (no hand-off).

## Context
- Repository: OpenSesame (TypeScript + Rust monorepo). Read AGENTS.md at repo root.
- This worktree is checked out to branch: **${BRANCH}**
- Draft PR: **#${PR_NUM}** (stacked; never merge, never mark ready).
- Required checks: TypeScript (includes `pnpm quality:gate`), Bundle budgets, Rust.

## Known failure (TypeScript / quality gate)
CI job "TypeScript tests" failed on `pnpm quality:gate`:
- File `packages/app-core/src/lib/vault/unlock-methods.ts` improved: max-lines **577 → 575**
- Ratchet rule: commit tightened `tools/quality/quality-baseline.json` (**575**, never raise budgets).
- Fix command when deps exist: `pnpm quality:gate --update` (only records improvements).

## Stack (base → head) — propagate ratchet upward if missing on this branch
`main` → #831 → #835 → #836 → #837 → #838 → #840 → #850 → #849 → #867 → #870 → #871 → #869 → #868

Branches (newest at bottom):
- `cursor/deepsec-fix-afe9924a15cb3b16` (#871 PIN wrap) — ratchet commit may already be `90bb12cf`
- `cursor/deepsec-fix-c1b0ae42617f6fd4` (#869 startup env)
- `cursor/deepsec-fix-08f341a1caedad41` (#868 credential helper PATH) **← this worktree if BRANCH matches**

If this branch is above #871 in the stack, ensure it includes the quality baseline ratchet from `cursor/deepsec-fix-afe9924a15cb3b16` (cherry-pick or equivalent edit).

## Your tasks
1. `git fetch origin` and confirm you are on `${BRANCH}`.
2. If `node_modules` missing, run `pnpm install` (use existing pnpm store; no sudo).
3. Fix quality gate and any other failures scoped to this branch only.
4. Run `pnpm quality:gate` (and targeted tests if you changed behavior).
5. **Small commits** (e.g. ratchet separate from product code). Push: `git push -u origin ${BRANCH}`.
6. Do **not** merge, force-push, or raise quality/bundle baselines except tightening recorded max-lines.

## Rules
- Subscription Kimi OAuth only — do not set API keys.
- No sudo. No budget/baseline raises.
- One logical change per commit.

When finished, print exactly:
KIMI_CI_REPAIR_DONE branch=${BRANCH} pr=#${PR_NUM}
