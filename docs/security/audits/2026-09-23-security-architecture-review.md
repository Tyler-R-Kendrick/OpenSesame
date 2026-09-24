# Audit 2026-09-23 — Security architecture review

A deep review of both planes, run as repeated passes until a pass
confirmed nothing new. Each pass split the repository by trust boundary, traced
every candidate from source to sink, and discarded anything that could not be
reached. Every confirmed finding was fixed at its enforcement boundary with a
regression test that fails without the fix. Later passes reviewed the earlier
fixes themselves; several of those fixes turned out to be incomplete or to
open something new, and were fixed again (marked *fix review* below).

Severity is the reviewer's, stated for the deployment the code ships in.

## Host API (gateway)

1. **High — an agent capability could pass as a human session.** The agent
   guard engaged only on the exact spelling `Bearer agent-capability:`, while
   `require_session` also accepted `bearer`. A cached agent token sent with a
   lowercase scheme skipped its durable grant and capability ceiling and acted
   with the principal's full session authority (delegations, relay approvals,
   connection policy). **Fix:** `require_session` accepts agent claims only
   under the canonical spelling, the guard refuses every other one, and revoking
   an agent client drops its cached claims.
   **Test:** `routes/agent_capabilities_tests.rs`.
2. **Medium — any member could rotate another member's connection and write a
   durable rotation policy.** **Fix:** a connection target must be the caller's
   own; an interval (a policy) takes owner/admin; members list only their own
   jobs. **Test:** `routes/rotation_tests.rs`.
3. **Medium — an invoke refused by OpenFGA leaked its budget hold.** Budgets
   were reserved before OpenFGA ran, and a denial returned without releasing
   them. **Fix:** OpenFGA and intent building run before the hold.
   **Test:** `pact_coverage::invoke_authorizes_fully_before_holding_budget`.
4. **Medium — hook delivery SSRF fence parsed hosts differently from the
   client.** `https://127.0.0.1\hook`, percent-encoded and full-width IPv4
   spellings passed the string splitter and reached loopback through reqwest,
   and names were never resolved. **Fix:** one WHATWG parse, resolution at send
   time with every answer vetted, and a client pinned to the vetted addresses.
   **Test:** `security/endpoint_fence.rs`.

## Optional mTLS (ADR 0132)

5. **High — an organization admin could rewrite deployment-wide transport
   admission** (bindings, trust, verify, revocation by thumbprint). **Fix:**
   those routes are operator-only. **Test:** `transport/routes_tests.rs`,
   `transport_lifecycle/routes_tests.rs`.
6. **Medium — a trust write resurrected a withdrawn SPIFFE generation and
   stale boot-time bundles**, and could overwrite a concurrent rotation.
   **Fix:** compare-and-set activation that refuses a withdrawn generation;
   bundles come from the serving generation. **Test:**
   `trust_generation_tests.rs`, `generations_cas.rs`.
7. **Medium-low — trust-profile CAS was not serialized.** **Fix:** one lock
   from load to store. **Test:** `trust_tests.rs`.
8. **Low — ingress-forwarded leaves skipped revocation.** **Fix:** the
   originating layer and certificate-bound proof consult the deny lists.
   **Test:** `ingress-evidence/tests/revocation.rs`, `proof_tests.rs`.
9. **Low — bindings CAS compared an in-memory revision across replicas.**
   **Fix:** conditional `host_kv` write and a periodic live-set refresh
   (bounded at 15 s). **Test:** `bindings_tests.rs`, `host_kv_cas.rs`.

## Identity API

10. **High — unauthenticated blind SSRF through a BYO issuer.** Back-channel
    logout fetched the discovered `jwks_uri` unchecked, and the other upstream
    fetches checked only the literal URL. **Fix:** a DNS-resolving, address
    pinned, no-redirect fetch for BYO/org discovery, registration, JWKS, SAML
    metadata, org assertions and every openid-client call; LDAP sockets refuse
    private addresses. **Test:** `ssrf-dns-fence.test.ts`.
11. **Medium — cross-tenant forced sign-out via SCIM.** An org could name the
    deployment's issuer and deprovision a non-member by email. **Fix:** SCIM
    acts only on members, a kept membership revokes nothing, and the deployment
    issuer cannot be claimed. **Test:** `scim-tenant-scope.test.ts`.
12. **Medium — unlimited SMS/email code sends.** **Fix:** a durable send budget
    per principal and per destination hash. **Test:** `mfa-code.test.ts`.

## Pages and the client core

13. **High — the GitHub App private key sat in plaintext localStorage** on a
    shared `github.io` origin. **Fix:** memory until sealed; legacy copy
    removed. **Test:** `github-app-manifest.test.ts`, `github-app-secret.test.ts`.
14. **High — any private key in the vault could be sent to the relay** by a
    "first secret containing PRIVATE KEY" fallback, including SSH keys and
    their passphrases. **Fix:** the App secret is bound by item id; the
    extractor reads one RSA/PKCS#8 block. **Test:** `github-app-secret.test.ts`.
15. **Medium — WebMCP tools skipped share reach** (TOTP codes, reveal,
    navigation), and — *fix review* — still answered `item_not_found` before
    `share_grant_denied`. **Fix:** reach is checked first on every item tool.
    **Test:** `vault-tools.test.ts`, `navigation.test.ts`.
16. **Medium-high — a duress code destroyed a sealed guest vault**, and a
    missing body opened as an empty vault. **Fix:** the decoy runs in a scratch
    tomb; a missing body with `bodyRev > 0` is corrupt. **Test:**
    `decoy-scratch.test.ts`, `store-body.test.ts`.
17. **Medium — a duress code could equal the real PIN or password**, in either
    order (*fix review* found the reverse). **Fix:** both enrollment and
    PIN/password creation refuse a collision. **Test:** `unlock-arming.test.ts`,
    `unlock-secret-collision.test.ts`.
18. **Low — `prf_and_code` triggers did not require the passkey**, and
    Settings showed an unsalted digest prefix of the duress code. **Fix:**
    two-input sealing bound to the credential; the prefix is gone. **Test:**
    `prf-and-code.test.ts`, `settings.test.ts`. Visual record:
    `docs/evidence/2026-09-23-duress-code-digest/`.
19. **Low — local Access capabilities were described but not enforced**, so a
    demoted guest could rename the claimed owner into a guest and become
    operator. **Fix:** directory, membership, application and grant
    administration check their capability. **Test:** `local-rbac.test.ts`,
    `local-rbac-member.test.ts`.

## Relay (connect-backend)

20. **High — anyone could manage the operator's Vercel Connect connectors**
    with a forged `Origin`. **Fix:** mutations need
    `OPENSESAME_CONNECT_MANAGE_KEY` and fail closed without it; `callbackUrl`
    is confined to the relay's own callback. Pages carries the key sealed.
    **Test:** `manage.test.mjs`.
21. **Medium — any RSA key drained any installation's webhook queue.**
    **Fix:** GitHub must confirm the installation first. **Test:**
    `github-app.test.mjs`.
22. **Low — SSRF through the gitea `baseUrl`.** **Fix:** bare public https
    origin or an operator allowlist; no redirects. **Test:**
    `relay-hardening.test.mjs`.

## Local host agent and bridges

23. **Medium — password-manager bridges answered lookalike and shared-suffix
    hosts** (`github.lol`, `attacker.github.io`), and — *fix review* — gopass's
    suffix walk still matched children of a shared suffix. **Fix:** no bare
    label rule, no name fallback past a `url:` trailer, no suffix walk.
    **Test:** `store_tests.rs`, `gopass_golden.rs`.
24. **Low — KDBX KDF screen failed open** (KDBX3 rounds, duplicate or
    unwalkable headers). **Test:** `limits_tests.rs`.
25. **Low — decrypted attachments and private keys written with umask
    permissions.** **Fix:** 0600 `create_new` partial file. **Test:**
    `attach_tests.rs`.
26. **Low — Bitwarden prelogin KDF parameters unbounded.** **Test:**
    `crypto.rs` tests.
27. **Latent — the git credential helper answered any host.** **Fix:** https
    and an allowlisted host only. **Test:** `helpers.rs`.

## SDKs and adapters

28. **Low — open redirect in `assertSafeReturnTo`** via tab/newline, and —
    *fix review* — via dot segments that resolved to `//evil.com`; the
    federation callback had the same shape. **Test:** `origin.test.ts`,
    `federation-callback.test.ts`.
29. **Latent — Web Push and Teams delivery could reach internal addresses;**
    introspection accepted any audience; a handoff could skip re-assertion;
    U+061C was not a display hazard.

## Dependencies

30. `pnpm audit` reported 4 high and 15 moderate advisories (nodemailer on an
    address path, hono, yaml, ws, sharp, adm-zip, vitest). All are cleared;
    `pnpm audit` reports none.

## Later passes

Passes three and four reviewed the areas the first passes left thin (host-side
duress and root protection, wallet and OAuth internals, the relay) and the
earlier fixes themselves. Each item below has a regression test beside the
fix; the sealed-store root-protection work also has its own record in
`2026-09-23-sealed-store-root-protection.md`.

31. **Medium — `pass protect root-rotate` destroyed the store**, and
    rewrap/remove did not revoke (the old key file in git history still
    opened it). **Fix:** a real rotation that re-encrypts every sealed file,
    stages, verifies nothing was missed (dot-named entries included — *fix
    review*), swaps the key file last and rolls back on failure, under a store
    lock; rewrap and remove rotate by default; the last password protector
    cannot be removed.
32. **Medium — recovery keys and TOTP seeds on argv; `pass otp uri` without
    `--reveal`; rewrap took the "new" passphrase from
    `OPENSESAME_STORE_PASSWORD`** (*fix review*). **Fix:** hidden prompts or
    stdin only, and the reveal gate.
33. **Medium — hook delivery ignored its pinned addresses behind an
    environment proxy** (*fix review*). **Fix:** `no_proxy()`.
34. **Medium — trust changes and revocations did not reach other replicas or
    survive restarts; lifecycle facts were readable across tenants; a single
    tenant could fill the revoked-leaf list** (*fix review*). **Fix:**
    conditional writes plus refresh, a durable denylist checked at admission,
    tenant-scoped reads, expiry pruning, per-org quotas and operator headroom.
35. **Low — control-plane login/claim `return_to` and SAML relay state could
    redirect off-site** (`/%09/…`, `/..//…`). **Fix:** one same-origin-path
    helper.
36. **Low — the gitea relay re-resolved names after checking them.** **Fix:**
    connect only to the vetted addresses.
37. **Low — rotating a compromised browser vault root skipped the password
    policy and the duress collision check.**
38. **Medium — pairwise `sub` followed the redirect host, not the registered
    sector**, and — *fix review* — legacy non-canonical spellings and
    concurrent registrations could still share one. **Fix:** a stored
    `sector_key` with a claims table as the arbiter; migration 0029 blocks
    unprovable legacy rows and cross-owner collisions.
39. **Latent — digest-bound approvals trusted a caller-supplied key; x402
    lacked expiry, reservations and hold release; a DPoP replay window;
    host-side duress supersede and hold overwrite; duress receiver bounds.**
40. `rustls` 0.23.45 (RUSTSEC-2026-0285) and `chacha20` 0.10.2 (yanked);
    `cargo audit` reports no vulnerabilities.
41. **Medium — a sealed-store name ending in `/` escaped the rotation walk**
    (*fix review*). `Dev/` was written as `Dev/.osseal`, a file with no stem
    that the walk, `ls`, GC and sync all skipped: it stayed under the old
    root, and an attachment named that way lost its chunks to the rotation's
    prune. **Fix:** names with an empty, `.` or `../..` segment are refused
    before any write, and a stemless `.osseal` / `.osattach` found on disk
    makes the walk fail closed.
42. **High — migration 0029 keyed some legacy sectors wrongly** (*fix
    review*). Postgres has no `\v` escape, so `btrim(..., E' \t\n\r\f\v')`
    also stripped the letter `v`: `https://app.dev` was keyed as
    `https://app.de`. **Fix:** only space, tab, CR and LF are trimmed; any
    other padding refuses the row. A parity test runs more than 10k generated
    spellings through the SQL and checks each against `sectorKeyOf`. The
    backfill also gives a key to its earliest client, revoked or not.
43. **Medium — a sector could be squatted for good** (*fix review*). The first
    registrant of someone else's sector held its key permanently, and nothing
    showed they controlled it. **Fix:** a registrant proves the sector (every
    redirect URI on its host or a subdomain, or an OIDC
    `sector_identifier_uri` document on that host listing them), and an
    operator can release a key: its clients are blocked and the claim
    generation moves on, so the next owner's users get fresh pairwise
    subjects.
44. **Medium — rotating a released client took the sector back** (*fix
    review*). `POST /v1/oauth/clients/:id/rotate` copied a client under a new
    id without the release block or the ownership check, so a squatter undid
    an operator release at once; the in-memory store also let two owners
    share a key and generation. **Fix:** rotate refuses a blocked client and
    runs registration's ownership check; the memory store applies the
    Postgres claim rule; a release can name the next owner. A later pass
    found a rotation could still race an open release between its check and
    its insert; a rotation now keeps only a key its owner holds, from an
    unblocked predecessor, decided under the claim row lock the release takes.
45. **Low — protector edits took the shared store lock**, so an `add`
    racing a `remove` could write the removed protector back. **Fix:** key-file
    edits hold the exclusive lock.


Passes six to nine re-reviewed each of those fixes in turn; the ninth
reported no confirmed findings.

## Operator-visible changes

- Relay-managed Connect: create, authorize and revoke now need
  `OPENSESAME_CONNECT_MANAGE_KEY` on the relay and the same key sealed in the
  Pages vault. Pages has no entry for that key yet, so these three actions are
  refused from Pages until one is added; listing still works.
- Transport verify, bindings and trust writes are operator-only, so an org
  admin session calling them from Pages now gets 403.
- The git credential helper reads `OPENSESAME_GIT_HOSTS` (default
  `github.com`).
- `pass protect rewrap` and `remove` now rotate the root key (re-encrypting
  the store); `--no-rotate` opts out with a warning. Sealed-store writes
  refuse while a rotation holds the store lock.
- OAuth clients whose declared sector differed from their redirect host, or
  whose legacy sector spelling cannot be canonicalized with certainty, or
  that collide with another owner's sector, must re-register (migration 0029).
- Every gateway replica must run this version before any tenant revokes a
  leaf. An older replica cannot parse the new denylist document: it refuses
  to boot on it, and a running one stops refreshing it, so it keeps admitting
  leaves revoked after the upgrade until it is replaced. Do not roll back
  past this version once a revocation has been written.
- OAuth client registration and redirect-URI PATCH now refuse
  (`400 sector_not_proven`) a redirect URI outside the declared sector's host
  unless `sectorIdentifierUri` names a document on that host listing every
  redirect URI. Loopback redirects are exempt only on dev defaults.
- `POST /v1/oauth/admin/sectors/release` (operator token) releases a squatted
  sector key; the holder's clients stop working. Pass `nextOwnerPrincipalId`
  to hand the key to its rightful owner; otherwise the key goes to whoever
  next registers with proof of the sector.
- A sealed-store entry written under a name ending in `/` (stored as
  `…/.osseal` or `…/.osattach`) now stops rotation and GC. Rename it with
  git to a real name before rotating.

## Not changed

- A client PATCH locks the client row and then the sector claim; an operator
  release locks the claim and then the client rows. On a multi-connection
  Postgres the two can deadlock, and Postgres aborts one of them (a 500 the
  caller retries). Neither commits a partial change, so this is an
  availability edge on an operator action, not an authorization gap.

- A sector can still be claimed by naming redirect URIs on the victim's own
  host. Such a client can never receive codes, so the worst it does is hold
  the key, which an operator release clears. The subdomain rule trusts every
  subdomain of the sector host, so a shared parent domain that is not on the
  Public Suffix List can be claimed by one of its tenants.

- The durable denylist is bounded. Once tenants together hold the tenant
  share (the list less the operator reserve) in unexpired revocations, a
  further tenant revocation is refused with `denylist_full`; bindings, the
  in-process deny and the notice still apply, and the operator reserve still
  admits operator revocations. Filling it takes many orgs' worth of issued
  certificates, so this is a capacity limit, not a cross-tenant bypass.

- An egress allowlist entry without a port still admits any port on that
  host. The credential only reaches the allowlisted host, and the broker's own
  tests rely on it, so this stays a hardening note.
- The Trigger codes panel in Settings is never mounted in a shipped build
  (`resolveDuressMode({})` is always `off`), so duress enrollment has no UI.
  That is a product gap, recorded in the evidence README.
