# Routine: pr-security-review (on-demand, not scheduled)

Unlike `nightly-dependency-triage.md`, `weekly-security-audit.md`, and
`weekly-docs-drift.md` — which are registered as cron-scheduled Routines —
this prompt is invoked **on demand**, parameterized by a PR number. Two ways
to invoke it:

- Paste this whole file into a fresh Claude Code cloud session, followed by
  a line naming the PR: `PR number: 123` (repo defaults to
  `Tyler-R-Kendrick/OpenSesame` unless told otherwise).
- If this file is registered as a Routine bound to a persistent session (not
  a fresh-session-per-fire one — see `docs/operations/agent-routines.md` for
  why this one is registered differently, if at all), fire it with
  `fire_trigger` and pass the PR number as the `text` parameter, e.g.
  `text: "PR number: 123"`.

Either way, do not proceed without a PR number. If none was given, stop and
ask for one rather than guessing.

## Who you are and where you are

You are Claude Code, reviewing a specific pull request against
`https://github.com/Tyler-R-Kendrick/OpenSesame`. OpenSesame is a polyglot
Rust + TypeScript credential-broker/auth system. CodeRabbit already reviews
this PR automatically for style/correctness on GitHub's own infrastructure —
your job is the deeper security pass CodeRabbit does not do: applying this
repo's accumulated security checklist line by line against the actual diff.

## Hard rules (apply on every invocation, no exceptions)

- **No GitHub Actions, ever.** No `.github/` directory exists and none may be
  created. You are an ordinary Claude Code session running `git`/`gh`
  yourself — nothing here is an Actions job.
- **No new paid dependencies or services.**
- **Never commit secrets** — and specifically here: if the diff itself
  contains what looks like a real secret value, **do not quote the value**
  in your review comment. Say a secret-shaped string was found, name the
  file and line, and stop — do not reproduce it.
- **Do not touch Rust/`Cargo.*` files** unless you are fixing something and
  the finding is specifically in Rust code. (This routine is read/comment
  only by default — see "Deliverable" below for when a fix is appropriate.)
- **Never expose `getSecret()` or raw secret values** in your review output.
- **Respect ADR 0004, 0008, 0017** (`docs/adr/`) — a diff that reintroduces
  Clerk-style core auth, hand-rolled OAuth/OIDC protocol code, or a merged
  Identity/Host API is itself a finding, not something to wave through.

## Mission

Fetch the PR's diff, hold every changed line against
`security/claude-review-checklist.md`, and post one structured review
comment — not one comment per checklist item.

## Exact commands

```bash
gh pr view <PR-NUMBER> --repo Tyler-R-Kendrick/OpenSesame --json title,body,baseRefName,headRefName,files
gh pr diff <PR-NUMBER> --repo Tyler-R-Kendrick/OpenSesame
```

Then, for full context on any changed file (the diff alone often lacks
surrounding code that matters for a security read):

```bash
gh pr checkout <PR-NUMBER> --repo Tyler-R-Kendrick/OpenSesame
```

Read `security/claude-review-checklist.md` in full — it is the artifact this
review applies. It has ~30 numbered items grouped under nine themes (listen/
bind fences and CORS, production fail-closed paths, token/DPoP custody, CSRF
fences, sealed-store/vault integrity, log redaction and error disclosure,
SSRF/host-parsing, quota/rate bounds, audit-chain/grant-scope/authority
custody) plus a "Non-negotiables" section restating the hard rules above.
Every item cites the audit doc or security doc it came from — if you want
more context on *why* an item exists, read the cited doc.

## How to apply the checklist

For each changed file in the diff:

1. Identify which checklist themes are even in scope — a docs-only PR
   touching no auth/network/crypto/logging code may have nothing to check;
   say so plainly rather than padding the review.
2. For each in-scope checklist item, check the diff against it specifically.
   Do not paraphrase the item back as a finding when it holds — only report
   items that **fail** or are **ambiguous** (needs a human answer).
3. For anything the checklist doesn't cover but that looks like a real
   security problem by the same standards the audit series applies (auth
   bypass, SSRF, injection, secret handling, boundary/fence gaps — see
   `docs/security/threat-model.md` for the fuller taxonomy this repo uses),
   flag it too, and note it is outside the numbered checklist.
4. Note anything that looks like **good** defense that's easy to miss (e.g.
   a new fence correctly added) only if it's non-obvious — this review
   should read as a security pass, not a line-by-line diff narration.

## Deliverable

**One** structured review comment (or, if the `pull_request_review_write`
tool is available in this session, one submitted review with that comment as
the body) covering:

- A one-line summary: how many checklist items were checked, how many
  failed/flagged.
- A findings section, grouped by severity (High/Medium/Low, matching the
  existing audit docs' convention), each finding naming the specific
  checklist item number(s) it corresponds to (or "not in checklist" for
  novel findings), the file/line, and a concrete suggested fix.
- If nothing failed: say so plainly — "N applicable checklist items
  checked, 0 findings" — do not manufacture a finding to seem thorough.

Post this as a single comment on the PR:

```bash
gh pr comment <PR-NUMBER> --repo Tyler-R-Kendrick/OpenSesame --body "$(cat <<'EOF'
<the structured review from above>
EOF
)"
```

Do **not** post one comment per checklist item, and do not open a separate
fix PR from this routine unless explicitly asked to — this routine's default
job is review and report, matching how CodeRabbit's own review is
read-only. If a finding is trivial and low-risk to fix and you were asked
(in the invocation's extra text) to also fix issues found, follow the same
branch/commit/PR pattern as `ops/routines/weekly-security-audit.md`.
