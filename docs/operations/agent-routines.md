# Agent routines — standing automation without GitHub Actions

This repo intentionally has no `.github/` directory and runs no GitHub
Actions. Verification instead comes from three layers, described in
`CONTRIBUTING.md` under "Local gates (no CI)":

1. **Local git hooks** (`.githooks/` + `scripts/setup-hooks.sh`) — run on
   every commit and push, on the contributor's own machine.
2. **CodeRabbit** — already installed as a GitHub App, reviews every pull
   request's diff for style and correctness on its own infrastructure, not
   billed against Actions minutes.
3. **This layer: standing autonomous agent routines** — Claude Code cloud
   scheduled sessions ("Routines") that run the deeper, periodic work no
   human or CodeRabbit pass covers: dependency/secret scanning triage, a
   rotating security audit of the codebase, and documentation drift
   detection. This document explains how to register and operate them.

## Why this replaces CI-hosted agents

A Routine is a plain Claude Code session that happens to be woken on a
timer. It runs `git`, `gh`, `pnpm`, and `cargo` the same way an interactive
session would, from inside its own environment — it never touches GitHub
Actions, and consumes **zero Actions minutes**, because there is no workflow
file, no runner, and no Actions API call anywhere in the loop. What it
consumes is ordinary Claude Code session time against the existing Claude
subscription, the same as a normal interactive session — no new billing
relationship, no new paid service, no marketplace app to install beyond what
`add_repo`/session access already requires.

**Interplay with CodeRabbit:** CodeRabbit reviews the diff of every PR
automatically, the moment it's opened — style, obvious bugs, review
etiquette, fast turnaround, zero setup per PR. It does not run dependency
scanners, does not maintain a security checklist grounded in this repo's own
audit history, does not periodically re-scan surfaces nobody happens to be
touching this week, and does not check whether root docs still match the
tree. That is exactly the gap these four routine files close. The two layers
are complementary, not redundant: CodeRabbit is push-triggered and diff-only;
these routines are time-triggered (three of them) or PR-triggered-on-request
(the fourth) and read the whole repo, not just a diff.

## The routine files

All of them live under `ops/routines/` and are each a complete, self-contained
prompt — every firing is a fresh session with no memory of prior runs, so
each file restates the repo context, the hard rules, and the exact commands
to run, the same way this document restates context for you.

| File | Cadence | Deliverable |
|---|---|---|
| `ops/routines/nightly-dependency-triage.md` | Nightly | Fix PR (`fix(deps): ...`) or a dated note in `docs/security/tooling-evaluation.md` |
| `ops/routines/weekly-security-audit.md` | Weekly | New `docs/security/audit-YYYY-MM-DD-<topic>.md` + PR with any small fixes |
| `ops/routines/nightly-fuzz-batch.md` | Nightly | Crash fix PR or a CLEAN log; never a `.github/` workflow |
| `ops/routines/weekly-docs-drift.md` | Weekly | Fix PR (`fix(docs): ...`) correcting stale references |
| `ops/routines/pr-security-review.md` | On demand | One structured review comment on a named PR |

## Registering the three scheduled routines

Use `create_trigger` for each. All three fire into a **fresh session**
(`create_new_session_on_fire: true`) so that "no memory of prior runs" is
actually true, not just documented — a persistent-session Routine would
accumulate context across firings, which the routine files are not written
to expect. All cron expressions are UTC, per `create_trigger`'s contract.

Times are chosen so the three never overlap: dependency triage runs before
the work week starts each day, and the two weekly passes land on different
days at different hours, comfortably clear of the nightly run and of each
other.

### 1. nightly-dependency-triage

```
create_trigger(
  name: "nightly-dependency-triage",
  prompt: <the full contents of ops/routines/nightly-dependency-triage.md, pasted verbatim>,
  cron_expression: "0 6 * * *",       # 06:00 UTC, every day
  create_new_session_on_fire: true,
  environment_id: <this repo's environment id>
)
```

### 2. weekly-security-audit

```
create_trigger(
  name: "weekly-security-audit",
  prompt: <the full contents of ops/routines/weekly-security-audit.md, pasted verbatim>,
  cron_expression: "0 7 * * 2",       # 07:00 UTC, every Tuesday
  create_new_session_on_fire: true,
  environment_id: <this repo's environment id>
)
```

### 3. weekly-docs-drift

```
create_trigger(
  name: "weekly-docs-drift",
  prompt: <the full contents of ops/routines/weekly-docs-drift.md, pasted verbatim>,
  cron_expression: "0 8 * * 4",       # 08:00 UTC, every Thursday
  create_new_session_on_fire: true,
  environment_id: <this repo's environment id>
)
```

Schedule at a glance (UTC):

```
Mon   Tue        Wed   Thu        Fri   Sat   Sun
06:00 06:00      06:00 06:00      06:00 06:00 06:00   nightly-dependency-triage
      07:00                                            weekly-security-audit
                       08:00                            weekly-docs-drift
```

After creating each trigger, `list_triggers` returns the `trig_...` id —
record it if you need to `update_trigger`, `fire_trigger`, or
`delete_trigger` it later; the id is not guaranteed to stay in any
session's context after creation.

Each of these three routine files already restates, inline, the hard rules
that must hold on every firing (no GitHub Actions, no new paid
dependencies/services, never commit secrets, don't touch Rust/Cargo files
unless the finding is in Rust, never expose `getSecret()`/raw secrets,
respect ADR 0004/0008/0017) — registering the trigger does not require
adding those rules anywhere else; they travel with the prompt.

## Invoking pr-security-review on demand

This one is deliberately **not** cron-scheduled — a security review only
makes sense once a specific PR exists to review. Two ways to run it:

**Ad hoc, no standing trigger:** paste the full contents of
`ops/routines/pr-security-review.md` into a new Claude Code cloud session
(or an existing one), followed by the PR number, e.g. `PR number: 123`.

**Via a poke-only Routine bound with `fire_trigger`:** register it once with
no `cron_expression` and no `run_once_at` (a Routine that never fires on its
own schedule — see `create_trigger`'s description), still with
`create_new_session_on_fire: true` so each invocation is a fresh session:

```
create_trigger(
  name: "pr-security-review",
  prompt: <the full contents of ops/routines/pr-security-review.md, pasted verbatim>,
  create_new_session_on_fire: true,
  environment_id: <this repo's environment id>
)
```

Then, whenever a review is wanted:

```
fire_trigger(
  trigger_id: <the trig_... id from list_triggers>,
  text: "PR number: 123"
)
```

`fire_trigger`'s `text` is appended as an extra user turn after the
Routine's configured prompt, which is exactly how `ops/routines/pr-security-review.md`
expects to receive the PR number — it explicitly stops and asks for one if
none was given, rather than guessing.

## Operating notes

- **Environment id.** `create_trigger` needs an `environment_id` pointing at
  an environment that can clone `https://github.com/Tyler-R-Kendrick/OpenSesame`.
  Use `list_environments` to find it; when creating a trigger from inside a
  session already running in the right environment, `environment_id` can be
  omitted and it will be inherited.
- **Model.** These routines do not require a specific model; `create_trigger`
  defaults to the environment's configured model. Change it later with
  `update_trigger(model: ...)` only if a human explicitly asks.
- **Disabling one temporarily.** `update_trigger(trigger_id: ..., enabled: false)`
  pauses a Routine without losing its run history or requiring a
  delete/recreate; flip `enabled: true` to resume.
- **Changing a prompt.** If `ops/routines/*.md` changes, update the matching
  Routine with `update_trigger(trigger_id: ..., prompt: <new file contents>)`
  rather than deleting and recreating — that keeps the Routine's id and run
  history intact.
- **No secrets in the prompt.** None of the four routine files embed a
  credential — they authenticate as whatever the firing session's own
  environment/GitHub access already provides (the same `gh`/`git` access an
  interactive Claude Code session in this environment has). Do not paste an
  API key or token into a Routine's `prompt` field to "help" it authenticate.
