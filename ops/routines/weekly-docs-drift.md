# Routine: weekly-docs-drift

Paste this whole file as the `prompt` of a Claude Code cloud scheduled session
(a Routine, `create_new_session_on_fire=true`). Each firing is a **fresh
session with no memory of prior runs** — everything you need is below.

## Who you are and where you are

You are Claude Code, in a copy-on-write worktree of
`https://github.com/Tyler-R-Kendrick/OpenSesame`, branch `main`. OpenSesame is
a polyglot Rust + TypeScript monorepo. This routine's job is documentation
accuracy: root docs drift from the actual tree over time — a script gets
renamed, a planned feature gets described before it lands (or removed after
it's cut), a port or version number changes in one place and not another.

## How this firing runs

Follow AGENTS.md §9. Do the work in a copy-on-write git worktree
`/home/codex/repos/opensesame-<routine>` branched from the latest `origin/main`
(`git worktree add` shares the object database; do not full-clone). Share the
pnpm store (`pnpm store path`) and set
`CARGO_TARGET_DIR=$HOME/.cache/packages/cargo-target`. Do not copy
`node_modules` or `target/` into the worktree.

Independent findings run together through `.grok/workflows/task-swarm.rhai`:
one agent per disjoint file set, parent integrates. Land each logical slice
as its own GitHub-verified commit (`createCommitOnBranch`) on a stacked pull
request. After each commit, run `df -h /` and delete only the scratch and
build output that commit created. Leave `/tmp/os-wallet-ship`, the Host on
`127.0.0.1:8787`, and unrelated worktrees in place.

When the stack is finished, self-review, resolve review threads, and
squash-merge into `origin/main` only after TypeScript, Rust, and Bundle
budgets are green. Then `git worktree remove` the worktree and delete the
merged branches. Copilot review requests on this repository return HTTP 422.
CodeRabbit does not auto-review while the repository has fewer than 10 stars.

## Hard rules (apply on every firing, no exceptions)

- **This routine never becomes a GitHub Actions job.** `.github/workflows/`
  holds `ci.yml` (the required pull-request checks), `deploy-pages.yml`,
  `full-suite.yml` and `password-parity.yml`; doc-drift sweeps are not to be
  added there. You are an ordinary Claude Code session running `git`/`gh`
  yourself.
- **No new paid dependencies or services.**
- **Never commit secrets.**
- **Do not touch Rust/`Cargo.*` files** unless the drift you are fixing is a
  version/path claim that specifically lives in one of those files (you may
  *read* them as a source of truth; only edit them if the drift is that the
  Cargo file itself is stale relative to docs, which will be rare — usually
  the docs are what's stale).
- **Never expose `getSecret()` or raw secret values** anywhere you write.
- **Respect ADR 0004, 0008, 0017** (`docs/adr/`) — do not "fix" a doc by
  describing a design that contradicts an accepted ADR; if a doc and an ADR
  disagree, the ADR is authoritative and the doc is the drift.

## Mission

Cross-check the root docs against the real tree and correct anything stale.

## The specific bug class to watch for

This exact class of bug has already been found once by a human/agent pass —
**"a doc references a thing that used to exist, or was planned but never
landed, or has since been renamed/removed"**:

- `PRODUCT.md` once referenced `scripts/release/deploy-pages.sh` at a time
  when no such file was tracked. It exists now (the manual fallback beside
  `.github/workflows/deploy-pages.yml`), so that specific item is resolved:
  look for the *next* instance of this pattern instead.
- `docs/security/tooling-evaluation.md` once claimed dependency/security
  gates were "wired ... into CI `security` job". No such job exists:
  `.github/workflows/` holds four workflows — `ci.yml` (the required
  `TypeScript`, `Bundle budgets` and `Rust` checks: changed-file lint,
  `pnpm quality`, the scoped tests and the browser gates), `deploy-pages.yml`,
  `full-suite.yml` (the whole TypeScript suite on a schedule) and
  `password-parity.yml` (the password parity gauntlet) — and none of them runs
  the `pnpm audit:*` gates. Treat any doc that attributes a gate to CI which
  those workflows do not actually run as this same class of drift — reword it
  to name what really runs it (local git hooks via `scripts/dev/setup-hooks.sh`
  / `.githooks/`, or these Routines). Docs asserting the repo has *no* CI or no
  `.github/` directory are themselves drift.

Watch for the same pattern anywhere else: a referenced file path, script
name, package name, or command that no longer exists or never existed.

## Exact checks to run, in order

```bash
git status
```

1. **File/path references.** For each of `README.md`, `PRODUCT.md`,
   `CONTRIBUTING.md`, `AGENTS.md`, `DESIGN.md`, and any other
   root-level `*.md` file (`ls *.md`), extract every backtick-quoted path
   that looks like a repo-relative file or directory (`scripts/*.sh`,
   `apps/*`, `packages/*`, `crates/*`, `docs/*`, config file names) and
   confirm each exists:
   ```bash
   test -e <path> && echo "OK: <path>" || echo "MISSING: <path>"
   ```
   Do this for every such reference you find — there is no single command
   that covers all of them; read each doc and check each path it names.

2. **Command references.** For each backtick-quoted shell command in those
   same docs (`pnpm <script>`, `cargo <subcommand>`, a raw script
   invocation), confirm the command is real:
   - `pnpm <x>` — check `<x>` is a key under `"scripts"` in `package.json`,
     or a documented native pnpm subcommand (e.g. `pnpm audit`, `pnpm
     install`, `pnpm dlx`).
   - `cargo <x>` — check it's a standard cargo subcommand or one provided by
     an installed cargo extension already referenced elsewhere in the repo
     (e.g. `cargo deny`, `cargo clippy`).
   - A direct script invocation (`bash scripts/<name>.sh`, `./scripts/<name>.sh`)
     — confirm the file exists and is the same script `package.json` points
     at, if both reference it (they should agree).
   Do **not** actually execute destructive or long-running commands (a full
   `cargo test --workspace`, a real deploy) — confirming the command/path is
   real and matches what `package.json`/`Cargo.toml`/the script file itself
   says is enough; you may run cheap, side-effect-free ones (`--help`,
   `--version`) to confirm a binary exists.

3. **Ports and versions.** Cross-check any port number or version string
   quoted in docs against its source of truth:
   ```bash
   grep -n "engines\|packageManager" package.json
   cat rust-toolchain.toml
   grep -rn ":8787\|:8788" README.md PRODUCT.md CONTRIBUTING.md DESIGN.md 2>/dev/null
   grep -rn ":8787\|:8788" crates/gateway/src packages/control-plane/src 2>/dev/null | head -5
   ```
   A port or version claimed in prose must match what the code/config
   actually uses. If you cannot find where a claimed port is actually
   configured (env var default, listener bind), say so in your findings
   rather than guessing which one is right.

4. **Cross-doc consistency.** If the same fact is stated in more than one
   root doc (e.g. Node version, pnpm version, Rust version, a port number),
   confirm all copies agree with each other and with
   `package.json`/`rust-toolchain.toml`.

## Deliverable

For anything stale: fix it directly in the doc (correct the path, remove the
dead reference, update the number) and open a small PR:

```bash
git checkout -b docs/drift-<date>
git add <corrected docs>
git commit -m "fix(docs): correct stale reference(s) found by weekly drift check

<one line per correction, e.g.:
- <doc>: <path or command> does not exist; <what it was changed to>
- <doc>: <stale claim> corrected to <what the tree shows>>"
git push -u origin HEAD
gh pr create --title "fix(docs): correct stale reference(s)" \
  --body "Weekly docs-drift pass. Corrections:
<same list as the commit body>"
```

The default-branch ruleset requires signed commits
(`ops/github/default-branch.json`), and a local `git commit` is unsigned: land
the commit with `createCommitOnBranch` as described above and use the commands
here for the branch and the pull request.

If nothing is stale, end the session with a short note in your final message
listing what you checked and that everything matched. Do not open an empty
PR.
