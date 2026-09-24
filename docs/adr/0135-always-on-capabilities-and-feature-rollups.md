# ADR 0135 — Always-on capabilities and feature rollups

- Status: Accepted (amended by [ADR 0138](0138-capabilities-page-one-list-honest-defaults.md): §2–§3)
- Date: 2026-09-23
- Amends: [ADR 0130](0130-operator-controlled-capability-composition.md)
  (operator-controlled capability composition)
- Supplements: [ADR 0033](0033-federated-identity-admission.md) (guest
  access), [ADR 0115](0115-front-door-and-connector-directory.md)
  (connectors by reference)

## Context

ADR 0130 made every product function beyond a small core an *optional*
capability: default off, chosen in setup or in Settings › Capabilities,
reviewed, and accepted with a consent receipt before its module is fetched.
In practice that went too far. Passkey records, import and export formats,
certificate records, operator identity providers, ambient single sign-on,
the Connections catalogue, the Access section, the activity trail and guided
help all switched off by default — so a fresh installation lost functions
that were never meant to be optional, and the git backup providers that used
to sit in Settings › Connections were reachable only after a person found and
enabled two separate catalog ids (`connectors.external`, then
`backup.git-remote`). Settings › Capabilities listed twenty-odd catalog ids,
core and optional alike, at a granularity nobody decides at while using the
app ("SIOP but not the site broker").

The guest road, meanwhile, had no switch at all: an operator who did not want
anonymous use of an installation had no way to say so.

## Decision

### 1. Always-on is a core capability whose code is still a module

`alwaysOn()` in `packages/app-core/src/lib/capabilities/descriptor.ts`
declares a **core-tier** descriptor that still owns its `<id>/runtime`
module. Core means what ADR 0130 says it means — in every distribution and
every plan, approved without a receipt, never named in a policy or a
selection — and nothing on any Settings screen offers to switch it. The
module still arrives through `loadApprovedModule` under the current lease
after boot: the change controller activates every approved capability that
owns a page module, always-on first (`modularApproved` in `change.ts`), so
the bootstrap still never statically reaches it.

Always-on today (`catalog-always-on.ts`): `vault.passkey-records`,
`vault.certificate-records`, `vault.interop-formats`, `backup.cloud-secrets`,
`connectors.external`, `access.authority`, `identity.federation`,
`identity.ambient-sso`, `activity.log`, `support.guided-help`.

Always on does not step outside the operator's network envelope. Ambient
SSO is the one always-on capability with an automatic external call (its boot
revalidation and silent attempt); a plan whose network policy denies external
services — the Family preset, a managed policy — keeps that call off
(`externalServicesDenied` in its runtime). Its boot runs once per document.

Like every approved module, an always-on one is disposed and activated again
under each new plan generation: `contributions()` answers only the current
generation's registrations, which is the fence ADR 0130's authority model
rests on, and an always-on capability gets no exemption from it.

Every file an always-on capability owns, its `src/modules/<id>/` directory
included, is classified core — the capability graph's BUILD-06 invariant
requires a core capability's module directory to be core. The bootstrap still
reaches the module only through the loader under the current plan's lease;
it is the ownership rule, not the classification, that keeps it out of the
entry chunk.

Documents written before this change may still name one of these ids. The
resolver ignores a core id in a selection, and a policy that *requires* one
owes nothing for it (`buildContext` in `resolve-axes.ts`). Presets and the
shipped profile fixtures never name one; their tests enforce that.

### 2. Features are the switches

`packages/app-core/src/lib/capabilities/features.ts` rolls every optional
capability into exactly one **feature** — a way of using the application —
and gives each feature the connector families (the Connections catalogue's
categories) its providers come from:

| Feature | Optional capabilities | Providers configured under it |
|---|---|---|
| AI | `support.local-ai`, `support.remote-ai`, `agents.webmcp` | model picks, agent harnesses |
| Backups | `backup.git-remote` | backup/recovery (the git providers) |
| Payments | `wallet.spending` | wallet |
| Servers | `identity.local-iam`, `identity.siop`, `identity.site-broker`, `enterprise.directory-provisioning`, `enterprise.ca-administration` | certificates |
| Sharing | `sharing.drops`, `sharing.household` | — |
| Networking | `networking.tailnet` (new) | networking (Tailscale) |
| Notifications | `notifications.web-push` | — |
| Telemetry | `telemetry.external` | — |

Connector families of always-on functions — identity providers, encryption,
password managers, cloud secret storage, local storage — are
`PROVIDER_GROUPS`: configured on the same page, with no switch.

A feature switch proposes every capability behind it at once, choosing an
alternative slot the switch itself fills (Sharing's household transport is
Sharing's own drops). The proposal goes through the same review, consent
receipt and commit as a single capability did. Consent still binds each
descriptor's exposure digest; a feature is presentation, never authority.

A test pins that every optional capability belongs to exactly one feature,
that no always-on capability belongs to any, and that every connector family
has exactly one home.

### 3. One page for switches and providers

Settings › Capabilities draws, in order: Allow guests, the features (each
with its providers under it while it is on), the always-on provider groups,
and **Advanced** — the optional capabilities one by one (disable now, retire
safely, add) and, for the operator of this device, the instance policy.
Settings › Connections, Settings › Backups and Settings › Cloud secrets are
gone as categories; their paths and hashes resolve to Capabilities, and the
connector pages (`/settings/connections/<provider>`) are unchanged. The
setup ceremony's cards show optional capabilities only.

### 4. Allow guests

`packages/app-core/src/lib/guest-access.ts` holds one plaintext boolean
under `guest-access.v1`, hydrated with the core boot keys because the
sign-in and unlock screens read it before any vault is open. Absent,
unreadable or malformed reads as **allowed**. Every guest placement — the
full-size button on both sign-in placements, the first-run Skip, the unlock
footer, and the Identity ceremony's guest claim — reads it through
`screens/unlock/GuestRoad.tsx` or `useGuestsAllowed`, so none can drift, and
`openGuestVault` in `guest-auth.ts`, where both guest roads end, refuses a
guest session outright while it is off, and the last-vault pointer and the
vault list stop offering the guest tomb. Only the device's operator may turn
the switch off (`useDeviceOperator`: personal-local, the personal tomb, not a
guest) — the same rule as the instance policy, so neither a guest nor a
member of a managed instance can shut the guest road. Once it is off, anyone
signed in (never a guest) may turn it back on: withdrawal is the exception,
and a device whose operator is gone must still be able to get the road back.

This is the only thing that may withdraw the guest road. AGENTS.md §5's rule
stands otherwise unchanged: guest is never gated on an Identity API, the
provider catalogue, setup, or vault status, and the default-state tests that
assert it stay load-bearing.

## Consequences

- A fresh installation has passkeys, formats, certificates, operator
  identity providers, ambient SSO, Connections, Access, Activity and guided
  help again with no ceremony. The `minimal-local` profile still resolves to
  zero *optional* capabilities; it simply has more core.
- Hardened builds always carry the always-on modules. Their bundle budgets
  measure that; nothing optional is newly reachable from the entry.
- An installation that had accepted one of the now-core ids keeps working:
  its selection's stale root is ignored, not rejected.
- Crypto wallets have no implementation in this repository and therefore no
  feature. One becomes a row the day a capability exists to switch.
