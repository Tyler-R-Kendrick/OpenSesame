# Identity — the IdP brokering and people screen

Design contract for the Pages **Identity** section. Parity target and
terminology: [`docs/competitors/tailscale-identity.md`](../competitors/tailscale-identity.md).
Decision record: [ADR 0060](../adr/0060-identity-screen-idp-brokering.md).
Sibling precedent (structure, seams, test style):
[`docs/design/access-screen.md`](access-screen.md).

The question this screen answers: **who vouches for the people here, who are
they, and which machine identities exist?** Tailscale's answer is a tailnet
locked to an IdP at creation, then Users / Identity Provider / Trust
credentials pages. Ours is a first-navigation ceremony that registers an IdP
to broker, then four tabs over the identity plane.

## Layout

- Route `/identity`, nav label **Identity** (`IconUser`), placed after
  **Access** in `AppShell` `SECTIONS`; crumb `identity → "Identity"` in
  `lib/crumbs.ts`; slot in `App.tsx` `AppSlots`.
- Section header: title **Identity**, tagline *"Who vouches for the people
  here — and who they are."*
- Four tabs, one mounted at a time, `role="tablist"`/`"tab"` with
  `aria-selected` — same tab bar pattern as `AccessSection.tsx`:
  **People · Providers · Service accounts · Organization**.
- **The ceremony gate.** When `idp-registry` has zero registered IdPs and the
  ceremony has not been dismissed, the section renders the ceremony instead
  of the tabs (see below). Registering one IdP or choosing *Set up later*
  lifts the gate permanently (recorded in the registry store).

## The IdP ceremony (Tailscale: "Sign up with your identity provider")

Full-section ceremony, one card, minimal interactions:

1. **First-class providers** — a row of branded icon buttons (same
   `ProviderBrand` treatment as the sign-in hub), sourced from
   `listFederatedProviders()` with the `defaultUpstream()` fallback when the
   catalog is unreachable. Clicking one records it in the registry
   (`kind: "first-class"`) and immediately starts the brokered sign-in leg
   (`beginSignIn(brokeredUpstream(provider), { providerHint: provider.id })`)
   — registering and proving the binding in one gesture, like Tailscale's
   signup → consent → console flow.
2. **Custom OIDC card** — Tailscale's "Sign up with OIDC", reusing ADR 0055's
   shipped path. Step 1: issuer URL field (focused on mount) → *Check issuer*
   → `registerByoProvider({ issuer })`. If the server does DCR, done. If it
   answers `registration_unsupported` (422), step 2 reveals **Client ID** /
   **Client secret** fields plus the deployment's **redirect URI** to
   register at the IdP (from the first attempt's error surface or shown after
   successful registration from `registration.redirectUri` — copy affordance).
   Submit → `registerByoProvider({ issuer, clientId, clientSecret })` →
   record in the registry (`kind: "byo"`). Success line: *"<label> now
   vouches for sign-ins on this device."* Errors render the server's
   plain `message` (`invalid_issuer`, `discovery_failed`, `rate_limited`).
3. **Set up later** — small link at the bottom (guest primacy): dismisses the
   ceremony, shows the tabs, leaves a *"No identity provider registered yet"*
   banner on the Providers tab with a *Register an IdP* button that re-opens
   the ceremony.

## People — who can sign in (Tailscale: Users)

- **Me card**: principal id (truncated, copyable), **state** badge
  (`provisional → "Guest"`, `active`, `suspended`, `closed`), **assurance**
  chip (`provisional|self_asserted|verified|mfa|phishing_resistant|…`),
  created date. Guest state adds: *"No identity provider vouches for this
  identity yet"* + button into the ceremony.
- **Linked identities** (`GET /v1/principals/identities`): rows with kind
  icon, issuer, `displayHint`, assurance, linked date; **Unlink**
  (`DELETE /v1/principals/identities/:id`, confirm first). This is the
  one-principal-many-IdPs model made visible — Tailscale has no equivalent;
  it's our superset.
- **Org members** (when an org profile is active): `GET
  /v1/organizations/:id/members` rows with role chips
  (`owner|admin|member`); owner can add by principal id (`POST`) and remove
  (`DELETE`). Captions state the honest gaps: no invite-by-email, no
  last-seen.
- Not signed in (no session): a connect note, not a crash — same posture as
  the Access screen's locked/empty states.

## Providers — who vouches for them (Tailscale: Identity Provider)

- Row per registered IdP: brand/issuer icon, label, issuer, kind badge
  (`First-class` / `Custom OIDC`), registered date (BYO), `lastUsedAt` where
  known.
- First-class rows come from the catalog ∩ registry; BYO rows from the
  registry mirror. Caption: *"Registrations made on other devices are managed
  by the deployment operator."*
- Row actions: **Sign in** (starts the brokered leg — the *test* that the
  binding works), **Remove** (local mirror only, confirm; caption: *"The
  server-side registration is disabled by the operator, not deleted."*).
- **Register an IdP** button → re-opens the ceremony.

## Service accounts — identities that aren't people (Tailscale: Service accounts / Trust credentials)

- **OAuth clients** (`GET /v1/oauth/clients`, owner-fenced): rows with
  display name, client id, admission mode, state, created date.
  **Create** form (display name, redirect URIs, sector identifier →
  `POST /v1/oauth/clients`), **Rotate secret** (`POST /:id/rotate` → show
  once, copy), **Revoke** (`POST /:id/revoke`, confirm).
- **Agents** cross-link card: *"Host-plane service accounts (agents) are
  registered and inspected in Access → Resources."* Link, no duplication.
- Empty state: *"No service identities yet."*

## Organization — the tailnet analog

- Memberships (`listOrgMemberships()`): card per org — slug, display name, my
  role, SSO/SAML binding (`ssoIssuer`/`samlIssuer` shown as the server-side
  IdP lock), member count link into People.
- **Create an organization** form: slug (validated `ORG_SLUG_RE`), display
  name, optional SSO issuer → `POST /v1/organizations`. Errors surface
  plainly (e.g. verified-assurance requirement). Caption: *"An organization
  binds a domain and an IdP server-side — the closest thing to a tailnet."*
- SCIM/LDAP noted as operator/API surface (ADR 0056), not edited here.

## Data and state rules

- New seamed lib `apps/pages/src/lib/directory.ts` (pattern of
  `lib/access.ts`): `getMe()`, `listLinkedIdentities()`, `unlinkIdentity(id)`,
  `listOAuthClients()`, `createOAuthClient(input)`, `rotateOAuthClient(id)`,
  `revokeOAuthClient(id)`, `listOrgMembers(orgId)`, `addOrgMember(orgId,
  principalId, role)`, `removeOrgMember(orgId, principalId)`,
  `createOrganization(input)`. Transport `identityFetch`; typed
  `DirectoryError{status, code}` with plain-words mapping; response parsing
  via `BoundaryValue` guards + `overlapCast` — never `as`.
- New store `apps/pages/src/lib/idp-registry.ts`: localStorage key
  `opensesame.idp-registry.v1`, records `{id, issuer, label, kind:
  "first-class"|"byo", clientId?, clientAuth?, redirectUri?, registeredAt}`,
  plus `ceremonyDismissed` flag; `idpRegistrySeams` wraps storage for tests.
- Server shapes come from the route files, not memory:
  `apps/control-plane/src/routes/principals.ts` (`/me`, `/identities`,
  link/delete), `routes/oauth-clients.ts` (CRUD + `CreateOAuthClientRequestSchema`),
  `routes/organizations.ts` (members, create). **Read them before binding.**
- All tabs fail soft: unreachable identity API → note + retry, never a blank
  panel. Guest (no session) → connect notes, not errors.
- One mounted tab at a time; refresh affordance per panel (the Access
  pattern).

## Files

- New: `lib/directory.ts`, `lib/directory.test.ts`, `lib/idp-registry.ts`,
  `lib/idp-registry.test.ts`, `sections/IdentitySection.tsx`,
  `sections/identity.css`, `sections/IdentitySection.test.tsx`.
- Modified: `App.tsx` (slot + route), `App.test.tsx`,
  `components/AppShell.tsx` (SECTIONS), `components/AppShell.test.tsx`,
  `lib/crumbs.ts`, `lib/crumbs.test.ts`.
- Untouched: server code, `lib/byo.ts`/`lib/providers.ts`/`lib/federation.ts`
  (consumed as-is), the sign-in hub, vault model, crates.

## Test plan

- `idp-registry.test.ts`: empty → ceremony shows; register → gate lifts;
  dismiss → gate lifts with banner; malformed stored JSON → treated as empty.
- `directory.test.ts`: wire mapping per endpoint, error mapping (401 →
  sign-in wording, 403 owner-fence, 404, unreachable), OAuth client
  create/rotate/revoke payloads.
- `IdentitySection.test.tsx` (hoisted seam mocks, no module mocking):
  ceremony renders when registry empty; first-class click records + starts
  brokered leg (seam assertion); custom OIDC two-step (422 → client fields →
  success → registry record); tabs render one at a time with `aria-selected`;
  People shows guest card without session and me + identities with one;
  unlink confirms then calls seam; Providers lists registry rows, remove
  updates store; Service accounts CRUD happy paths; Organization create
  validates slug client-side.
- Update `App.test.tsx` (route + slot), `AppShell.test.tsx` (nav label),
  `crumbs.test.ts` (crumb).
- Gates: `pnpm --filter @opensesame/pages test`, `tsc --noEmit`, per-file
  oxlint anti-slop, biome — all green before reporting.
