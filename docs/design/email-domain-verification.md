# Email domain verification

Competitive contract for [Infisical Email Domain Verification](https://infisical.com/docs/documentation/platform/email-domain)
against the existing OpenSesame organization email-domain surface.

Status: parity map. Most of the feature exists already. The remaining gaps are
listed below; this document does not claim they are fixed.

## What exists today

Implemented in `packages/control-plane/src/routes/org-domains.ts` and
`apps/pages/src/sections/identity/org-signin/DomainsPanel.tsx`:

- Owner-only `GET / POST / verify / DELETE` organization domains.
- DNS TXT proof. Only DNS is read; no arbitrary HTTP fetch, so there is no SSRF
  gadget.
- Claim token is compared in constant time over fixed-length digests.
- Claim is platform-unique across organizations.
- Normalized lowercase/IDNA domain; ports, paths, userinfo, wildcards and single
  labels are refused.
- An unverified claim routes nothing.
- Verified-only home-realm discovery (`/by-domain`, the realm interaction).
- Verified-only organization-asserted email trust for SAML and LDAP.
- Uniform failure replies: unknown, unverified, malformed and suspended all look
  the same where enumeration matters.
- Release removes the claim; another organization can then claim it.
- Owner proof per write, audit events for claim/verify/release, and a list panel
  with copy/verify/release controls.

## Infisical behavior

| Behavior | Infisical |
|---|---|
| Proof | TXT record `_infisical-verification.<domain>` with `infisical-domain-verification=<code>` |
| Expiry | 7 days from claim; verification must complete inside it |
| Uniqueness | One organization per domain across the instance |
| Hierarchy | Exact domain only; parent does not cover subdomains |
| SSO | Verified work email routes to the organization's SAML/OIDC/LDAP IdP |
| SCIM | A verified domain is required; `POST /Users` is checked against it; email changes are refused |
| Deletion | Removes claim; domain SSO stops; SCIM for that domain is blocked; another org may claim |
| Password login | If the organization enforces SSO, email/password signup is blocked for verified domains |
| Enumeration | The SSO form resolves the domain to an organization |

## Parity matrix

| Capability | OpenSesame now | Gap |
|---|---|---|
| Add/list/verify/delete domain | Yes | None |
| DNS TXT proof | Yes, root TXT `opensesame-domain-verify=` | Record name differs; no `_opensesame-verification` host |
| Constant-time token compare | Yes | None |
| Platform-wide uniqueness | Yes | None |
| Domain normalization/IDNA | Yes | None |
| Exact-domain hierarchy | Yes | None |
| Unverified claims route nothing | Yes | None |
| SSO home-realm by email domain | Yes | None |
| Verified email trust for SAML/LDAP | Yes | None |
| Anti-enumeration replies | Yes | None |
| Owner proof + audit | Yes | None |
| Verification expiry | No | Add 7-day expiry |
| SCIM requires verified domain | No | Add on `POST /Users` |
| SCIM email immutable | No | Refuse `userName` change on PATCH/PUT |
| Deleting domain blocks SCIM | No | Add once SCIM enforcement exists |
| SSO enforcement blocks password signup | No | Add organization SSO-enforcement policy |
| UI shows record name + expiry | Partial: value only | Add name, value, expiry |
| Native CLI | No dedicated command | Add `opensesame org domains` |

## Target

### Domain record

```text
OrgEmailDomain
  domain                 # primary key, lowercased/IDNA
  organizationId
  verificationToken
  recordName             # _opensesame-verification.<domain>
  createdAt
  expiresAt              # createdAt + 7 days
  verifiedAt
```

- `claim` re-rolls token and expiry.
- `verify` refuses an expired token with a distinct machine code but the same
  public sentence where enumeration applies.
- Verification accepts the `_opensesame-verification.<domain>` TXT value. Keep
  the legacy root TXT fallback for existing claims until migration ends; mark
  the fallback in the UI and audit.
- A verified domain is immutable except for release/re-claim.

### SCIM

- `POST /Users`: `userName` must be an email address and its exact domain must
  be verified by the token's organization. If not, answer `400 invalidValue`.
- `PATCH`/`PUT`: changing `userName` or any email attribute is refused with
  `400 mutability`. Email is an immutable identifier.
- Existing SCIM users do not disappear when a domain is released; new
  provisioning and email changes fail, and the UI says which users are affected.
- A domain release does not revoke existing memberships automatically. The
  organization decides that separately; this avoids silently locking out people
  on a DNS mistake.

### SSO enforcement

The organization policy `requireSsoForVerifiedDomains`:

- When on, password signup/login for a verified domain is refused and routed to
  the verified organization's IdP.
- The refusal must not reveal whether a specific address exists.
- Turning it off is owner-gated, audited, and shown as a downgrade in the
  confirmation.
- This applies only to verified domains; an unverified claim changes nothing.

### UI

The domain row shows:

- domain
- record type `TXT`
- record name `_opensesame-verification.<domain>`
- record value
- claim expiry while pending
- verified state and verification time
- release/re-claim keys

### Native

```bash
opensesame org domains list <org>
opensesame org domains add <org> <domain>
opensesame org domains verify <org> <domain>
opensesame org domains remove <org> <domain>
```

The CLI uses the same owner proof and never prints a token from another
organization.

## Native versus PWA

This is a control-plane feature.

- **PWA**: domain management, DNS instructions, verification, release, and the
  pending/expired state. A DNS check is a control-plane action, not a browser
  DNS resolver.
- **Native**: the same calls for operators and CI; no different authority.
- **SCIM**: server-to-server only; no browser path.

## Outperformance

- DNS is the only outbound check; no HTTP fetch to a claimant-supplied host.
- Constant-time token comparison and fixed failure sentences.
- No "domain held by another organization" disclosure to the claimant.
- Verified-only routing and verified-only SAML/LDAP email trust already share
  one predicate, so the weaker leg cannot drift.
- Owner proof is required on every write, not only in the UI.
- A release is explicit and audited; a stale DNS record cannot silently keep
  routing.

## Delivery slices

1. **Expiry and record shape.** Add `recordName`, `createdAt`, `expiresAt`;
   accept the subdomain TXT with root fallback; show both in the UI.
2. **SCIM enforcement.** Require the verified domain on create; freeze email on
   update; test release behavior.
3. **SSO enforcement.** Add `requireSsoForVerifiedDomains`, route password
   attempts to the IdP, audit the toggle.
4. **Native CLI.** Add the org-domain commands.
5. **Migration.** Keep legacy root TXT verification while any existing claim
   has not been re-rolled; one release cycle, then remove it.

## Acceptance

- A domain claimed but never verified routes no SSO and is not trusted for
  SAML/LDAP email claims.
- A parent domain does not route a subdomain.
- The same domain cannot be claimed by two organizations.
- An expired token cannot verify; re-claim re-rolls it.
- SCIM `POST /Users` for an unverified domain is refused; `PATCH userName` is
  refused even to another verified domain.
- Domain release stops SSO routing; existing SCIM memberships remain but no new
  provisioning or email change succeeds.
- SSO enforcement refuses password signup for verified domains without an
  account-existence oracle.
- Unknown, unverified, malformed and suspended organizations answer the same
  way where enumeration matters.
- No domain token, SCIM token or email address appears in logs or URLs beyond
  the minimum the UI already displays.
