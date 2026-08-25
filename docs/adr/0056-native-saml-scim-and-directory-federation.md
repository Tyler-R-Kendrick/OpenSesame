# ADR 0056: Native SAML SP, SCIM provisioning, and directory federation

## Status
Accepted. **Supersedes ADR 0016 for the SAML service-provider half.**

ADR 0016 decided that OpenSesame would not implement SAML and that an optional external
Keycloak would broker enterprise directories to OIDC. That is superseded here for the SP
side: a tenant can configure a real SAML IdP — Okta, Entra, ADFS, Shibboleth — directly. The
Keycloak-brokered path remains fully supported and is not deprecated: an organization whose
`samlIssuer` names a brokering Keycloak and which configures no SAML metadata keeps the
ADR 0016 behaviour exactly, and `tenantAuthMethods` distinguishes the two. This decision is
additive. (ADR 0016's LDAP half is superseded separately, in ADR 0057.)

## Context
ADR 0016's reasoning was sound when it was written: XML signature verification is a famously
sharp edge, and brokering it to a mature product avoided the edge entirely. What changed is
the deployment cost. Requiring every enterprise customer to stand up and operate a Keycloak
in front of an IdP they already run is a large ask for a feature — "sign in with our Okta" —
that competitors treat as table stakes, and it puts a second identity system in the trust
path for no benefit the customer can see.

The sharp edge is real, and the answer to it is the same one ADR 0008 gives everywhere:
XML-DSig comes from a mature library and is never hand-rolled. `@node-saml/node-saml` owns
signature verification, condition windows and audience restriction. What this codebase owns
is everything around that: *which* IdP's key a response is judged against, whether the request
it answers is one we made, and whether the assertion has been seen before.

## Decision

### 1. A native SAML 2.0 service provider, both flows
`GET /v1/saml/metadata` publishes the SP EntityDescriptor (entityID =
`{publicUrl}/v1/saml/metadata`, ACS = `{publicUrl}/v1/saml/acs`, HTTP-POST binding,
`WantAssertionsSigned`, `AuthnRequestsSigned="false"` — this SP holds no signing key, and
claiming otherwise would make every IdP that honours the flag reject our requests). The
document's id is stable across reads, because metadata is a file IdP operators diff and a
fresh random id on every fetch makes every fetch look like a change.

`POST /interaction/:uid/federated/saml` starts SP-initiated sign-in (an HTTP-Redirect
AuthnRequest); `POST /v1/saml/acs` consumes the response for both flows.

### 2. SAML pending state is server-side, and the hand-back is a completion code
The ACS receives a cross-site POST from the IdP, so it carries **no** `SameSite=Lax` cookie —
neither the pending-state cookie nor oidc-provider's interaction cookie. This is the same
physics as Apple's `form_post` (ADR 0055 §4), but the Apple remedy does not transfer: Apple's
response is four short parameters that fit in a redirect query, and a SAML response is
multiple kilobytes of base64 XML that cannot be re-materialized into a GET.

So the binding lives on the server. `beginSamlAuth` generates the AuthnRequest id itself
(before the browser can possibly return) and writes `{requestId, interactionUid,
organizationId, createdAt}` to a durable, single-use pending store. After the assertion
verifies, the ACS issues a short-lived single-use **completion code** and 303s to
`GET /interaction/:uid/federated/saml/complete?otc=…` — a top-level GET, which does carry the
Lax cookies — and that route resumes the interaction through the normal find-or-mint and
JIT-join path. The completion route additionally requires the code's recorded
`interactionUid` to equal the one in its own path: a code spent against a different
interaction would sign this browser in on somebody else's ceremony.

The two durable halves (the request→interaction binding and the replay cache) live in
`ctx.stores.saml` and are Postgres-backed wherever a database is configured. The completion
code is process-local: it covers the few seconds between a 303 and the GET it provokes, for
one browser, and carries no authority beyond naming an assertion this process just verified.

### 3. The request binding is the *signed* `InResponseTo`
`<samlp:Response InResponseTo="…">` is not covered by the assertion's signature; an attacker
can rewrite it freely. The copy inside `<SubjectConfirmationData InResponseTo="…">` is inside
the signed assertion. So the unsigned wrapper value is used only for **routing** — deciding
whose certificate answers for this response — which is safe precisely because it only ever
chooses a verifier, and a response naming somebody else's tenant is then judged against that
tenant's certificate and fails. The binding itself is checked against the signed copy after
verification.

The converse is checked too: an assertion carrying a `SubjectConfirmationData/@InResponseTo`
that arrives with the wrapper's `InResponseTo` stripped is refused. That shape is somebody
else's SP-initiated assertion re-posted as an IdP-initiated sign-in, not an IdP-initiated
sign-in.

`node-saml`'s own `InResponseTo` cache is deliberately bypassed
(`ValidateInResponseTo.never`), because the durable store is the binding and the signed
attribute is the check.

### 4. `wantAssertionsSigned`, and why that is what defeats signature wrapping
The SAML client is built with `wantAssertionsSigned: true` and
`wantAuthnResponseSigned: false`. Requiring the enclosing Response to be signed as well would
be stricter than most real IdPs (Okta and Entra sign the assertion only) and buys nothing
here, because every field this SP acts on is read from the verified assertion and never from
the unsigned wrapper.

What defeats XML signature wrapping is where the library looks for the signature. It selects
`./*[local-name()='Signature']` **on the assertion node itself** — a direct child, not a
descendant — refuses the document if more than one such signature is present, and refuses a
signature carrying more than two `Transform` elements. A wrapping attack works by leaving a
correctly signed element somewhere in the tree and putting the attacker's assertion where the
SP reads its claims; a verifier that only accepts a signature that is a direct child of the
element it is about, and then reads claims only out of that verified element, has no gap for
the two to diverge. The negative suite pins this: unsigned, signature-over-the-wrong-element,
and re-signed-wrapped assertions are all refused.

After verification the code re-checks the things the library does not: the *assertion's* own
`Issuer` must equal the tenant's configured IdP entityID (node-saml checks this only on the
logout paths), the signed `InResponseTo` must match, and the assertion id must not be a
replay.

### 5. IdP-initiated sign-in, under named controls
IdP-initiated SAML is accepted — real deployments use tile-launch — with four controls:

- **Signature required**, as above; there is no request of ours to bind to, so the signature
  and the audience are the whole of the trust.
- **`Audience` must equal our SP entityID.** The SAML client is constructed with `issuer` and
  `audience` set to the same string, deliberately: an assertion minted for a *different* SP at
  a shared IdP cannot be replayed here even with a perfectly valid signature.
- **A replay cache.** Assertion ids are recorded until the assertion's own `NotOnOrAfter` (or
  the five-minute maximum age when it declares none); a second sight is refused. Condition
  windows get 30 seconds of clock skew and no more — the value of a short window is that it is
  short, and an SP that accepts minutes of skew has converted a one-shot assertion into a
  bearer token with a long life.
- **`RelayState` is honoured only when it resolves to this deployment's own origin**, and must
  be shaped like a location (rooted path or absolute URL) rather than a bare relative string.
  A protocol-relative `//evil.example/x` passes the shape test and fails the origin test,
  which is exactly why both are asked. Anything else lands on `/`.

With no interaction to resume, that flow owns the whole admission itself: find-or-mint,
JIT-join, the provisional cookie on a 303, and a `principal.saml_idp_initiated` audit event.

The ACS answers every refusal — unknown request, bad signature, wrong audience, replay,
unconfigured tenant — with one sentence and one status. Those are four different facts about
our internal state, and answering them differently would let a stranger map which
organizations exist, which requests are outstanding, and which assertions are spent. Detail
goes to the log with a correlation id.

### 6. NameID is the subject; an email-format NameID is still a subject
The identity row is `kind: "saml"`, `issuer` = the IdP entityID **resolved from the tenant's
configuration** (not from the assertion — the row must name what this deployment trusts, not
what the document claimed), `subject` = the NameID value, with the NameID `Format` recorded in
the identity row's metadata. The format is provenance: it is what tells a later reader whether
this subject is a stable opaque identifier or an address the IdP happened to spell as one.
`persistent` is requested.

SAML attributes (`mail`, the standard OID and claim spellings, display name) are read for
**display only** and never reach `emailNormalized`. A SAML attribute carries no verification
signal an SP can trust, and an `emailAddress`-format NameID is a subject string that looks
like an address — treating either as a verified email would hand ADR 0057's auto-link a key
that the tenant's IdP administrator can set to anything.

### 7. SCIM 2.0, Users first, and no principal at provision time
Per-organization endpoints under `/v1/organizations/:organizationId/scim/v2`, authenticated by
an org-scoped provisioning token. Users: POST create, GET by id, GET with `userName eq "…"`,
PATCH (including `active`), DELETE (which SCIM treats as deactivation intent). Groups: a
minimal PATCH that maps a configured group *name* to an org role; everything else in Groups is
accepted and ignored, per SCIM's leniency norm. Errors use the
`urn:ietf:params:scim:api:messages:2.0:Error` envelope, because a bare `{error}` is reported
by Okta as an unknown failure with no detail.

Two rules shape it:

- **No principal is minted at provision time.** A provisioned row is the organization's
  standing answer to "may this subject join when it eventually signs in?" and nothing more.
  The identity is created by whichever leg actually verified an assertion; `jitJoinOrganization`
  consults these rows when the tenant marks provisioning authoritative and answers
  `not_provisioned` for a subject that is absent or inactive. A directory push can therefore
  never manufacture an account nobody authenticated as.
- **Deprovisioning bites immediately.** Deactivation drops the membership *and* every session
  it authorized, through the same `revokeOrganizationMembership` helper the LDAP sync uses. A
  deactivation that left live bearers behind would leave a departed employee signed in for the
  rest of the session TTL, which is the one failure mode directory sync exists to prevent.
  `active` is read as both a boolean and the string `"False"`, because Okta sends the first and
  Entra sends the second, and reading only one is the classic way a deprovisioning push
  silently does nothing.

**Token custody.** A provisioning token (`sct_` prefix) is shown exactly once, in the mint
response, and only its SHA-256 digest is stored; verification hashes the presented bearer
before comparing. A read of the database therefore never yields a usable credential, and no
token material reaches a log or an audit row. An unknown organization, a suspended one, a
missing bearer and a wrong bearer all answer the same 401 — anything else makes this an
org-existence oracle.

### 8. Home-realm discovery, and email as routing only
An organization owner claims an email domain, publishes a DNS TXT record
`opensesame-domain-verify=<token>`, and verifies it. Only **verified** domains route: a claim
is an assertion by whoever typed it into the settings page, and honouring an unverified one
would let anybody redirect a competitor's employees to their own IdP. Proof is DNS and only
DNS, through `node:dns/promises`; the obvious alternative — fetching
`https://<domain>/.well-known/…` — would hand an org owner a server-side request to an
arbitrary host, which is precisely the SSRF gadget the rest of this codebase spends
`assertSafeMetadataUrl` avoiding. The published record is compared against the expected one in
constant time over digests, because the token is a secret until it is published.

The login page's "Continue with your work email" field is a **router**. The server splits on
the last `@`, keeps the domain, and 303s to `GET /interaction/:uid?org=<slug>`. The local part
is never bound to a name, never logged, never audited and never stored; the address never
becomes an identifier on this path. That is the opposite of the magic-link field (ADR 0057),
where the address IS the identifier, deliberately — and both rules hold at once precisely
because they are on different routes with different code. Unknown domain, claimed-but-
unverified domain and "not an address at all" all re-render the same sentence.

### 9. Back-channel logout replaces custody of upstream refresh tokens
The legs request no offline scope. If an upstream issues a `refresh_token` anyway it is never
persisted — the identity plane taking custody of somebody else's long-lived credential is
exactly what ADR 0005's posture forbids — and where discovery advertises a
`revocation_endpoint` it is also handed back, best-effort behind a three-second timeout and
fire-and-forget. Dropping it is the real guarantee; revoking it is a courtesy that must not be
able to fail a sign-in that has already succeeded.

Session freshness therefore comes from OIDC Back-Channel Logout 1.0:
`POST /v1/federated/backchannel-logout` takes a form-encoded `logout_token`. It is an
unauthenticated POST that destroys sessions, so the fences are the design: the claimed issuer
must resolve through the ADR 0055 trust fence *before* a single byte is dereferenced (so the
endpoint cannot be pointed at a third party); the signature must verify against that issuer's
JWKS, fetched through the same guard as everything else and cached per JWKS URI so the
endpoint is not a reflection amplifier; the `events` claim must carry the backchannel-logout
event; `iat` must be within 120 seconds; and `sub` or `sid` must be present. There is a
per-issuer budget and a global one — the per-issuer key comes from the *unverified* token, so
only a global ceiling bounds an attacker minting a fresh issuer per request.

**A `nonce`-bearing logout token is rejected.** §2.6 of the spec forbids the claim, and the
reason is the whole point: `nonce` is an id_token's claim, and accepting one here would let a
captured id_token be presented as an instruction to sign that person out.

**A token that verifies always answers `200` with an empty body** — matched a live session or
matched nobody, ended a membership or ended nothing. Answering differently would turn the
endpoint into an oracle for "does this person have an account here". What actually happened is
recorded in the audit trail, not in the response. (A token that does not verify at all answers
`400`; that says nothing about any subject.)

### 10. The PWA's `signIn` narrowing is reversed, deliberately
`apps/pwa/src/sdk-browser.ts` deliberately narrowed the client type to
`Pick<…, "getSession" | "continueAnonymously" | "signOut">`, and that narrowing was pinned by
its own pact test. It widens to include `signIn`. The narrowing existed because there was one
provider and no catalog to choose from; with a catalog, an app that cannot offer sign-in is
the odd one out among the three surfaces. Reversing a deliberate narrowing deserves to be
recorded rather than discovered in a diff, which is what this paragraph is.

## Consequences
- This codebase now parses XML from strangers. That was ADR 0016's whole objection and it has
  not evaporated — it is bounded instead: one pinned mature library for signatures, a size cap
  before parsing, one parser (the library's own) shared by verification and by the two
  attributes we read afterwards, so "what we routed on" and "what was verified" cannot be
  different documents. A negative test suite covering unsigned, wrong-element, wrapped,
  wrong-audience, expired, future-dated and replayed assertions is part of the feature, not an
  optional extra.
- `@node-saml/node-saml` is a new runtime dependency, exact-pinned, MIT, and inside
  `pnpm audit:osv`'s scope. A finding in its transitive closure is handled by pinning forward,
  never by an ignore. One import reaches past the package root
  (`@node-saml/node-saml/lib/xml.js`) for the parser the library itself validates with; the
  package publishes no `exports` map, so the path is stable for the pinned version and must be
  re-checked when the pin moves.
- SAML pending state and the replay cache are storage the sign-in path depends on. A
  memory-store deployment loses in-flight SAML requests on restart (the browser starts again);
  a Postgres deployment does not.
- SCIM makes an organization's directory authoritative for membership when it opts in, which
  means a misconfigured directory can lock a tenant's own people out. That is the intended
  direction of failure — the alternative is a deprovisioned employee keeping access — and it is
  opt-in per organization (`provisioningEnabled`).
- Email domains are globally unique across organizations, first claim wins. A domain already
  claimed answers 409 without naming the holder.
- The ACS, the metadata endpoint and the back-channel logout endpoint are unauthenticated by
  protocol. Each carries its own fence (a signature, nothing to leak, a signature plus rate
  limits respectively), and each answers uniformly.

## Related
- ADR 0005 — no custody of raw upstream credentials
- ADR 0008 — mature libraries over NIH protocol code
- ADR 0016 — Keycloak brokering (superseded here for the SAML SP half; the brokered path stays)
- ADR 0033 — federated identity admission
- ADR 0055 — provider registry, BYO, org sign-in and the trust fence this reuses
- ADR 0057 — verified-email linking, Better Auth, native LDAP (supersedes ADR 0016's LDAP half)
- `docs/architecture/federated-signin.md` §12–§13 — the wire contract
