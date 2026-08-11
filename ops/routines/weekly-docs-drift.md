# Routine: weekly-docs-drift

Paste this whole file as the `prompt` of a Claude Code cloud scheduled session
(a Routine, `create_new_session_on_fire=true`). Each firing is a **fresh
session with no memory of prior runs** — everything you need is below.

## Who you are and where you are

You are Claude Code, working alone in a fresh clone of
`https://github.com/Tyler-R-Kendrick/OpenSesame`, branch `main`. OpenSesame is
a polyglot Rust + TypeScript monorepo. This routine's job is documentation
accuracy: root docs drift from the actual tree over time — a script gets
renamed, a planned feature gets described before it lands (or removed after
it's cut), a port or version number changes in one place and not another.

## Hard rules (apply on every firing, no exceptions)

- **No GitHub Actions, ever.** No `.github/` directory exists and none may be
  created. You are an ordinary Claude Code session running `git`/`gh`
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

- `PRODUCT.md` referenced `scripts/deploy-pages.sh`, which does not exist in
  `scripts/` (confirm this is still true when you run — if a later change
  added the script, that specific item is resolved and you should look for
  the *next* instance of this pattern instead).
- `docs/security/tooling-evaluation.md` claimed dependency/security gates
  were "wired ... into CI `security` job" (referencing `.github/` CI that
  does not exist in this repo — there is no CI, only local git hooks + these
  Routines + CodeRabbit). Treat any doc anywhere in the tree that says "CI"
  meaning GitHub Actions, or implies a `.github/` workflow exists, as this
  same class of drift, not a new discovery — reword it to describe what
  actually runs (local git hooks via `scripts/setup-hooks.sh` /
  `.githooks/`, and these Routines).

Watch for the same pattern anywhere else: a referenced file path, script
name, package name, or command that no longer exists or never existed.

## Exact checks to run, in order

```bash
git status
```

1. **File/path references.** For each of `README.md`, `PRODUCT.md`,
   `CONTRIBUTING.md`, root `AGENTS.md` (check `ls AGENTS.md` first — it may
   not exist yet on an early firing; skip gracefully if so, but check every
   time since a sibling workstream is adding it), `DESIGN.md`, and any other
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
   - A direct script invocation (`bash scripts/foo.sh`, `./scripts/foo.sh`)
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
   grep -rn ":8787\|:8788" apps/gateway/src apps/control-plane/src 2>/dev/null | head -5
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
- PRODUCT.md: scripts/deploy-pages.sh no longer exists; reworded to describe gh-based deploy
- docs/security/tooling-evaluation.md: removed stale GitHub Actions CI claim>"
git push -u origin HEAD
gh pr create --title "fix(docs): correct stale reference(s)" \
  --body "Weekly docs-drift pass. Corrections:
<same list as the commit body>"
```

If nothing is stale, end the session with a short note in your final message
listing what you checked and that everything matched. Do not open an empty
PR.
