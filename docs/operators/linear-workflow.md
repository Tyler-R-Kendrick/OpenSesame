# Linear workflow (operator runbook)

This is a manual runbook. Repo code cannot create Linear teams, issues, or
workspace settings — a human operator (or an agent acting with the operator's
real Linear credentials) follows these steps by hand.

## 1. Create a dedicated "OpenSesame" team

1. In the Linear workspace, create a **new team named "OpenSesame"**. Do not
   reuse an existing team that tracks an unrelated product — OpenSesame's
   issue history, cycles, and labels should not mix with another product's.
2. Set the team's issue identifier prefix to `ENG` (or another short prefix
   the operator prefers) — this becomes the `ENG-123` style identifier used
   in branch names and PR links below.
3. Create at minimum these labels on the team:
   - `agent-ready` — issue is scoped and safe to delegate to an agent (see
     §4 triage rule).
   - `needs-human-triage` — ambiguous or architecturally significant; a human
     must scope it before it is delegate-eligible.
   - `security` — for issues sourced from `docs/security/audit-*.md` (§2).

## 2. Seed the initial backlog from real repo gaps

Do not start the team's backlog empty or with invented placeholder issues.
The repository already documents its own known gaps in three places — pull
concrete items from each and file them as Linear issues before anything else:

- **`docs/testing-evidence.md`**, the `## Residual (documented, not blocking
  mandatory local suite)` section — items intentionally deferred from the
  mandatory local test suite.
- **`docs/brief-implementation-status.md`**, the `## Feature gates (remain
  disabled by default)` section — features shipped but deliberately gated
  off.
- **`docs/security/audit-*.md`** follow-ups — grep the audit corpus for
  open items:

  ```bash
  grep -il -E "follow-up|follow up|residual|tracked|TODO|not yet|future work" docs/security/audit-*.md
  ```

  Then read the hits' "Not fixed here" / "Residual review" sections — most
  audits document what they fixed *and* what they deliberately left open.

### Concrete starting-point issues (found via the commands above, current as of this runbook)

Paste these in verbatim as the first backlog issues; each cites its repo
source so a reader can verify the gap still exists before working it:

1. **Playwright passkey virtual-authenticator full browser matrix is not run
   in the mandatory local suite.** (`docs/testing-evidence.md`, Residual)
2. **Testcontainers-backed Postgres tests are skipped when Docker Engine is
   unavailable on the host.** (`docs/testing-evidence.md`, Residual)
3. **Live Google/GitHub/Entra IdP integration is untested beyond templates —
   only the mock IdP is exercised in CI/local runs.** (`docs/testing-evidence.md`,
   Residual)
4. **ATProto and Nostr identity adapters exist but ship disabled by
   default; they have no live-network test coverage.**
   (`docs/testing-evidence.md`, Residual; also `docs/brief-implementation-status.md`,
   Feature gates)
5. **Origin-profile clients, Dynamic Client Registration, and Client ID
   Metadata Documents are implemented but remain disabled by default** —
   decide whether/when to graduate each out of the feature gate.
   (`docs/brief-implementation-status.md`, Feature gates)
6. **Client-side unlock-lockout state is advisory only** — anything with
   write access to browser storage can reset the failed-attempt counter; the
   PBKDF2 iteration floor is the real cost, not the counter. Consider
   whether a server-side lockout signal is warranted.
   (`docs/security/audit-2026-08-08-browser-followups.md`, "Not fixed here" #1)
7. **Non-wasm sealed-store paths still use `sealDevOnly` (an XOR fenced to
   dev/test)** — the real AEAD seal only exists in the Rust wasm build;
   confirm no dev-only path can reach a production build.
   (`docs/security/audit-2026-08-08-browser-followups.md`, "Not fixed here" #2)

When seeding, file each as its own issue (don't batch them into one), tag
security-sourced items (#6, #7) with the `security` label, and leave feature
decisions (#4, #5) unlabeled for human triage rather than `agent-ready` —
they require a product decision, not just implementation.

## 3. Branch naming convention

Linear auto-links a branch to its issue when the branch name embeds the
issue identifier. The convention is:

```
<username>/<issue-id-lowercase>-<short-description>
```

Example: issue `ENG-123` ("Add server-side lockout signal") becomes:

```
tyler/eng-123-add-server-side-lockout-signal
```

Linear's UI offers a "Copy git branch name" action on any issue that
generates this exact format — use it rather than typing the identifier by
hand, to avoid a typo that breaks the auto-link. Opening a PR from a
correctly-named branch automatically links the PR to the issue and moves the
issue through the workflow states Linear is configured to track (e.g. into
"In Review" on PR open, "Done" on merge) — configure that automation once
under the team's Settings → Git integration.

## 4. Agent delegation (Claude via the Linear agent integration)

Linear's terminology here is **delegate**, not "assign" in the traditional
sense: an issue delegated to an agent keeps a human as the visible owner
while the agent does the work and reports back as comments/status updates on
the issue.

**Claude is the only agent-delegation path in scope for this workflow.** It
is available through the existing Claude subscription via Linear's Claude
agent integration — no separate billing. GitHub Copilot is explicitly out of
scope: do not configure it, mention it in issue templates, or delegate to it
in this workflow.

### Prerequisite: enable Claude's assignable/mentionable scopes

Before any delegation will work, a Linear **workspace admin** must enable
the Claude integration's ability to be delegated to:

1. Go to Linear workspace Settings → Integrations (or Settings → Agents,
   depending on the operator's Linear plan) and locate the Claude
   integration.
2. Enable the `app:assignable` scope — required for the Claude agent to
   appear as a delegate target on an issue.
3. Enable the `app:mentionable` scope — required so `@Claude` mentions in
   issue comments and descriptions reach the agent.

Without both scopes granted, "delegate to Claude" will not appear as an
option on OpenSesame team issues.

### Delegating an issue

1. Open the issue.
2. Use Linear's delegate/assign action and choose the Claude agent as the
   delegate (not a human teammate).
3. Claude receives the issue's title, description, and comment thread as
   context, works the issue, and reports progress back as comments — the
   human delegate-initiator remains the issue's visible owner throughout.

## 5. Triage rule: auto-delegate `agent-ready` issues

Suggested simple triage rule for the OpenSesame team:

- When an issue is triaged and labeled **`agent-ready`**, auto-delegate it
  to Claude immediately (via a Linear automation rule on label-added, if the
  operator's Linear plan supports it, or manually as a matter of team
  convention otherwise).
- An issue only earns `agent-ready` once a human has confirmed it is
  concretely scoped: a clear acceptance criterion, a bounded set of files or
  packages it touches, and no open product/architecture question.
- Anything **ambiguous or architecturally significant** — a design decision,
  a cross-package contract change, anything touching the security posture
  documented in `docs/security/audit-*.md` — stays with
  `needs-human-triage` and is scoped by a human first. Only relabel it
  `agent-ready` (dropping `needs-human-triage`) once that scoping is done.

This keeps agent delegation fast for well-bounded work while keeping a human
in the loop on judgment calls before an agent starts.
