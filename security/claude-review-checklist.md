# Claude review checklist — OpenSesame

Distilled from `docs/security/security-boundaries.md`, `docs/security/threat-model.md`,
`docs/security/identity-threat-model.md`, `docs/security/key-hierarchy.md`, and the
concrete bug classes recorded across `docs/security/audit-2026-08-0{7,8}-*.md`. This is
the artifact `ops/routines/pr-security-review.md` applies line by line against a PR
diff, and the same lens `ops/routines/weekly-security-audit.md` should hold up to
whatever surface it picks that week.

Every item below cites the source doc(s) it was distilled from. When a diff touches
something an item describes, quote the item, the line(s), and why it does or does not
hold — do not just restate the item back as a finding.

## 1. Listen/bind fences and CORS

1. Every new HTTP listener defaults to loopback-only; binding non-loopback requires an
   explicit opt-in env var (`OPENSESAME_ALLOW_NONLOCAL`, or the daemon's
   `OPENSESAME_DAEMON_ALLOW_NONLOCAL` alias) rather than being the default — see
   `docs/security/tooling-evaluation.md` ("Bind policy" section) and
   `docs/security/audit-2026-08-07-listen-fence-remaining.md`.
2. Any new service that accepts browser requests sets `OPENSESAME_CORS_ORIGINS`
   fail-closed in production (`*`/`null` rejected, explicit origin list required) — see
   `docs/security/audit-2026-08-07-gateway-bind-cors.md` and
   `docs/security/audit-2026-08-07-gateway-cors-headers.md`.
3. New response headers/pages set `X-Content-Type-Options: nosniff`, a frame-ancestors
   protection, and (for the Identity API) HSTS, matching the existing baseline — see
   `docs/security/audit-2026-08-07-claim-verify-xss.md` and
   `docs/security/audit-2026-08-07-gateway-cors-headers.md`.
4. New SPA entry points ship a baseline Content-Security-Policy rather than none — see
   `docs/security/audit-2026-08-07-spa-csp-mock-idp.md`.

## 2. Production fail-closed paths and dev-default gating

5. Any new "helpful default" (a dev keypair, an in-memory adapter, an unsalted secret,
   an ephemeral signing key, a stub/placeholder endpoint such as the TOTP scaffolding)
   throws or refuses to start in production rather than silently activating — check for
   an explicit `OPENSESAME_ALLOW_DEV_DEFAULTS` / `NODE_ENV`/`OPENSESAME_ENV` gate, not
   an implicit fallback — see
   `docs/security/audit-2026-08-08-oauth-provider-fail-closed.md`,
   `docs/security/audit-2026-08-07-totp-dev-only.md`, and
   `docs/security/tooling-evaluation.md` (item 6, "Fail-closed config").
6. Long-lived signing/receipt keys are loaded from an explicit env var
   (`OPENSESAME_RECEIPT_SIGNING_KEY`) rather than generated per boot; production refuses
   to start without one — see `docs/security/audit-2026-08-08-receipt-signing-key.md`.
7. A build that inlines `VITE_*`/client env vars never bakes an operator or shared
   secret into a shipped bundle; production builds refuse outright if one is set — see
   `docs/security/audit-2026-08-08-browser-followups.md` (§4).

## 3. Token / proof-key custody and DPoP binding/nonce handling

8. Any code mediating an OAuth/OIDC bearer token also handles `ath` (access-token
   hash) and a normalized `htu` (scheme + authority + path only, no query string) on
   the accompanying DPoP proof — binding the proof to the token it travels with, RFC
   9449 §§4.2–4.3 — see `docs/security/audit-2026-08-08-dpop-token-binding.md`.
9. A client-side destination fence (`normalizeHttpBaseUrl` or equivalent) is applied
   to the client's *own* base URL, not just URLs it receives from elsewhere — see
   `docs/security/audit-2026-08-08-dpop-token-binding.md` ("client exported a fence it
   did not apply to itself").
10. A DPoP replay/nonce cache bounds both *time* (entries expire with the proof
    window) and *capacity* (a hard ceiling, fail-closed at capacity rather than
    evicting — eviction reopens the replay window) — see
    `docs/security/audit-2026-08-08-dpop-replay-cache.md`.
11. Token/claim identifiers are stored as digests, not the raw value, and comparisons
    against caller-supplied codes are constant-time with an attempt ceiling — see
    `docs/security/audit-2026-08-08-device-code-digests.md` and
    `docs/security/audit-2026-08-08-passkey-user-verification.md`.

## 4. CSRF fences

12. Any new state-changing (non-GET) route reachable via a browser cookie session
    re-checks `Origin` before treating the cookie as authentication — bearer-token
    callers are exempt, since attaching a bearer cannot be forced on a victim — see
    `docs/security/audit-2026-08-08-browser-followups.md` (§1).
13. `SameSite` on any new cookie is `Lax` or stricter, and is treated as
    defense-in-depth, not the only CSRF control (siblings on the same registrable
    domain are not separated by `SameSite`) — see
    `docs/security/audit-2026-08-08-browser-followups.md` (§1).

## 5. Sealed-store / vault integrity and KDF parameters

14. KDF parameters (Argon2 memory/time/parallelism, or any cost parameter) that a
    client reads back from a server-stored wrapper are validated against a fixed
    accepted band before use, never trusted as-is — server-blind E2EE means the
    wrapper is attacker-reachable — see
    `docs/security/audit-2026-08-08-vault-kdf-params.md`.
15. Decrypted key material of a fixed expected length is checked before
    `copy_from_slice`/equivalent, returning a typed error instead of panicking on a
    malformed or cross-version wrapper — see
    `docs/security/audit-2026-08-08-vault-kdf-params.md`.
16. An envelope's embedded AD version and its header version are both checked and
    must agree — checking only one lets a re-digested envelope disagree silently —
    see `docs/security/audit-2026-08-08-vault-kdf-params.md`.
17. Any "ciphertext-only" store guard validates the document's actual structure
    (allowed keys, shapes, bounds), not a marker string from its own test fixture —
    see `docs/security/audit-2026-08-08-sealed-store.md`.
18. A sealed/synced store's cursor names the device it is stored under, and a
    mismatch on load is treated as absent, not adopted as identity — see
    `docs/security/audit-2026-08-08-sealed-store.md` and
    `docs/security/audit-2026-08-08-browser-followups.md` (§3).

## 6. Log redaction depth and error-string disclosure

19. New structured logging of request/session/context objects passes through a
    depth-unlimited (or explicitly depth-bounded, cycle-safe) redaction pass, not a
    one-level wildcard path list — see
    `docs/security/audit-2026-08-08-log-redaction-depth.md`.
20. Public/unauthenticated error responses and diagnostic endpoints (e.g.
    `/health/ready`) never echo DSNs, upstream addresses, or `Authorization`/`Basic`
    header contents in their text — see
    `docs/security/audit-2026-08-08-error-string-disclosure.md`.
21. Any relay of an upstream/daemon response body back to a model or agent context
    scrubs process-held secrets by value first, then refuses payloads that still carry
    credential shape (`secret://`, `client_secret`, `-----BEGIN`, `ghp_`, etc.) — see
    `docs/security/audit-2026-08-08-mcp-agent-boundary.md`.

## 7. SSRF / host-parsing fences

22. A destination/egress fence parses the host as an IP address using every spelling a
    real resolver accepts (decimal, octal, hex, integer, IPv4-mapped/compatible IPv6,
    NAT64/6to4, zone ids, trailing DNS root dot) rather than string-matching prefixes
    like `127.` or `fc` — see `docs/security/audit-2026-08-08-ssrf-host-parsing.md` and
    `docs/security/audit-2026-08-08-prefix-match-fences.md`.
23. A URI-equality check used as a security fence (redirect allowlist, egress path
    prefix, device-flow `verification_uri_complete`) parses scheme/host/port and
    requires exact match or a `/` segment boundary — never a bare `starts_with` — see
    `docs/security/audit-2026-08-08-prefix-match-fences.md`.
24. New WASM connector capabilities do not add ambient FS/env/net/clock/random beyond
    declared imports (`wit/connector/world.wit`) — see
    `docs/security/security-boundaries.md` (item 5) and
    `docs/security/threat-model.md` ("Malicious WASM").

## 8. Quota / rate bounds

25. Any new resource a principal can create through an API (organizations, OAuth
    clients, projects, agents, sync blobs, device cursors) is counted live against a
    quota, not left as an unbounded in-memory/DB collection — see
    `docs/security/audit-2026-08-08-org-client-quotas.md` and
    `docs/security/audit-2026-08-08-sync-quotas.md`.
26. Quota/attempt counters for auth ceremonies (TOTP, passkey, device user-code) burn
    down on repeated failure and are checked before the operation proceeds — see
    `docs/security/audit-2026-08-08-live-quotas-mfa-fences.md`.

## 9. Audit-chain integrity, grant/resource scope, and authority custody

27. A policy/grant check that authorizes an action also checks the grant's *resource*
    scope, not only its action list — matching wildcards stop at a path segment
    boundary — see `docs/security/audit-2026-08-08-grant-resource-scope.md`.
28. New audit-log appends go through the chained sink (`packages/audit/src/chain.ts`)
    so each event links to the digest of the one before it; a direct write that
    bypasses the sink produces an `unlinked` event on verification — see
    `docs/security/audit-2026-08-08-audit-chain.md`.
29. Receipt/signature verification checks the signer's `authority_key_id` explicitly
    rather than only comparing bytes — a mismatch should name the cause, not report a
    generic bad-signature — see `docs/security/audit-2026-08-08-receipt-signing-key.md`.
30. Nothing in application code calls `getSecret()` or otherwise reads a raw secret
    value out of authority material for an agent — the agent-facing API is
    ConnectionRef + Intent (ADR 0005); resolving/materializing a secret without an
    export grant is denied — see `docs/security/threat-model.md` ("Credential /
    authority abuse") and `docs/security/security-boundaries.md` (items 3–4, 7).
31. A PDP/policy default for an action it has no explicit rule for is deny, especially
    for anything on a high-risk action list — never default-allow — see
    `docs/security/audit-2026-08-08-policy-default-allow.md`.

## Non-negotiables (restate on every review, not diff-checkable line by line)

- No GitHub Actions — this repo has no `.github/` directory and none may be added.
- No new paid dependencies or services introduced to satisfy a finding.
- Never commit, log, or quote a real secret value in a PR description, commit message,
  or review comment — describe *that* a secret was found and where, not the value.
- Do not touch Rust/`Cargo.*` files unless the finding is specifically in Rust code.
- Respect ADR 0004 (no Clerk/Marketplace auth as core), ADR 0008 (Better Auth upstream
  / oidc-provider downstream, no NIH protocol code), and ADR 0017 (Identity API and
  Host API stay separate; no BFF merge; polyglot boundary is WIT/Wasm).
