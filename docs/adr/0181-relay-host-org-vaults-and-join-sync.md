# ADR 0181 — Relay host, org-scoped vaults, and durable join sync

- **Status:** Proposed
- **Date:** 2026-10-07
- **Deciders:** OpenSesame maintainers
- **Builds on:** [ADR 0132](0132-optional-mtls-and-workload-identity.md)
  (transport policy and default-deny service bindings),
  [ADR 0150](0150-live-sessions-browser-to-browser.md) (live join, and no
  default public relay), [ADR 0136](0136-join-a-session-restored.md) (the
  join-only pairing ceiling), [ADR 0144](0144-tailnet-vault-sync.md) (device-side
  merge against a ciphertext drive), [ADR 0089](0089-device-vault-switching.md)
  (`listDeviceVaults()`), [ADR 0063](0063-encrypted-vfs-tombs.md) (every vault
  is a tomb), [ADR 0038](0038-project-hierarchy-sharing.md) (projects, optional
  organization), [ADR 0090](0090-static-frontend-complete-without-backend.md)
  and [ADR 0128](0128-pages-without-host.md) (Pages needs no Host),
  [ADR 0130](0130-operator-controlled-capability-composition.md) and
  [ADR 0135](0135-always-on-capabilities-and-feature-rollups.md) (optional
  capabilities stay off until consent), [ADR 0180](0180-vaults-are-sealed-by-passkey-not-password.md)
  (what wrap may travel)
- **Transport map:** [docs/architecture/transport-topology.md](../architecture/transport-topology.md)

## Context

Three rows in [the 2026-10 checklist](../audit/2026-10-requested-items.md)
describe one deployment:

- **A1.** `crates/gateway` is the full Host API. An operator cannot start
  that process as a relay whose default capabilities and service bindings are
  a closed set.
- **A2.** A device lists its tombs through `listDeviceVaults()`
  (`packages/app-core/src/lib/vaults.ts`): the `personal` tomb, one
  `prj_<uuid>` tomb per project, and the `guest` tomb. An Identity `Project`
  may carry `organizationId`, and an `Organization` has a `slug`
  (`packages/os-domain/src/types.ts`). Nothing addresses a vault as
  `owner/slug` the way a GitHub repository is `owner/name`.
- **S1.** Join shares fields while both browsers are in the session. The
  joiner keeps values in memory and writes nothing (ADR 0150 §5). Tailnet
  sync is the durable merge, and its drive is the daemon
  (`/v1/vault-drive/slots/{slot}/snapshot`), not a joined session and not the
  gateway.

The gateway already stores opaque ciphertext for a signed-in principal at
`POST /api/v1/sync/push` and `POST /api/v1/sync/pull`
(`crates/gateway/src/routes/sync.rs`, `sync_page.rs`). That store is keyed by
the session subject and `organization_id`. It is a different store from a
per-vault compare-and-set replica. A join grant cannot call it: `host.join`
widens only to `host.delegations.claim` and `host.sessions.join`
(ADR 0136 §4, `packages/app-core/src/lib/browser-pairing.ts`). The sync
ceiling is the separate pairing `host.sync.read` and `host.sync.write`.

ADR 0132 already decides how a native peer becomes a caller: one transport
policy, then exactly one service binding, then the operation. Resolution is
default deny. Selectors are exact. A browser still cannot present a client
certificate, and the vault key is not a transport identity.

## Decision

### 1. Relay profile serves a closed route set

An operator can start the gateway in **relay profile**. That process serves
`GET /health/live`, `GET /health/relay`, and the vault-relay slot routes in
§4. `GET /health/relay` is the profile advertisement
(`profile`, `bindings: vault_relay`, `durable`), not operator transport
administration. Every other route is absent, including `/api/v1/sync/*`,
operator transport administration,
shared-session administration, and connector invoke. The full Host API
remains the profile an operator starts when they want the Host API.

Relay hops use the policies ADR 0132 already closed: `existing_local` on
loopback, `server_tls` or `mtls_required` when the peer is remote. Relay
profile adds no fifth policy and does not downgrade when material is
missing. `docs/architecture/transport-topology.md` still describes the full
Host; a relay deployment draws only the health listener and the slot routes
on that map.

Pages stays complete with no Host (ADR 0090, ADR 0128). The relay is an
optional peer, as the tailnet drive is. ADR 0150's rejection of a default
public relay stands. A live-session link names a relay only when the owner
writes one into Routes. This profile is the operator's process. It is not
baked into the Pages origin, and it is not a TURN server or a live-session
carrier (ADR 0167).

### 2. The default bindings are the only authority relay profile will load

Service-binding resolution stays ADR 0132 §5: default deny, one exact peer
selector, one purpose, no wildcard, no name join. Relay profile adds purpose
`vault_relay`. Its operations are `vault.relay.snapshot.read` and
`vault.relay.snapshot.write`, and nothing else.

The binding document relay profile loads when the operator has not written
one is empty. A certificated peer with no matching binding is
`PeerNotBound`. If a document names another purpose, or an operation outside
those two, relay profile refuses to start. That refusal is the default
binding: the only authority this profile accepts, not a peer installed for
the operator.

A browser cannot present a client certificate. Browser admission to a slot
is the slot key in §4. A native peer presents both a `vault_relay` binding
and the slot key. The certificate does not open every slot, and the slot key
does not skip the binding on a native hop.

On Pages, `sharing.relay` is an optional capability, default off, consented
under ADR 0130. It is not core and not `alwaysOn` (ADR 0135). The relay
profile's instance policy permits `sharing.relay` and permits no other
product root. `sharing.live` and `networking.tailnet` stay as they are.

### 3. A published vault is addressed `owner/slug`

`OrgVaultRef` is `{ ownerKind, owner, slug }` with `ownerKind` of `user` or
`organization`, spelled `owner/slug`. The caller supplies `ownerKind`. The
spelling does not record it. Principal handles and organization slugs share
one namespace, so one spelling is one owner. That namespace is not enforced
anywhere yet: `Principal` has an id and no handle, while `Organization.slug`
is unique among organizations only.

Each segment is a lowercase label of 1 to 63 characters, `[a-z0-9-]`, and
does not start or end with a hyphen. That is the access-domain slug label
(`MAX_DOMAIN_SLUG_CHARS` in `packages/os-domain/src/access-domain/node.ts`).
`parseOrgVaultRef` does not trim and does not fold case. `guest` is reserved
as an owner and as a slug. The guest tomb is the continue-as-guest road
(`GUEST_TOMB`), and `createProject` already refuses that word as a project
name.

The address is not the sealed display name (ADR 0089). The device still
stores the vault as a tomb. `personal` and `prj_<uuid>` stay tomb ids.
`listDeviceVaults()` grows `address: OrgVaultRef | null` in phase 2. This
slice does not change that function. The guest row's address is null. The
personal tomb may be published as `<handle>/personal`. The slug is chosen
when the vault is published. It is not copied out of the sealed name.

An organization address uses `Organization.slug`. Publishing it, and minting
a slot key for it, takes an organization owner or admin (the existing
`OrganizationRole`). A member uses a key one of those roles minted. A user
address uses the principal's handle.

The local project registry may store the ref in the clear beside the tomb
id, the same way it stores the tomb id. That is an address the device has
published. It is not a nickname on the locked screen, and the sealed name
stays inside the tomb.

### 4. Durable sync is the tailnet merge, and the relay is the drive

One slot holds one sealed snapshot for one `OrgVaultRef`. Writers
compare-and-set a generation. The snapshot format is
`opensesame-vault-drive-snapshot`, the format ADR 0144 and
`spec/conformance/vault-drive-protocol.json` already fix. The merge is
`mergeVaultBodies` in `packages/app-core/src/lib/tailnet-sync/engine.ts`.
The relay checks that the bytes claim to be a snapshot, then stores them.
It does not merge, and it does not hold a vault key.

The routes are:

- `GET /v1/vault-relay/{owner}/{slug}/snapshot`
- `PUT` the same path, body `{ expected_generation, snapshot }`. A stale
  generation is `409` and carries the generation that won.

The slot key is 32 random bytes. The relay stores only its SHA-256, as the
daemon drive does. The first PUT of an empty slot creates it. A later write
names the generation it read.

What may travel is ADR 0144's portable header, narrowed by ADR 0180: a
password wrap only when the vault already has one, and passkey PRF wraps.
The PIN wrap stays on the device. A PIN-only vault has no durable replica.
A guest session and a duress decoy have none. Those tombs hold no pairing.

Admission is separate from `host.join`. A live join still shares fields in
memory for the sitting and writes nothing. Durable sync is its own consent.
The owner mints the slot key on a device where the vault is open, and passes
it as a drive pairing is passed, or inside a live-session offer the joiner
accepts as a replica. Accepting means the joiner can unlock that vault with
a portable wrap. The joiner is a peer of the vault. A live-session guest is
not given that key by the join itself.

The relay keeps the latest snapshot while every browser is locked. That is
the durability a join lacks today. A browser still syncs only while its
vault is unlocked (ADR 0144 item 12): the vault key and the pairing are
sealed at rest, and a service worker woken in the background holds neither.
The next unlock catches up. The relay does not unseal on a schedule.

Pages talks to a relay the person paired, and to no other gateway route. It
does not write `settings.hostApi`, and it does not send an operator token.
That is the tailnet drive's exception to ADR 0128, for a second URL the
pairing names.

`/api/v1/sync/*` stays on the full Host profile, for the session-scoped blob
store it already is. Relay profile does not serve it, and join sync does not
write into it.

When the operator points relay profile at an Identity issuer, creating a
slot requires a registration for that exact `OrgVaultRef`, signed for a
principal the directory allows to publish it: the handle's principal, or an
organization owner or admin. A registration for a different address is
refused. With no issuer configured, the slot key is the whole admission, and
the first key to write an empty address claims it. Operators who want the
directory rule configure the issuer. The ciphertext check is the same either
way.

### 5. What this slice ships

The decision, the address parser `parseOrgVaultRef` / `formatOrgVaultRef`,
and the first working code for phases 1–3:

- Relay profile (`OPENSESAME_GATEWAY_PROFILE=relay` or `opensesame host run
  --profile relay`) serves `GET /health/live`, `GET /health/relay`, the slot
  routes, and `GET` and `POST /v1/org-vaults`. Other routes, including
  `POST /api/v1/sync/pull`, are absent. Startup installs an empty
  `vault_relay` binding set when `OPENSESAME_SERVICE_BINDINGS_FILE` is
  unset, and holds that set for the life of the process. A document that
  is not entirely purpose `vault_relay` with the two snapshot operations
  refuses to start. The slot key is stored as SHA-256. Native mTLS
  admission of a certificated peer, beyond that startup check, is still
  the full Host's resolver. The env is documented in
  `docs/operators/local.md`.
- `POST /v1/org-vaults` creates `{ ownerKind, owner, slug }` for the
  principal in `x-opensesame-principal`. The first principal claims the
  address. The same principal may repeat it. A different principal is
  `409`. `GET /v1/org-vaults?owner=` lists that owner's refs. A request
  with neither owner nor principal returns an empty list. A successful
  snapshot write records the same directory row. A presented organization
  role of `member` may list and may not create or publish. `owner` and
  `admin` may. A user address may be created or published only by the
  principal whose handle is the owner. With no role header, the slot key
  remains the admission.
- `sharing.relay` is an optional Pages capability, off in the default plan.
  When it is on, Settings › Capabilities › Sharing draws Organization
  vaults (`OrgVaultDirectoryPanel`): create and list, and no fetch at
  import or activation.
- A tomb header may carry `publishedAddress`. `listDeviceVaults()` exposes
  it as `address`. A locked unnamed row is labeled `owner/slug`. A named
  row keeps its sealed name and shows the address on the meta line. Guest
  stays null. The portable snapshot header does not copy the address.
- `packages/app-core/src/lib/vault-relay/client.ts` pushes and pulls a
  sealed snapshot. Live join does not call it. A pages integration test
  shows a second device receiving the first device's ciphertext metadata.
  `pnpm --filter @opensesame/pages verify:relay-join` repeats that with two
  browser contexts against a relay HTTP harness: A joins and publishes, B
  joins and reads the ciphertext. The item name is not in the snapshot.
  `verify:live-join` stays the live-session walk.

Not in this slice: an Identity-issuer registration check, the vault-drive
conformance replay,
attachment parts, and `opensesame-id vault sync`.

## Phased implementation

**Phase 0 — this commit.** Decision, audit rows, address parser.

Gate: `pnpm --filter @opensesame/os-domain exec vitest run src/__tests__/org-vault-ref.test.ts`
and `node scripts/quality/docs-index.mjs --check`.

**Phase 1 — relay profile and the binding purpose (A1).** Add
`BindingPurpose::VaultRelay` in `crates/domain/src/transport/binding.rs` and
the TypeScript mirror under `packages/os-domain/src/transport-security/`.
Relay profile answers `404` for `POST /api/v1/sync/pull` and for
`PUT /api/v1/operator/transport/bindings`. It refuses a binding document that
is not empty and is not entirely purpose `vault_relay` limited to the two
snapshot operations. `sharing.relay` lands in the Pages catalog as optional
and off.

Gate: a gateway test for those two `404`s; a binding-corpus case that an
exact `vault_relay` binding validates and a wildcard selector still fails;
a composition test that a default Pages plan leaves `sharing.relay`
unapproved.

**Phase 2 — the address on the device list (A2).** One namespace for
principal handles and organization slugs, so a handle and an organization
slug cannot spell the same owner. `listDeviceVaults()` gains `address`. The
plaintext registry stores the ref. The slug is not the sealed display name.
Guest stays null. An organization member cannot publish.

Gate: the phase 0 parser tests, an app-core test that a sealed name is
absent from the registry row, and a membership test that a member's publish
is refused.

**Phase 3 — the slot and the merge (S1).** Implement the routes in §4.
Replay a conformance file the way
`spec/conformance/vault-drive-protocol.json` is replayed by the daemon and
by `packages/app-core/src/lib/tailnet-sync/protocol-conformance.test.ts`.
Two stores converge on edits, a purge, a lost race, and a tombstone. The
slot file contains no item name and no PIN wrap. A join-only session still
writes nothing. Relay profile still answers `404` for `POST /api/v1/sync/pull`.

Gate: those tests. `pnpm --filter @opensesame/pages verify:live-join` remains
the live-session walk. It is not retargeted at the replica.

**Phase 4 — parts and the CLI.** After phase 3's gates. Attachment parts
follow ADR 0144 item 16. `opensesame-id vault sync` accepts a relay pairing
as it accepts a drive pairing. Out of scope for the first implementation
commit.

## Consequences

- A1, A2, and S1 have a first working slice. The checklist can cite the
  relay profile, the address on the device list, and the replica client.
  The issuer registration and the conformance replay are still open.
  A presented member may list and may not publish. With no role, the slot
  key is still the admission.
- `opensesame host run` without `--profile relay` is still the full
  gateway. Relay profile loads an empty binding set unless the operator
  writes one that is entirely `vault_relay`.
- The device list reads `publishedAddress` from the tomb header. Nothing
  in this slice publishes that field from the UI. A presented member role
  cannot create or publish an organization vault.
- Live join still writes nothing. The replica client runs only when a
  caller pushes or pulls. Tailnet sync remains the merge while a vault
  is unlocked. The relay stores the snapshot and does not merge it.
- The relay learns the address, the generation, and the ciphertext length.
  It does not learn item names or secret values. That is the disclosure the
  tailnet drive already makes.
- On a relay with no Identity issuer, the first principal to create the
  address, or to publish a snapshot there, claims it. A different principal
  is refused. The issuer registration is still open: the role is a presented
  header, not a signed registration. A presented `member` role is refused
  on create and publish. The handle and organization-slug namespace is still
  not enforced.
- Live join gains no default public relay, no default TURN server, and no
  widening of `host.join` into sync.
