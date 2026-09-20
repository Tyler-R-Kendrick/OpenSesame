# ADR 0126 — Browser-held GitHub backup token via Vercel Connect

## Status

Superseded by Host GitHub App backup/sync (ADR 0039 / connector App installation). GitHub is not a Vercel Connect provider in Pages.

## Context

GitHub is the backup/recovery capability's remote (`vercel-connect-catalog`
maps it there): the job is creating a private repo and committing encrypted
tomb exports to git. The Host does this today through a GitHub App
installation (ADR 0039), and the Nango directory lists connectors by
reference only (ADR 0115) — neither helps a deployment with no Host.

Vercel Connect brokers GitHub OAuth without a Host, but ADR 0005 keeps
Connect-issued tokens server-side: the browser may authorize and revoke, but
never holds a token. Connect also offers no git-write primitive. So a
Host-less backup writer has nothing to write *with*.

## Decision

For the backup/recovery capability only, the browser may hold a
repo-scoped GitHub token issued through Vercel Connect OAuth:

- The token is requested with the minimum scope the job needs (`repo`, for
  private backup repos) at authorize time, through Connect's
  `startAuthorization` — never through a pasted PAT form.
- It lives in page memory only. It is never written to the tomb, to
  `localStorage`/`sessionStorage`, or to any log; it is dropped on vault
  lock (via the existing `onVaultLock` subscription) alongside the vault key.
- Repo create and install-scope changes stay on GitHub.com (GitHub's own
  `/new` and installation settings). This app only lists private repos the
  grant already covers, refuses public ones, and upserts the sealed tomb
  blob through the contents API. No other endpoint may spend the token.
- The sealed blob is the vault's own encrypted export — the token never
  sees plaintext, and the repo never holds anything but ciphertext.
- Issuing the token also captures it: one `secret` item ("GitHub backup
  token", refreshed on re-issue, never duplicated) so the human can inspect
  it, plus a standing `item` share for the vault owner so Access lists who
  may use it and until when.

This narrows, not repeals, ADR 0005: agent-facing surfaces keep
ConnectionRef-only access with no `getSecret()`; the single exception is
this human-approved backup road, where the human completes OAuth in a
popup and the token dies with the session.

## Consequences

- `apps/pages` gains a Connect-token seam (`getToken` stays out of every
  other call site), a small GitHub REST writer, and a backup section on the
  GitHub connector page.
- `docs/security/threat-model.md` gains the residual risk: a repo-scoped
  token in page memory is XSS-exfiltrable for the session lifetime, same
  class as the in-memory vault key the app already accepts.
- If Connect cannot issue the scope, the road degrades to a terse
  re-authorize note — never to a PAT paste.
