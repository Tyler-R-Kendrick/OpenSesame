# Audit tick 41 — idempotency replay across principals, claim consent proof

Scanners (gitleaks, cargo-deny, osv-scanner, semgrep, task-security-battle-test)
were clean on `main` (a339368). Both findings are in the Identity plane.

## 1. Idempotency cache handed one principal's response to another

The cache key was `${scope}:${method}:${path}:${key}` — the client-chosen
`Idempotency-Key` with no caller in it. The cached bodies are exactly the
credential-bearing ones: `POST /v1/agents` returns a claim token, `/v1/oauth/clients`
a client secret, `/v1/projects/temporary` a claim token, and
`POST /v1/principals/provisional` returns a `pst_…` access token — whose
`Set-Cookie` the middleware deliberately replayed as well. Reusing a victim's
key (ours are strings like `signup-1`) returned their response verbatim.

Fix:

- Entries are keyed by the authenticated principal.
- Anonymous callers are never cached: there is no identity to bind an entry to,
  so provisional signup now always mints a fresh principal.
- No header replay at all — re-issuing `Set-Cookie` to a different HTTP client
  is never correct.
- Entries carry a 10-minute TTL, the store is capped at 2048 entries, and keys
  longer than 255 chars are ignored (the key was client-controlled and the map
  previously unbounded).

Tests: cross-principal replay returns a distinct agent and claim token while the
owner still gets `Idempotency-Replayed: true`; two anonymous signups with the
same key produce different principals and tokens.

## 2. Claim approval required no proof of consent

`POST /v1/claims/{id}/complete` accepted *any* authenticated principal plus the
claim id. It drives `presented → authenticated → reviewed → completed`, and
completion activates the referenced project and flips an agent to `claimed`. The
`userCodeDigest` minted with every claim — the whole point of the code the device
displays — was never verified (`verifyUserCode` was dead code). So a bystander
principal who learned a claim id could approve someone else's ceremony.

Fix: `userCode` is now a required field on `CompleteClaimRequest`, verified
against `session.userCodeDigest` with the existing constant-time helper, behind a
five-attempt per-claim fence (`429 too_many_attempts`). OpenAPI documents the
body and the new 401/429 answers; the daemon's Identity-API fallback forwards a
`user_code` (and refuses without one) instead of posting an empty body.
