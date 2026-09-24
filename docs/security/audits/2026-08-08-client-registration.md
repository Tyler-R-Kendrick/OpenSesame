# Audit tick 62 — what a client may say about itself

Scanners (cve-lite, semgrep, ast-grep, gitleaks, cargo-audit, cargo-deny) were
clean. The reading was `packages/oauth-provider` and the client registration path
in `apps/control-plane`.

## A registration could widen its own flows (fixed)

`CreateOAuthClientRequestSchema` took `grantTypes`, `responseTypes`, and
`tokenEndpointAuthMethod` as free-form strings. A registrant could therefore
declare `implicit`, `client_credentials`, or token exchange for itself, and
`responseTypes: ["token"]` — a token delivered in a URL fragment with no PKCE, or
a client acting with no user behind it.

The provider happens to disable `clientCredentials` today, which is why this was
inert rather than exploitable. That is a property of the current provider
configuration, not of the record; the record is what admission reads
(`assertAdmissible` consults `client.grantTypes`) and what a future wiring would
hand to the provider. All three fields are now allowlisted: authorization code,
refresh, and device code; `code` responses only; and a known set of client
authentication methods.

## Any principal could claim another's sector identifier (fixed)

`sectorIdentifier` was `z.string().min(1)` — any label, claimable by anyone. A
sector decides which pairwise subject a client sees, so two clients sharing one
see the same `sub` for the same person. Registering a client under another
owner's sector was therefore a way to learn the subject that owner's clients see,
which is exactly the linkage pairwise subjects exist to prevent.

Two changes: a sector identifier must now take the spec's form (an https URL with
no query, fragment, or credentials), and registration refuses with `409
sector_identifier_taken` when a live client belonging to a *different* principal
already uses it. Sharing a sector between one owner's own clients stays allowed —
that is a deliberate choice about which of their clients see one subject.

## Read and left alone

- `resolveJwks` refuses an ephemeral keypair in production, and a persistent
  adapter is required there too, so grants and revocation survive a restart.
- `getResourceServerInfo` rejects any resource indicator outside the allowlist
  (`invalid_target`), and audiences are canonicalized before use.
- Redirect URIs were already confined to https, loopback http, and reverse-DNS
  private-use schemes, with no fragment or credentials.
- `MemoryPairwiseSubjectStore` mints a random 32-byte subject per
  (principal, sector) and persists the mapping, so no secret rotation can rewrite
  subjects.
- `rotate` mints a new client id and revokes the old; it is not a secret rotation
  because this registry holds no client secrets.
