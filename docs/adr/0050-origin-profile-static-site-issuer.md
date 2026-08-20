# ADR 0050 — Origin-profile issuer for zero-backend static sites

Status: Accepted
Date: 2026-08-20
Supersedes: the unmerged `feat/static-auth-broker` branch (2026-08-07),
whose branch-era "ADR 0032" collided with this repo's ADR 0032
(connection broker); that draft is withdrawn, this ADR is its successor.
Completes: ADR 0012 (client admission modes), ADR 0034 §6 (the deferred
server-side slice), ADR 0011 (pairwise sectors, per admission mode).
Related: ADR 0008, 0010, 0014, 0016, 0017, 0033.

## Context

Static sites have no backend: no place to hold a client secret, no token
route, no session store. ADR 0034 shipped the zero-infrastructure half
of the answer — the Pages PWA relays an *upstream* IdP's token to a
consented relying-party origin — and its §6 deliberately deferred the
other half: "a correctly audienced, per-RP token requires an issuer
with a key, which requires a server. That is a hosted deployment
concern." An unmerged branch (`feat/static-auth-broker`, +11.4k LOC,
14 commits) prototyped that hosted half: the OpenSesame Identity API
acting as a first-class OIDC issuer for static sites, with the
`client_id` *derived* from the site's canonical web origin instead of
registered. The branch went stale (117 commits of drift, 20 real
conflicts, unfinished stubs) and was never mergeable as code — but a
design-level review (this ADR) found its decisions overwhelmingly
compatible with, and often anticipated by, main's current ADR set.
This ADR merges the *features and requirements*, not the
implementation, and re-makes the six decisions where main has since
grown constraints the branch predates.

The problem restated as requirements: a genuine static site (GitHub
Pages, S3+CDN, any host with no server component) must be able to run
a standards-based sign-in flow against an OpenSesame deployment and
receive a per-origin, per-user token — with no registration dashboard,
no client secret anywhere, no implicit trust, and no weakening of the
ownership, consent, and audit fences the identity plane has since
built (audit tick 35: every client owned, owner-fenced, quota-limited;
ADR 0011: pairwise subjects; ADR 0014: opaque access tokens; ADR 0033:
explicit issuer trust).

## Decision

The Identity API gains a fourth, flag-gated client-admission mode in
which `client_id` is derived, never registered: `origin:<canonical
origin>`. The mode stays off unless `OPENSESAME_ORIGIN_CLIENTS_ENABLED`
is set, exactly as ADR 0012 already stubbed. Seven features (F1–F7),
six rulings (R-A–R-F) where main's constraints override the branch's
prototype.

### Features adopted

**F1 — The canonical origin is the security boundary.** Strict
canonicalization, symmetric in SDK and server: HTTPS only, except HTTP
on loopback in non-production; no userinfo/path/query/fragment;
lowercase host; default ports stripped; non-default ports preserved
and *distinct* (`:4101` ≠ `:4102` ⇒ distinct clients, distinct pairwise
subjects). Typed errors per violation. This completes the
`origin:{origin}` convention `docs/architecture/federated-signin.md`
already declares canonical.

**F2 — Split admission.** The authorization path may auto-admit a
first-seen origin client (atomically — unique-violation reload decides
races). The token path is lookup-only and never inserts, so
unauthenticated `/token` probes cannot flood the database with origin
rows. The public registration API (`POST /v1/oauth/clients`) stays
`pre_registered`-only; auto-admission is a server-internal path.

**F3 — Exact-origin CORS on the token endpoint, never reflected.**
For a derived public client, the Origin header of a `/token` request
must byte-equal the client's persisted canonical origin; any mismatch
(or a missing/`null` Origin) is denied with *no*
`Access-Control-Allow-Origin` header. The allowed case reflects only
the stored origin, with `Vary: Origin` and no-store cache directives.
This is the substitute for the client secret a static site cannot
hold, and ADR 0034 already endorses CORS-on-token for brokers.
Implemented at the oidc-provider split in `server.ts`, not in Hono
middleware, and fail-closed in production per the existing CORS rules.

**F4 — Derived clients carry a fixed public-client profile.**
`token_endpoint_auth_method: "none"`, grant `authorization_code` only,
response `code` only, PKCE S256 mandatory (already required for all
clients), `subject_type: "pairwise"`, redirect URIs pinned to
`<origin>/opensesame/callback`, scope `openid` only; `offline_access`,
`admin`, and `opensesame.admin` are denied at admission (the
`openidensesame.admin` typo that disabled the last guard was fixed in
PR #164). No `client_credentials`, no `implicit` — the contracts
package already forbids declaring either.

**F5 — Durable ownership via a well-known claim document.** An origin
client begins life unclaimed. A verified principal claims it by
hosting `https://<origin>/.well-known/opensesame-client.json`
containing a single-use, short-TTL (≤ 600 s) challenge issued by the
Identity API; verification fetches the document SSRF-safely (the CIMD
`SafeMetadataFetcher` machinery), requires exact field match, and
consumes the challenge once. Verified aliases (`client_origins`) map
additional origins onto the same application and sector, so custom
domains share a stable pairwise sector while each origin keeps its own
public client id. This is an explicit human act — it does not create
implicit trust (ADR 0033).

**F6 — A consent UI that discloses auto-admission.** The Identity
API's interaction slot is deliberately blank today (devInteractions
off). The origin-profile flow introduces login/consent pages that show
the exact canonical origin and badge unclaimed auto-admitted clients
("Automatically admitted application"). Consent semantics match ADR
0034 §3: per-origin, human-given, remembered (the `consents` table is
already modeled), widening re-prompts, individually revocable, PII
only on consent.

**F7 — RP-facing SDK surfaces.** `sdk-browser` grows a zero-config
mode: no `clientId` ⇒ derive `origin:<canonical origin>`, redirect
`<origin>/opensesame/callback`, validate the ID token in-browser
(RS256/ES256, iss/aud/nonce), scrub code/state from the URL,
sessionStorage by default, refresh tokens memory-only, `returnTo`
restricted to same-origin relative paths. `sdk-server` grows typed,
fail-closed `verifyIdToken` and RFC 7662 introspection, extending the
existing fenced JWKS verifier.

### Rulings (main's constraints override the prototype)

**R-A — Ownership: auto-admitted clients have a deployment/system
owner; claiming transfers ownership.** The branch made owners nullable.
Main requires an owner on every client with owner-fenced reads
(404-not-oracle), registration quota, and verified identity for
mutations. Auto-admission therefore assigns the deployment/system
principal as owner; a successful F5 claim *transfers* ownership to the
claiming verified principal. No fence weakens.

**R-B — Suspend/revoke is durable from day one.** The branch shipped
an admittedly non-durable in-memory overlay; that stub is rejected.
Main already models `active|suspended|revoked` with audit events; the
port wires those transitions to durable storage and adds a
deployment-admin actor that may suspend/revoke clients it does not own
— a new role, granted the same audit trail and no-oracle properties.

**R-C — The Postgres client store is wired, not merely modeled.**
Main's control plane still keeps clients in a process-local Map; the
branch assumed Postgres. This feature includes wiring the durable
repository (with the in-memory store remaining for tests/dev), because
requirement R11 (pairwise subjects survive a restart) is binding in
production. This also closes main's own latent durability gap.

**R-D — Derived sectors bypass the registration-API sector schema.**
`SectorIdentifierSchema` is HTTPS-only; loopback HTTP origins are a
supported development case (F1). Derived sectors are constructed
internally and never traverse the public registration schema. The
cross-owner sector-claiming fence (audit tick 35) still applies.

**R-E — Opaque access tokens stay (ADR 0014).** The branch's only
token-format change aligned with a decision main had already made;
nothing to port. RPs validate via introspection/userinfo; ID tokens
remain the only JWTs, asymmetrically signed.

**R-E2 — Keycloak upstream work is separable and deferred.** The
branch's `auth-upstream` issuer+sub mapping commit implements ADR 0016
but main has rewritten that package far past the branch's base. It is
not part of this feature program; it gets its own gap-check.

### Acceptance requirements (the branch's adversarial corpus, adopted)

The ported feature must pass, as real-endpoint tests: CORS
non-reflection on preflight (R1); 403 `origin_cors_denied` on Origin
mismatch (R2); success only from the exact persisted origin with a
truthful pairwise sub (R3); no code without PKCE, without verifier, or
with `plain` (R4–R6); production HTTP origins rejected (R7);
port-distinct clients and sectors (R8); `offline_access` denied and
public-client profile pinned (R9); pairwise sub isolation across
origins (R10); pairwise sub survives a control-plane restart with a
database (R11); discovery advertises auth/token/jwks (R12); full
browser round trip including reload persistence and sign-out (R13).

### Explicitly not carried over

`.swarm/` agent scratch; the duplicate `deploy/keycloak/` stack; the
in-memory suspend/revoke overlay and the Claimsmith stub (R-B); the
branch's drizzle journal (regenerated as the next additive migration);
any renumbering of this repo's ADRs 0001–0049.

## Consequences

- ADR 0034's deferral is discharged: both directions now exist —
  static RP → Pages relay → external IdP (shipped), static RP →
  OpenSesame issuer directly (this ADR), and Pages relay → OpenSesame
  issuer as a configured trusted upstream (configuration only, since
  the origin-profile issuer satisfies every admissibility requirement
  in `docs/architecture/federated-signin.md` §1).
- The mock upstream IdP now satisfies that contract for origin-profile
  clients (`origin:{canonical}`, exact-origin CORS on `/token`,
  per-origin `sub`/`pairwise_sub`) while keeping the seeded confidential
  client for Better Auth.
- Landing shape: stacked slices — (1) oauth-provider origin machinery,
  (2) migration + durable store wiring, (3) control-plane routes and
  consent UI, (4) SDK surfaces, (5) adversarial corpus + e2e +
  example RP, (6) mock IdP contract completion. Each slice passes the
  full local gate independently.
- Residual risks, unchanged from the prototype's own threat analysis
  and recorded in the identity threat model: XSS on the static origin
  can use in-tab session material; www-vs-apex and port changes create
  distinct clients (operators deploy one canonical origin); path-based
  apps on one origin share a client id.
