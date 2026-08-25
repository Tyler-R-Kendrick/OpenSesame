# Identity linking & privacy

## Linking

- External identities are unique on `(kind, issuer, tenant, subject)`. That tuple is the
  primary key of identity and the only thing consulted first.
- `kind` spans `oidc | oauth2 | saml | ldap | email` — one value per admission leg, recorded on
  the row and used in the lookup, so the same subject string at the same issuer under two
  protocols is two identities rather than one.
- **A verified email is a secondary join, under ADR 0057.** When the tuple misses, and only
  then, admission asks one further question: does an existing principal already own a
  *verified* identity carrying this same normalized address? If so, the new identity attaches
  to that principal instead of minting a duplicate account for the same human. Both ends must
  be verified — the stored identity, and the assertion presented on *this* sign-in.
- **An unverified email still never links.** An upstream that lets a human type an arbitrary
  address into a profile field would otherwise be an account-takeover path. An unverified
  collision produces a denied `principal.identity_link_email_collision` audit event and then
  links normally by tuple: evidence for a human reading the trail, never a matching rule.
- A SAML assertion's email attributes never participate: they are read for display only, and an
  `emailAddress`-format NameID is a subject string, not an address. A directory-supplied
  address counts as verified only when the organization has DNS-verified that domain.
- Determinism, not a constraint: `external_identities.email_normalized` is indexed and
  deliberately **not** unique (existing data may hold duplicates). When several verified rows
  share an address, the oldest owning principal wins, tie-broken by principal id and then
  identity id — the same ordering in the memory and Postgres implementations.
- This attaches an identity at admission. It never fuses two already-durable principals, and
  the returned identity's `principalId` — not the id the caller passed in — is the account
  signing in.
- Linking requires an authenticated principal + step-up for sensitive changes.
- Canonical `Principal.id` never changes when identities are attached.

## Pairwise subjects

Downstream tokens use sector pairwise `sub` values. Relying parties Alpha and Beta must receive different stable subjects for the same principal; neither equals `Principal.id`.

## Default claims

Default identity: `iss`, pairwise `sub`, `aud`, time claims, assurance/session context. PII requires explicit scopes and consent.

## Merge

Full merge is only supported when both principals are authenticated (or admin recovery). Otherwise collision detection returns a safe `merge_not_supported` workflow — never silent merge. The verified-email join above is not a merge and does not weaken this: it creates one identity row against an existing principal at admission time, while `principal.merge` — fusing two durable principals — stays in the pinned high-risk deny list.
