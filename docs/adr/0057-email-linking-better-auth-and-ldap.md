# ADR 0057: Verified-email linking, the Better Auth mount, and native LDAP

## Status
Accepted. This ADR records three decisions the product owner made explicitly. Each reverses a
previous one, and each reversal is a decision rather than a discovery:

- **Supersedes ADR 0052 §6** ("Better Auth is not mounted for this"). Better Auth is mounted,
  in a complementary role.
- **Supersedes ADR 0016's LDAP half.** OpenSesame speaks LDAP natively. (Its SAML half is
  superseded in ADR 0056; the Keycloak-brokered path remains supported in both cases.)
- **Changes the long-standing rule in `docs/identity-linking.md`** that email is never a join
  key. A *verified* email is now a secondary join at admission. That file has been rewritten
  to match; this ADR is the reason.

## Context
Three constraints held simultaneously in the old design, and the third stopped being worth
its price.

ADR 0033 and `docs/identity-linking.md` said the external-identity tuple
`(kind, issuer, tenant, subject)` is the only key and email links nothing. That rule exists
because an IdP that lets a human type any address into a profile field would otherwise be an
account-takeover path — a completely sound reason to distrust *unverified* email, which was
being applied to all email.

The observable cost is duplicate accounts. The same person signing in with Google and later
with their employer's Okta gets two principals, two personal projects, and no way to reconcile
them short of the merge path, which is fenced behind dual authentication for good reasons that
are not going to change. Every product this competes with links on a verified address.

Meanwhile `packages/auth-upstream`'s Better Auth factory had been installed and unmounted
since ADR 0008, and ADR 0052 §6 recorded three reasons not to mount it as a *federation*
engine. Two of those reasons remain true and are respected below. The third — "nothing depends
on it today" — was an argument for declining an option, not against a use that has since
appeared: email magic-link, which is a verified-email admission path and composes exactly with
the linking decision above.

## Decision

### 1. Verified-email auto-link at admission
`attachVerifiedExternalIdentity` is already the single admission chokepoint for every leg. It
gains one branch, and the exact policy is:

1. Look the tuple `(kind, issuer, tenant, subject)` up. A hit owned by the caller is
   idempotent; a hit owned by anyone else is `identity_collision`. **Unchanged.**
2. On a tuple miss, and **only** if THIS sign-in asserts `emailVerified === true` and carries
   an `emailNormalized`, ask `findVerifiedByEmail` whether an existing principal already owns
   a **verified** identity with that normalized address.
3. A match owned by a *different* principal: the new identity row is created against **that**
   principal, and that principal is promoted if it was provisional. A match owned by the
   caller is not a match — there is nothing to move.
4. No match, or an unverified or absent email: today's behaviour exactly — the identity is
   created against the caller's principal.

Both ends must be verified. The stored side is restricted to verified identities by the
repository; the asserted side must say so on this sign-in. Requiring both is what makes an
IdP that hands out unverified addresses unable to reach an existing account at all, which is
the account-takeover path the original rule was written against. That rule has not been
relaxed — it has been narrowed to the case it was actually about.

An unverified email that collides with somebody else's still produces the *denied*
`principal.identity_link_email_collision` audit event and then links normally by tuple: it is
evidence for a human reading the trail, never a matching rule.

A successful email join emits `principal.identity_email_linked` naming the *existing*
identity's kind and issuer, alongside the usual `principal.identity_linked` naming the new
one, under one correlation id — so both ends of the join are reconstructible.

### 2. Determinism in code, not in a constraint
`external_identities.email_normalized` stays indexed and **not** unique. Pre-existing rows may
already share an address — the column was deliberately non-unique — so a migration adding a
unique constraint would fail on live data, and is out of scope besides.

`findVerifiedByEmail` is therefore deterministic by construction: among verified candidates it
returns the one whose owning principal was created earliest, tie-broken by principal id and
then by identity id. Oldest-owner-wins is the only ordering that is stable as new identities
arrive: any "most recent" rule would make the same sign-in land on different principals
depending on unrelated activity elsewhere. Both the memory and the Postgres implementation
apply the same ordering and are held to it by a shared parity spec.

### 3. This attaches an identity; it never fuses principals
The branch runs at admission — find-or-mint — and creates one new identity row against a
principal that already exists. It never merges two already-durable principals; that is
`principal.merge`, which remains in the pinned high-risk deny list and still requires dual
authentication. Explicit cross-principal linking through
`POST /v1/principals/link-identities` still answers 409.

**Consequence callers must handle:** `attachVerifiedExternalIdentity` may return an identity
owned by a *different* principal than the one the caller passed in. Every admission callsite
therefore binds the session to `result.identity.principalId`, never to the id it just minted,
and issues the browser a provisional bearer only when those two are the same — handing over
the throwaway principal's bearer would leave the browser holding a session for an account the
sign-in did not complete as. This is the one non-obvious contract in the whole change and it
is why the linking branch lives in the chokepoint rather than in each leg.

### 4. Better Auth is mounted, for magic-link only
`createUpstreamAuth` is mounted at `/v1/auth/*`, configured with `emailAndPassword` disabled,
`socialProviders: {}`, and one plugin: magic link (hashed token storage, single-use, consumed
atomically on first verification). Delivery goes through a mailer seam on `AppContext`
(nodemailer; `jsonTransport` in dev and tests, so a real RFC 5322 message is composed and
asserted and never sent).

The two live reasons from ADR 0052 §6 are respected rather than overruled:

- **Social stays off.** `toBetterAuthSocialConfig` silently drops providers with no client
  secret, which is every origin-profile broker this product fronts. The provider registry
  (ADR 0055) owns social, and the mount is an **allowlist of exactly one path**
  (`POST /v1/auth/sign-in/magic-link`); everything else under `/v1/auth/*` answers 404 rather
  than 403, so an endpoint this deployment does not serve is indistinguishable from one that
  does not exist. An allowlist rather than a deny list because Better Auth's social endpoints
  exist whether or not a provider is configured, and a half-configured leg that answers 400
  today is one dependency bump away from answering 302.
- **Canonical identity stays in `principals`.** Better Auth's user record is an implementation
  detail of the proof, bridged by the existing `better_auth_subjects` table and nothing else.
  Its user id must never become a principal id or appear in an API response, an audit row or a
  token — which is also why Better Auth's own `/magic-link/verify` and `/get-session` are not
  on the allowlist: they answer with that record. Verification is performed server-side by the
  bridge, which reads it, writes the mapping, and hands back a principal id and a first-party
  bearer. Better Auth's own account-linking-by-email is disabled inside Better Auth: letting it
  fuse two of *its* users would silently fuse two canonical principals. The linking this ADR
  allows happens one layer up, against OpenSesame's own identity rows.

The bridge resolves a verified subject in three steps: the `better_auth_subjects` mapping; then
the identity tuple `("email", <this deployment's issuer>, <address>)`, which is how the same
human is recognised when Better Auth's store is rebuilt underneath a durable principal; then
mint-and-attach, applying §1. The email identity's issuer is this deployment, because the
magic-link proof is ours and no upstream vouched for it. The provisional-mint budget is keyed
on the address, so one inbox cannot mint unbounded principals by clicking links, and the
per-address send budget (five links per ten minutes) protects the person being mailed rather
than the person doing the mailing.

**Better Auth persists through the same Postgres as everything else.** Its four tables —
`better_auth_users`, `better_auth_sessions`, `better_auth_accounts` and
`better_auth_verifications` — are declared in this repo's Drizzle schema and reached through
`drizzleAdapter`, wired from `ctx.betterAuthDatabase`. A magic link is a row in
`better_auth_verifications`, so it survives a deploy and verifies on whichever replica the
human's click reaches. `storeToken: "hashed"` means a read of that table is not a set of usable
sign-in links, and verification consumes the row, so single-use holds across instances too.

This was briefly not the case: `betterAuth()` was constructed with no `database` and fell back
to the in-memory adapter. Every test passed, because a test requests and follows a link inside
one process — which is exactly what a deployment never does. The regression is now pinned by
two control planes over one real in-process Postgres, with the instance that sent the email
shut down before the link is followed.

The SQL tables carry the `better_auth_` prefix that `better_auth_subjects` already established,
so the database says plainly whose rows these are. Better Auth's *model* names stay its own
defaults, because its in-memory adapter seeds tables from those names and renaming the models
leaves it with none of them. Nothing about the mapping changes: canonical identity is still
`principals`, and these rows reach it only through `better_auth_subjects`.

With no `DATABASE_URL` configured the in-memory adapter is still what runs, which is correct
for a local dev process and is the same defaulting rule every other store in this repo uses.

### 5. Native LDAP bind, and directory sync as the pull twin of SCIM
An organization configures a directory (`ldap://`/`ldaps://` URL, `bind_template` or
`search_bind`, attribute map, group→role map) through owner-gated routes. The login page's
username-and-password form posts to `POST /interaction/:uid/federated/ldap`, and the server
performs a real bind through `ldapts`. Then the ordinary path: find-or-mint with
`kind: "ldap"`, JIT-join at the role the groups earned, and §1's email policy under the
condition in the next paragraph.

- **The subject is the configured stable attribute, never the DN.** A DN moves the day
  somebody changes department, and a subject that moves is a new account for the same human —
  or worse, an old account inherited by whoever next occupies that DN. `entryUUID` and
  `objectGUID` do not move. An entry with no value for the configured attribute is not
  admitted at all; falling back to the DN is exactly the mistake the rule exists to prevent.
- **Failure is uniform.** Wrong password, unknown user, ambiguous match (a search returning
  two entries is refused, not silently resolved to the first) and an unreachable directory all
  answer the same sentence with the same status. A search that finds nobody still performs a
  bind that is expected to fail, so an unknown username costs roughly what a known one does:
  not constant time, but the same operations in the same order, because the difference is
  measurable from an unauthenticated form and it enumerates the company directory. An empty
  password never reaches the wire — LDAP reads a bind with an empty credential as an
  *unauthenticated* bind and answers success. A tenant with no directory configured answers
  like a wrong password too: "this org uses LDAP" is itself a fact not worth leaking.
- **The password is a parameter and nothing else.** Never stored, never logged, never in audit
  metadata, never in an error. The only thing that ever holds it is the bind request.
- **TLS is required outside dev.** `ldap://` puts the password on the wire in the clear and is
  permitted only under `allowDevDefaults`, where the reference directory runs.
- **The org-supplied URL passes the private-host guard.** An owner is trusted with their own
  tenant, not with this server's network position: without the guard, `ldap://169.254.169.254`
  turns "configure our directory" into an SSRF gadget against the cloud metadata endpoint. The
  same `assertSafeMetadataUrl` used everywhere else judges the host.
- **Unlike every redirect leg on that prefix, this one is CSRF-protected and rate-limited.**
  It is a first-party credential POST into our own page, which makes it the one federated entry
  point that is genuinely CSRF-able and genuinely brute-forceable.

**Directory sync** is the pull twin of SCIM push: a service-account search reconciles users and
group→role memberships into the organization, and a leaver loses membership *and* every session
it authorized, through the same `revokeOrganizationMembership` helper SCIM deprovisioning
calls. Like SCIM it mints no principals — a directory entry is a statement about an employee,
not an authentication event, and a person becomes a principal the first time they actually
bind. Only members this directory vouched for are in scope: somebody who joined through the
tenant's OIDC IdP is not a leaver because the LDAP tree never mentioned them.

**The empty-scan guard.** If a scan returns zero usable entries, nothing is deprovisioned and
a warning is logged. A base DN that moved, a filter that stopped matching, and a service
account that lost read access all look exactly like a company where everybody resigned at
once — and a reconciler that trusted that number would end every membership and every session
in the tenant on the strength of a typo. The two cases are genuinely indistinguishable from
here, so the safe reading wins and emptying a tenant stays a deliberate act.

### 6. An organization-asserted email is verified only for a DNS-verified domain
This is the sharp edge where §1 and §5 meet. A `mail` attribute is administratively assigned
rather than typed by its owner, which is exactly the property the verified-email policy wants.
But the directory is configured by an organization *owner*, and an owner who could assert
`victim@example.com` as a verified address would be able to walk straight onto that person's
principal through §1.

So a directory-supplied address counts as verified only when the organization has DNS-verified
that domain through the home-realm-discovery machinery (ADR 0056 §8). Otherwise it is stored
as a contact hint with `emailVerified: false` and joins nothing. The owner's authority over
`@theircompany.example` is something they proved; their authority over any other domain is
something they merely claimed. A domain a *different* tenant proved is no help either — one
organization's proof says nothing about what another may assert.

**A SAML assertion's email is the same case, and gets the same rule.** It was originally
excluded outright, on the grounds that SAML defines no `email_verified` and so carries no
signal an SP can trust. That reasoning proves too much: it is equally true of a directory
attribute, which §5 admits. Both are set by the tenant rather than typed by the person signing
in, and both need the same bound on which addresses that tenant may speak for. Excluding SAML
had a real cost — somebody who signed in with Google and later through their employer's SAML
IdP silently got two accounts, which is precisely what §1 exists to prevent. The check is one
shared function, `organizationAssertedEmailIsVerified`, deliberately not copied into each leg:
the day one accepts a domain the other refuses is the day the weaker one becomes the way in.

### 6a. A provider's profile email is not its verified email
The same distinction, one layer out. GitHub's `/user` returns the address the account chose to
make public — absent entirely for an account that keeps it private, and never accompanied by a
verified flag, because GitHub is not claiming anyone checked it. `/user/emails` is where GitHub
reports every address on the account with the `primary` and `verified` booleans it set itself.

Only the second answers §1's question. Reading the profile address alone meant a GitHub sign-in
could never satisfy the verified-email policy at all, so the duplicate-account outcome above
applied to GitHub too. An OAuth2 descriptor may therefore name an `emailsEndpoint`; where one
is configured the leg makes that second authenticated read and reports the primary confirmed
address (or any confirmed one, when the primary is unconfirmed) as verified. The profile
address remains an unverified hint.

That read is deliberately soft-failing. It is an *extra* request, and an outage, a revoked
scope, or an unexpected body must not turn a sign-in that would otherwise succeed into an
error — the leg falls back to exactly the previous behaviour. The one thing it must never do is
report an address as verified that the provider did not say was verified. GitHub's built-in
descriptor therefore requests `user:email`, which is read-only and grants nothing else.

## Consequences
- Two people who genuinely share a verified address at different providers become one
  principal. This is the intended behaviour and the reason the whole change exists, but it is
  worth stating plainly: correctness now depends on upstreams telling the truth in
  `email_verified`. The trust fence is what bounds that — only issuers this deployment
  configured, a visitor registered, or a tenant configured can assert anything at all.
- SAML never participates. `admitSamlSubject` deliberately passes no `emailNormalized`: a SAML
  attribute carries no verification signal an SP can trust (ADR 0056 §6), so the one leg where
  a tenant administrator fully controls the asserted attributes is the one leg that cannot
  reach an existing principal by email.
- `services/identity-link.ts` sits in the Stryker mutation slice at a 100% break threshold,
  and this branch is the highest-risk addition to it. Three behaviours are pinned by
  mutant-killing tests: unverified email does not link; verified email with an existing
  verified owner links to that owner; verified email with no owner mints.
- Three new runtime dependencies, all MIT and exact-pinned: `ldapts` (bind and sync),
  `nodemailer` (magic-link delivery), and `better-auth` (already pinned, now actually mounted).
  The reference LDAP *server* used by tests is `ldapjs`, a devDependency of
  `apps/mock-upstream-idp` only — upstream is sunset but protocol-complete, and the pin moves
  forward if `pnpm audit:osv` ever objects.
- The identity `kind` union widens to `oidc | oauth2 | saml | ldap | email`, which is free in
  the database (`kind` is free text with no CHECK) and load-bearing everywhere a lookup spans
  kinds — back-channel logout and SCIM deprovisioning both iterate the full set, because an
  upstream naming a subject does not name a kind.
- An organization owner now holds real authority over people who are not yet members: through
  the directory's `mail` attribute (fenced by §6), through group→role mapping, and through
  SCIM provisioning. Domain verification is what backs the first of those, and it is the reason
  it is not optional.

## Related
- ADR 0008 — Better Auth + oidc-provider (mature libraries)
- ADR 0016 — Keycloak brokering (LDAP half superseded here; the brokered path stays)
- ADR 0033 — federated identity admission; §5 canonical identity is OpenSesame's
- ADR 0052 §6 — the Better Auth rejection, superseded here
- ADR 0055 — provider registry, BYO, org sign-in, the trust fence
- ADR 0056 — native SAML SP, SCIM, home-realm discovery, back-channel logout
- `docs/identity-linking.md` — the linking rules, rewritten for this decision
- `docs/architecture/federated-signin.md` §14 — the wire contract
