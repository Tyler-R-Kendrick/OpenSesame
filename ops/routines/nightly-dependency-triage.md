# Routine: nightly-dependency-triage

Paste this whole file as the `prompt` of a Claude Code cloud scheduled session
(a Routine, `create_new_session_on_fire=true`). Each firing is a **fresh session
with no memory of prior runs** — everything you need is below.

## Who you are and where you are

You are Claude Code, working alone in a fresh clone of
`https://github.com/Tyler-R-Kendrick/OpenSesame`, branch `main`. This is the
OpenSesame repo: a polyglot Rust (`crates/`, `apps/*` Rust binaries) + TypeScript
(`apps/*`, `packages/*`) auth/credential-broker system. Read `README.md`,
`PRODUCT.md`, and `docs/security/tooling-evaluation.md` first for orientation —
the latter is the living record of which scanners exist, why, and what has
already been accepted or fixed.

## Hard rules (apply on every firing, no exceptions)

- **This routine never becomes a GitHub Actions job.** `.github/workflows/`
  holds only `ci.yml` (the merge-queue gate) and `deploy-pages.yml`; dependency
  triage is not to be added there. You operate as an ordinary Claude Code
  session running `git` and `gh` yourself.
- **No new paid dependencies or services.** Only use tools already vendored
  in this repo (see the command list below).
- **Never commit secrets.** If a scanner finding involves an actual leaked
  value, do not paste the value into a commit message, PR description, or this
  session's own output — describe the finding and its location, not its value.
- **Do not touch Rust/`Cargo.*` files** unless the specific finding you are
  fixing is in a Rust crate's dependency (e.g. a `cargo-audit`/`osv-scanner`
  hit against `Cargo.lock`). TypeScript/JS findings stay in `package.json` /
  lockfiles under `apps/`, `packages/`.
- **Never expose `getSecret()` or raw secret values** in anything you write —
  not in a fix diff, not in a PR body, not in a doc note.
- **Respect ADR 0004, 0008, 0017** (`docs/adr/`): no Clerk/Marketplace auth as
  core, Better Auth upstream / oidc-provider downstream (no NIH protocol
  code), and the Identity API (`apps/control-plane`, :8788) / Host API
  (`apps/gateway`, :8787) stay separate — no BFF merge. A dependency bump must
  not be an excuse to cross these lines.

## Mission

Run the dependency/secret scanners, triage every finding against the existing
ignore/accept records, and for each genuinely new and actionable finding
either ship a small fix PR or record why it is not being fixed.

## Exact commands, in order

Run from the repo root, after a normal clone (do **not** run a full
`pnpm install`/`cargo build` unless a specific gate below requires it — the
gate scripts install what they need):

```bash
git status
git log -3 --oneline

pnpm run audit:cve-lite       # bash ./scripts/cve-lite-gate.sh
pnpm run audit:osv            # bash ./scripts/osv-scanner-gate.sh (osv-scanner.toml)
pnpm run audit:cargo-audit    # bash ./scripts/cargo-audit-gate.sh (.cargo/audit.toml)
pnpm run audit:gitleaks       # bash ./scripts/gitleaks-gate.sh (.gitleaks.toml)
pnpm audit                    # native pnpm advisory scan (no wrapper script)
cargo deny check              # deny.toml — licenses, bans, RustSec advisories
```

If any of the six commands above is missing or fails to execute at all (not a
finding, but a broken gate — e.g. the script file is gone or a binary is
missing from `PATH`), that is itself a finding: note it and, if the fix is
small (a script path correction, a missing `pnpm dlx` install step), fix it
in the same PR as any dependency bumps; otherwise write it up under "Genuinely
new, unfixable this run" below.

## How to interpret results

For every finding reported by the six commands:

1. **Check whether it is already accepted.** Read the relevant ignore file
   *before* assuming its syntax:
   - `osv-scanner.toml` — has an `[[IgnoredVulns]]` table array; each entry
     has an `id` (e.g. `RUSTSEC-2023-0071`) and a `reason` comment above it.
     Read it at runtime to confirm the exact keys still match the installed
     osv-scanner version — do not assume the schema from this description.
   - `.cargo/audit.toml` — has an `[advisories]` table with an `ignore = [...]`
     array of RustSec IDs. Read it at runtime the same way.
   - `deny.toml` — has `[licenses]`, `[bans]`, `[advisories]` sections;
     `cargo deny check` output tells you which section a finding falls under.
   - `docs/security/tooling-evaluation.md` — the running log of decisions;
     search it for the advisory ID or package name before treating anything
     as new.
   If a finding's ID/package already appears in one of these with a reason
   that still holds (re-verify the reasoning still applies — e.g. "no fixed
   release yet" may have changed), it is **not** new. Skip it.

2. **For a genuinely new, actionable advisory** (a real CVE/GHSA/RUSTSEC
   against a package actually in `Cargo.lock` or `pnpm-lock.yaml`, with a
   fixed version available): upgrade the affected dependency to the fixed
   version (or the latest compatible version if no exact fix version is
   pinned), re-run the specific gate that flagged it plus `pnpm typecheck`
   and the affected package's test suite, and open a small fix PR:
   ```bash
   git checkout -b fix/deps-<short-package-name>-<date>
   # edit package.json / Cargo.toml as needed, then:
   pnpm install --lockfile-only    # or the Rust equivalent: cargo update -p <crate>
   git add <changed files>
   git commit -m "fix(deps): bump <package> to <version> (<ADVISORY-ID>)"
   git push -u origin HEAD
   gh pr create --title "fix(deps): bump <package> to <version> (<ADVISORY-ID>)" \
     --body "Nightly dependency triage found <ADVISORY-ID> in <package> <old-version>. Fixed in <new-version>. Gate re-run: <command> clean. $(cat <<'EOF'

EOF
)"
   ```
   Keep each PR to one advisory/package family unless multiple advisories
   share one fix commit naturally (e.g. one `pnpm install` moves several
   transitive deps at once) — do not bundle unrelated bumps.

3. **For a false positive or an advisory you are accepting as risk** (no
   fixed version exists yet, the vulnerable code path is unreachable in this
   codebase, or fixing it would require a major/breaking upgrade out of scope
   for a nightly run): do **not** change code. Instead append a dated,
   attributed note to `docs/security/tooling-evaluation.md` under a new
   lettered bullet in the "Findings applied from this pass" list (follow the
   existing `0a.`, `0b.` … style), explaining the advisory ID, why it is not
   being fixed now, and what would need to change to revisit it — mirror the
   tone of the existing `RUSTSEC-2023-0071` entries there. If the advisory
   maps cleanly onto one scanner's own ignore file (`osv-scanner.toml` /
   `.cargo/audit.toml`) and that file's existing entries show it is meant to
   also record new exceptions there, add the corresponding ignore entry too,
   with a `reason` — but only after reading the file's current entries to
   match its exact format, and only for scanners where a documented ignore
   mechanism already exists in that file (do not invent new TOML keys).

## Deliverable

Either:
- One or more small `fix(deps): ...` PRs (conventional commit style, pushed
  to a fresh `fix/deps-...` branch, opened via `gh pr create`), each scoped
  to one advisory/package family, **or**
- A dated note appended to `docs/security/tooling-evaluation.md` for each
  finding that is a false positive or accepted risk (no PR needed for
  doc-only changes — commit directly to a small `docs/deps-triage-<date>`
  branch and open a PR the same way, since this repo has no bot-push path).

If every gate is clean and nothing is new, end the session with a short note
in your final message: which commands ran clean, and that no PR was needed.
Do not open an empty PR.
