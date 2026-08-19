# Claimable connection delegation — design analysis

Companion to [ADR 0044](../adr/0044-claimable-connection-delegation.md).
This document records the research behind the decision: what exists in the
codebase today (with anchors), what the standards and competing products
offer, the recommended architecture, and a phased implementation plan.

The feature in one sentence: **an owner of one or more authorized
connectors (e.g. GitHub via MCP) mints a disposable, claimable offer over
a connection or a group of connections; a guest human or an agent claims
it and receives attenuated, revocable, invoke-only authority — brokered,
receipted, and without any underlying token ever moving.**

---

## 1. Current-state inventory

### 1.1 What already exists and is load-bearing

| Capability | Where | State |
|---|---|---|
| Sealed connector credentials, AAD-bound to `(connection_id, organization_id)` | `crates/connection-broker/src/crypto.rs` (XChaCha20-Poly1305, AAD `opensesame:connection:v1:{cid}:{oid}`), `migrations/0002_connections.sql` | Built |
| ConnectionRef agent surface, "no token crosses the API boundary" | `crates/domain/src/authority.rs:97` (`ConnectionRef`), `crates/connection-broker/src/model.rs:227` (`ConnectionView.connection_ref`), ADR 0005/0032 | Built |
| Grant attenuation + delegation chains | `crates/domain/src/grant.rs:78` (`validate_attenuation`: refuses cross-org, depth ≠ parent+1, lifetime/action/resource/audience/budget/export widening), `crates/domain/src/delegation_chain.rs` (contiguity, cycle, `beneficiary[i] == issuer[i+1]`), `crates/grants/src/lib.rs:3` (`delegate()`) | Built, Rust domain only |
| Claim-session ceremony (peppered tokens, user codes, CAS state machine, idempotent complete) | `packages/claims/src/engine.ts`, `packages/os-domain/src/crypto/claim-token.ts`, `apps/control-plane/src/routes/claims.ts`; Rust twin `crates/claims/src/lib.rs` | Built |
| Guest/anon principals with later claim | `apps/control-plane/src/routes/principals.ts:70` (`POST /v1/principals/provisional`, `pst_` bearer, quota-fenced), identity linking preserves the principal id | Built |
| Device-flow claim codes (RFC 8628), twice | `packages/oauth-provider` + `packages/device-auth`; gateway `apps/gateway/src/routes/device.rs` | Built |
| Task-scoped authority: ceilings, ratchet, frozen intents | `crates/domain/src/task.rs`, `crates/broker/src/frozen.rs` (`assert_grant_covers_frozen_intent`), ADR 0018/0019/0020/0021/0027 | Built |
| Signed invocation receipts carrying `delegation_chain` | `crates/domain/src/receipt.rs:18`, `assert_no_secret_leak` | Built (chain always empty today) |
| Hash-chained audit trail with redaction allowlist | `packages/audit/src/chain.ts`, `packages/audit/src/redact.ts` | Built |
| GitHub App installation tokens (repo/permission-attenuated, ≤ 1 h) | `crates/connection-broker/src/installation.rs` (`mint_installation_token`), ADR 0039 backup actor | Built for backup only |

### 1.2 Modeled-but-unwired seams (the feature mostly connects these)

| Seam | Anchor | Today |
|---|---|---|
| `claim_sessions.type = 'connection'`, `claim_items.requested_action = 'delegate'` | `packages/database/src/schema/index.ts:500,575` | Vocabulary only; no producer ever creates connection claims or any `claim_items` at all |
| `claim_sessions.requested_grant` / `requested_destination` | same | Stored, echoed, never interpreted |
| `claim_sessions.proof_key_jkt` / `provisional_sessions.instance_key_jkt` | same | Written (agent registration only), never verified |
| `Shareability::{Private,Delegable,OrganizationWide}` | `crates/domain/src/connection.rs:17`; parse/serialize at `crates/connection-broker/src/lib.rs:1770` | Persisted and returned in `ConnectionView`; nothing enforces it |
| `ConnectionPolicy.maximum_delegation_depth`, `permitted_actor_kinds`, `permitted_audiences`, `consent_subject_id` | `crates/domain/src/connection.rs:24-33` | Struct only, unread |
| Identity-plane `delegations` table + `Delegation` type | `packages/database/src/schema/index.ts:345`, `packages/os-domain/src/types.ts:258` | Dead schema: no repo, no route, no writer; `grant_id` is untyped text |
| `connection.delegated` audit event | `packages/os-domain/src/types.ts:538` (`FutureDomainEventType`) | Reserved, unemitted |
| `AuthorityOperation::{Exchange, Lease}` | `crates/domain/src/authority.rs:130` | Enum placeholders for a token-exchange path |
| RFC 8693 token exchange | `docs/protocol-profiles.md:12` — "Semantic mapping only; no token-exchange server in this slice"; grant type explicitly refused by client registration (`packages/contracts/src/oauth-clients.ts:83`) | Slug only |
| `ClaimEngine.revoke` | `packages/claims/src/engine.ts:313` | No caller anywhere |

### 1.3 Gaps that are prerequisites, not part of the feature itself

1. **The gateway invoke path ignores the submitted ref.**
   `apps/gateway/src/routes/intents.rs:88` binds the body's
   `connection_ref` to `_requested_ref` and executes against the
   hard-coded `demo-conn` (`:186`; also `routes/tasks.rs:518`).
   Delegation is meaningless until an arbitrary `conn://` URI resolves to
   a `ConnectionAuthorityBinding` at invoke time.
2. **`authorize_authority_use` is not on the invoke path.** The real
   ADR 0005 fence (`crates/authz/src/authority_use.rs:36`) exists and is
   tested, but the broker path uses `PolicyEngine::decide` with
   `resource.type_ = "connector_operation"` only. Delegate-awareness
   belongs in an authorization that actually runs.
3. **Identity-plane claims/provisional stores are in-process `Map`s**
   (`apps/control-plane/src/state.ts`); the Postgres claim repos exist
   (`packages/database/src/repos/postgres.ts:426`) but are not the running
   path. A share link that dies on process restart is not shippable.
4. **Audit allowlist would silently drop delegation metadata**
   (`packages/audit/src/redact.ts:5-46` has none of `delegationId`,
   `connectionId`, `granteePrincipalId`).
5. **`docs/claims.md` overstates completion atomicity** — completion is
   documented as "applies ownership, writes audit + outbox atomically"
   but the route performs separate non-transactional writes and emits no
   outbox event (`apps/control-plane/src/routes/claims.ts:388-441`).
   Delegation projection to the identity plane needs that outbox event to
   exist.

---

## 2. Prior art (what we borrow, from where)

| Primitive | Source | What we take |
|---|---|---|
| Delegation vs impersonation; `act` chains; `may_act` pre-authorization | RFC 8693 | Semantics only: subject = owner, actor = claimant, recorded in grant lineage + receipts. No wire endpoint (matches `docs/protocol-profiles.md` and the one-shot broker prompt: "Do not add `POST /connections/{id}/token` for agents") |
| Approver ≠ claimant as a first-class flow; grant-as-stateful-resource with continuation; structured access descriptors | GNAP (RFC 9635) | The offer/claim shape: an offer is a stateful resource the claimant polls, the owner (a different person) approves |
| Claim codes: low-entropy human channel + high-entropy machine channel, `authorization_pending`/`slow_down`, single-grant expiry | RFC 8628 | Inverted: the *owner* mints, the *claimant* redeems. We already run this state machine in `packages/device-auth` and `apps/gateway/src/routes/device.rs` |
| Single-use wrapped delivery; first-redeemer-wins; failed redemption = interception alarm ("malfeasance detection") | Vault cubbyhole response wrapping | Claim-spend semantics: a second `present` revokes the offer and notifies the owner |
| Offline attenuation, monotonic narrowing, audience binding per hop | Macaroons / Biscuit / UCAN | Not the token format (our handles are deliberately non-capability: "knowledge is not authorization", `authority.rs:84`) — but the *invariants*: append-only narrowing (`validate_attenuation`), per-hop audience (`proof_key_jkt` binding), ancestor revocation (parent grant revocation kills the chain) |
| Server-side attenuation-on-mint: repo-list × permission-subset × ≤ 1 h | GitHub App installation tokens | Optional provider-level narrowing for GitHub connections that are App-backed (`installation.rs` already mints these for backup) |
| MCP authorization: RS metadata (RFC 9728), resource indicators (RFC 8707), token passthrough forbidden | MCP 2025-06-18 → 2026-07-28; `crates/protocol-mcp/src/passthrough.rs` already rejects passthrough | The delegate-facing surface stays MCP-conformant: agents present their own bearer to our RS; delegated authority never appears as a token |

Competitive fact worth recording: Zapier MCP, Composio, Nango, Arcade,
Anthropic connectors, Paragon, Nextcloud OpenConnector, and
oomol-lab/open-connector all broker *your own* connection; none offers
minting a claimable delegation of an existing connection to another human
or agent. The nearest flows (Composio hosted auth links, Arcade auth
challenges) onboard a *new* credential rather than delegating an existing
one. This feature is differentiating, not catch-up.

---

## 3. Design

### 3.1 Where delegation state lives

On the **authority plane**, beside the thing it narrows (ADR 0032 §1: "a
connection is authority-plane state, not vault state"). Three new SQLite
tables in the gateway store. **Offers always carry items** — a
single-connection share is a one-item offer — so group delegation (§3.4)
is schema-native from day one rather than a retrofit migration:

```sql
CREATE TABLE connection_delegation_offers (
  id                 TEXT PRIMARY KEY,          -- dlgo_…; also the delegation-set id
  organization_id    TEXT NOT NULL,
  owner_subject      TEXT NOT NULL,             -- who minted; must own every item's connection
  claim_token_hash   TEXT NOT NULL UNIQUE,      -- hash_secret(osc_dlg_…); never the token
  user_code_hash     TEXT NOT NULL,             -- hash_low_entropy(pepper, offer_id, code)
  manifest_digest    TEXT NOT NULL,             -- digest over the canonical item set;
                                                --   immutable after create (claim_sessions
                                                --   targetManifestDigest pattern)
  claimant_kind      TEXT NOT NULL,             -- 'human' | 'agent' | 'any'
  intended_claimant  TEXT,                      -- optional principal/actor pin (may_act analogue)
  state              TEXT NOT NULL,             -- pending|presented|claimed|revoked|expired|burned
  presented_at       TEXT, claimed_at TEXT, revoked_at TEXT,
  expires_at         TEXT NOT NULL,             -- offer TTL: default 600 s, ceiling 86 400 s
  created_at         TEXT NOT NULL
);

CREATE TABLE connection_delegation_offer_items (
  id                 TEXT PRIMARY KEY,          -- dlgi_…
  offer_id           TEXT NOT NULL REFERENCES connection_delegation_offers(id) ON DELETE CASCADE,
  connection_id      TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  proposed_grant     TEXT NOT NULL,             -- JSON: actions, resources, audiences,
                                                --   expires_at, budgets, max_invoke_level,
                                                --   allow_redelegation — validated against
                                                --   THIS connection's owner grant at mint
  required           INTEGER NOT NULL DEFAULT 1,-- all items required unless owner opts out
  dependencies       TEXT NOT NULL DEFAULT '[]',-- JSON string[] of sibling item ids;
                                                --   accepted set must be dependency-closed
  state              TEXT NOT NULL,             -- pending|accepted|rejected
  UNIQUE(offer_id, connection_id)
);

CREATE TABLE connection_delegations (
  id                     TEXT PRIMARY KEY,      -- dlg_…
  offer_id               TEXT NOT NULL REFERENCES connection_delegation_offers(id),
  offer_item_id          TEXT NOT NULL REFERENCES connection_delegation_offer_items(id),
  connection_id          TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  organization_id        TEXT NOT NULL,
  owner_subject          TEXT NOT NULL,
  claimant_subject       TEXT NOT NULL,         -- principal id (human) or actor id (agent)
  claimant_instance_jkt  TEXT,                  -- proof-key binding, verified at claim
  grant_id               TEXT NOT NULL,         -- the child Grant (parent = owner's grant
                                                --   for THIS connection)
  parent_grant_id        TEXT NOT NULL,
  delegation_depth       INTEGER NOT NULL,
  budget_remaining       TEXT,                  -- JSON mirror of GrantConstraints.budgets,
                                                --   decremented atomically per invocation
  expires_at             TEXT NOT NULL,
  revoked_at             TEXT,
  created_at             TEXT NOT NULL
);
```

`offer_id` doubles as the **delegation-set id**: an offer is spent at
most once, so the delegations minted from it form exactly one set, which
revokes as one (`revoked_at` on all members in a single transaction) or
member-by-member.

`state = 'burned'` records the malfeasance case: the token was presented
twice, or presented after claim. The offer self-revokes **and so does
every delegation already minted from it** — a token seen again after
spend means the link leaked, and the only safe assumption is that the
race's winner may have been the attacker. This deliberately lets a
token-holder deny service to a legitimate claimant: availability is
sacrificed for integrity, exactly Vault's response-wrapping
"malfeasance detection" trade. `burned` is surfaced to the owner
distinctly from `expired` — it means *compromise*, not lapse.

The identity-plane `delegations` table finally gets its writer, as a
**projection**: claim completion enqueues an outbox event
(`connection.delegated`), and a worker upserts
`{principalId, agentId?, projectId?, grantId, relationship: 'delegates_to',
expiresAt, revokedAt}`. It is a read model for consoles and quota checks;
the gateway row is authoritative. `delegations.grant_id` remains a
soft reference across planes (it already has no FK).

### 3.2 Lifecycle

```
mint (owner)          claim (guest/agent)              exercise             end
────────────          ───────────────────              ─────────            ───
POST /api/v1/         open link → obtain identity      MCP list_connections DELETE offer (owner)
delegations           (provisional principal, or       → invoke_l1 /        DELETE delegation or
{items:[{connection,  existing session, or agent       task_invoke with       set (owner; claimant
  proposed_grant,     instance) →                      conn://… ref;          may drop their own)
  required, deps}]}   POST /api/v1/delegations/claim   broker resolves      grant.revoked_at set;
→ {offer_id,          {token, user_code, accepted,     claimant grant →     parent revocation or
   claim_url,         proof} → spend-once →            authorize_authority_ connection revocation
   claim_token,       one child Grant + delegation     use → egress-fenced  kills the chain;
   user_code,         row PER accepted item, one       invoke → receipt     expiry lapses it;
   expires_at}        transaction                                           burn revokes the set
```

**Mint.** `POST /api/v1/delegations` takes one or more items;
`POST /api/v1/connections/{id}/delegations` remains as sugar for the
one-item case. Owner-fenced exactly like every other connection mutation
(`owner_subject` check, `crates/connection-broker/src/lib.rs:556`) —
**for every item's connection**. Preconditions, each enforced per item
and any failure failing the whole mint (no silent dropping of ineligible
members): connection `Active`; `shareability != Private` (this is where
`Shareability` gains its first enforcement consumer; `OrganizationWide`
behaves as `Delegable` until the OpenFGA tuple-writer work lands, §7);
every proposed grant passes `Grant::validate_attenuation` against *that
connection's* owner grant at mint time (fail early, not at claim); all
connections share one organization (`validate_attenuation` refuses
cross-org anyway — the mint check just makes the error legible); depth
respects each `ConnectionPolicy.maximum_delegation_depth`; claimant kind
∈ `permitted_actor_kinds` when set; item `dependencies` reference
sibling items and are cycle-free. The canonical item set is digested
into `manifest_digest`, immutable thereafter (the
`targetManifestDigest` pattern). The claim token uses a new purpose
separator (`opensesame:delegation-token:v1`) per the `docs/claims.md`
rule that token purposes never mix; prefix `osc_dlg_` so log-scrubbers
and `assertSafeText` can deny-list it alongside `osc_clm_`. A user code
is always minted — consent to authority, like claim completion in
`routes/claims.ts`, is never proven by the link alone.

**Claim.** The claim URL lands on a state-blind page (same rule as
`GET /v1/claims/:id/verify`: "reached by URL alone, so it must not
disclose whether the claim exists or its state"). The claimant first
becomes *somebody*:

- **Guest human**: `POST /v1/principals/provisional` on the identity
  plane — existing machinery, existing quotas
  (`packages/policy/src/provisional.ts`). The provisional principal's
  allowed-actions list gains `connection.claim_delegation`. Because
  identity upgrade preserves the principal id, a guest who later links a
  real identity keeps the delegation — the same "claim it later, lose
  nothing" story the PWA already tells (`apps/pwa/src/App.tsx:146`).
- **Agent**: registers (or already has) an `agent_instance` with
  `publicKeyJkt`; the claim binds to that key.

Then `POST /api/v1/delegations/claim` on the gateway with
`{claim_token, user_code, accepted_item_ids, claimant_assertion,
proof_jwk?}`. The claim page shows the full item manifest before
accepting — the console's existing refusal to complete a claim whose
items it has not seen ("accepting without naming it would accept
something unseen", `ClaimPage.tsx`) carries over verbatim, and
`accepted_item_ids` must name every accepted item; there is no wildcard.
Every `required` item must be accepted and the accepted set must be
dependency-closed (`assertDependencyClosure` semantics) — by default all
items are required, so a bundle claims all-or-nothing unless the owner
marked members optional at mint. Then:

- `claimant_assertion` is how the gateway learns who is claiming without
  trusting a body field ("never read from a request body: the transport
  says who is asking", `model.rs:64`). For principals the control plane
  mints a short-lived signed assertion (audience = gateway, single
  claim); the gateway verifies it the same way it already resolves
  principals via `GET /v1/principals/mapping/resolve` with the service
  secret. For agents, the existing gateway agent-claim path
  (`POST /api/v1/agent-claims/{id}/…`) is the template.
- Spend is atomic: one `UPDATE … WHERE state='pending'` CAS, mirroring
  `activate_credential_unless_revoked`. Losing claimants get 410; a
  presented-then-presented-again token flips the offer to `burned`,
  **revokes every delegation minted from it in the same transaction**,
  and emits `connection.delegation_burned`. There is no notification
  channel to invent for v1: burned offers are surfaced prominently in
  the console offer list and are permanent in the audit trail — never
  silent, never merely "expired".
- If `proof_jkt` was set on the offer or a `proof_jwk` accompanies the
  claim, the gateway verifies possession (nonce signature) — this is the
  first verification of a `proof_key_jkt`-style binding in the system,
  closing the "written but never checked" gap.

On success the gateway, in **one transaction covering every accepted
item**: re-verifies the manifest digest, mints one child `Grant` per
item via `crates/grants::delegate(parent, child)` (which enforces
attenuation + depth against that connection's owner grant), writes the
`connection_delegations` rows (all sharing `offer_id` as their set id),
writes a `connection_bindings` row per connection
(`BindingTargetKind::Identity` or `::Agent`) for discoverability,
appends `connection_events` rows (`EventKind` gains `Delegated`), and
enqueues the outbox events for identity-plane projection. Partial
success does not exist: if any accepted item's grant cannot be minted,
the claim fails whole and the offer stays spendable-once-more is **not**
the behavior — the spend already happened, so the transaction rolls the
spend back too (the CAS and the mint share the transaction).

**Exercise.** No new invoke surface. The delegate's MCP client calls
`list_connections` → sees the delegated ref (listing extends from
`owner_subject == caller` to "caller has a live delegation") → `invoke_l1`
or the frozen-intent task path with the same `conn://` URI. Resolution
changes: subject → grant lookup now consults delegation rows, and
`authorize_authority_use` runs with the child grant and a binding whose
`max_invoke_level` is `min(connection.max_invoke_level,
offer.max_invoke_level)` — default L1 (typed operations) for delegates,
L2 only when the owner opted in. The egress allowlist is the provider's,
unchanged: a delegated GitHub connection still cannot reach a non-GitHub
host. Receipts populate `delegation_chain: [parent_grant_id, child_grant_id]`
— the field has existed since receipt schema 1 and has always been empty.

**End.** Four paths, all already half-built:
- Offer revocation: owner `DELETE /api/v1/delegations/offers/{offer_id}`
  (first caller for the dormant revoke transition).
- Delegation revocation: owner revokes a single member
  (`DELETE /api/v1/delegations/{id}`) or the whole set
  (`DELETE /api/v1/delegations/sets/{offer_id}` — every member's
  `revoked_at` in one transaction); a claimant may drop what they hold
  but never anyone else's. The child grant's `assert_active` fails on
  the next authorize. Per ADR 0018, in-flight task runs are handled by
  mediated restriction, not retroactive cancellation — the doc must say
  this plainly to owners.
- Ancestor revocation: revoking the owner's grant or the connection
  (`DELETE /api/v1/connections/{id}`) kills every descendant, because
  authorization walks `parent_grant_id` and `DelegationChain::validate`
  refuses a chain with a revoked hop.
- Expiry: `expires_at` on offer and delegation; the child grant's
  `constraints.expires_at` is ≤ the parent's by `validate_attenuation`,
  and ≤ the connection credential's own horizon.

### 3.3 Attenuation defaults (the GitHub-through-MCP case)

For a GitHub connection whose owner grant is
`actions: [repository.read, pull_request.create]`,
`resources: [repo:acme/*]` (per `crates/connection-broker/src/catalog.json`
operations and the bootstrap demo grant):

| Dimension | Default for a delegate | Owner may widen up to |
|---|---|---|
| Actions | owner's set minus mutating ops (`contents.write`, `git.push`) | owner's full set |
| Resources | must be enumerated (`repo:acme/catalog`), no `*` | owner's patterns |
| Invoke level | L1 typed operations | L2 constrained HTTP (never L3 — `validate_attenuation` refuses export widening, and the delegate path hard-denies `Materialize` like `routes/intents.rs:95` already does) |
| TTL | 1 h | 24 h, and never past the owner grant |
| Budgets | `GrantConstraints.budgets` e.g. `{invocations: 50}` | owner's budgets |
| Re-delegation | `maximum_delegation_depth = 0` on the child | `ConnectionPolicy.maximum_delegation_depth` |

**Provider-level narrowing (optional, GitHub-App-backed connections
only):** when the connection's credential is a GitHub App installation,
the broker can mint a per-delegation installation token attenuated to
`repositories` + `permissions` at the provider itself
(`installation.rs::mint_installation_token` with a scoped request body).
The token is still never exposed — it is the credential the broker
injects for that delegate's egress calls, cached ≤ 1 h like the backup
actor's. This turns our policy attenuation into GitHub-enforced
attenuation and is the strongest blast-radius story available; classic
OAuth-app tokens (coarse scopes, no down-scoping endpoint) get policy
attenuation only, which is precisely why the invoke stays brokered.

### 3.4 Group delegation (bundles)

Delegating a *set* of connections in one ceremony — "here is my GitHub +
Linear + Slack context for this task" — is the same feature, not a
second one, because offers are item-shaped from the start. What a bundle
adds is aggregation risk, and each risk gets a structural answer:

- **Blast radius.** A bundle is worth more than its parts. Mitigations:
  every item is independently attenuated against its own connection's
  owner grant (there is no bundle-level grant that could out-privilege
  its members); resources must be enumerated per item; TTL is a single
  offer-level ceiling and each item's grant expiry must fit under it —
  the *set* never outlives its shortest-lived justification.
- **Egress cross-contamination.** None possible by construction: egress
  allowlists live on each connection row and are provider-derived
  (ADR 0032 §3). A bundled Slack connection cannot widen the GitHub
  item's `api.github.com` fence, because there is no shared egress
  object to widen.
- **Consent dilution ("I thought I was sharing one thing").** The claim
  page renders the full item manifest; `accepted_item_ids` must name
  every item; the manifest digest is immutable after mint, so what the
  claimant reviewed is provably what the owner minted. The same
  properties protect the *owner*: a console mint review shows exactly
  the item set that will be digested.
- **Coherence.** `dependencies` (the dormant `claim_items` closure
  machinery, finally used) express "PR-create needs repo-read":
  accepting a subset that breaks closure is a typed 422, mirroring
  `assertDependencyClosure`. Default is all-required — all-or-nothing —
  because partial bundles are a coherence decision the owner should make
  at mint, not the claimant at 2 a.m.
- **Revocation asymmetry.** The set revokes as one (one action, one
  transaction), because "un-share everything I shared for that task" is
  the operation owners actually need under incident pressure; per-member
  revocation exists for the calmer case. Burn revokes the set.
- **Audit legibility.** Every delegation row, receipt, and event names
  its single connection; the `offer_id` set key is how consoles
  aggregate. Nothing in the invoke path knows bundles exist — a
  delegated invocation authorizes against exactly one child grant for
  exactly one connection, which keeps `authorize_authority_use` and the
  receipt model untouched by this extension.

The identity-plane mirror is equally natural: a bundle claim projects as
`claim_sessions.type = 'resource_bundle'` with one `claim_item` per
connection (`target_type: 'connection'`, `requested_action:
'delegate'`) — the exact rows the schema has been waiting to hold.

### 3.5 What the claimant holds (deliberately boring)

The claimant ends up with: (a) their own session credential (provisional
`pst_` bearer or agent claim result — issued by us, audience us), and (b)
knowledge of a `conn://` URI, which per `authority.rs:84` is not
authorization. There is no delegation *token*. Authority is the
server-side triple (claimant subject, child grant, binding), checked per
invocation. This choice was deliberate against the macaroon/UCAN
alternative (§5): we keep their invariants (monotonic narrowing, per-hop
binding, ancestor revocation) but keep authority server-side, matching
ADR 0005's rejection of authorization-by-possession and keeping
revocation instant instead of denylist-based.

### 3.6 Identity-plane touches

- `packages/policy`: new actions `connection.delegate` (owner-side; deny
  for provisional principals) and `connection.claim_delegation` (allowed
  for provisional principals, quota `maxClaims` already counts it);
  `HIGH_RISK_ACTIONS` unchanged — `grant.export_raw_credential` stays
  globally denied.
- `packages/audit/src/redact.ts`: allowlist gains `delegationId`,
  `offerId`, `connectionId`, `granteePrincipalId`, `granteeAgentId`,
  `shareability`, `expiresAt`, `delegationDepth`. Values like the claim
  token itself are already caught by `DENY_KEY` (`token`), and
  `osc_dlg_` joins `assertSafeText` in `packages/agent-protocols`.
- `packages/os-domain`: `connection.delegated` moves out of
  `FutureDomainEventType`; add `connection.delegation_offered`,
  `.delegation_burned`, `.delegation_revoked`, `.delegation_expired` to
  the connection event vocabulary.
- Console: an "offers I minted / delegations I hold" view; the existing
  `ClaimPage` fragment-transport and principal-pinning patterns
  (`#token=…` + `history.replaceState`, stash pinned to the signed-in
  `sub`) carry over to the claim page.
- `.well-known/agent-card.json` capabilities gains
  `connection_delegation_claim` so agents can discover the ceremony.

---

## 4. Security analysis

Assets at stake: the sealed provider credential (unchanged — never
moves); the new claim token (one-time secret, same class as `osc_clm_`);
the child grant (authority, server-side).

| Threat | Mitigation | Anchor |
|---|---|---|
| Claim link intercepted in transit / logs | Fragment transport; hash-at-rest (`hash_secret`), never logged (`DENY_KEY` matches `token`); single-use spend; short offer TTL | `docs/claims.md`, `packages/observability/src/logger.ts` |
| Link intercepted *and used* before the intended claimant | First-claimer-wins CAS; any later present flips the offer to `burned` and revokes every delegation minted from it — interception becomes detectable and fail-closed, not silent (Vault malfeasance-detection property). The resulting DoS-by-token-holder is accepted: whoever holds the token proves the link leaked | §3.1–3.2 |
| Wrong person claims (phishing the owner into minting, or the claimant into a look-alike page) | User code as second channel (5 attempts, per-offer fence, mirroring `MAX_CLAIM_APPROVAL_ATTEMPTS`); optional `intended_claimant` pin (`may_act` analogue); state-blind landing page | `routes/claims.ts:38,312` |
| Claimant impersonation at the gateway | Claimant identity from a control-plane-signed assertion or agent instance key, never a body field; optional proof-of-possession on a fresh key, verified (first consumer of the `proof_key_jkt` slot) | `model.rs:64`, §3.2 |
| Delegate extracts the provider token | Unchanged ADR 0005 fences: L3/`Resolve` denied without `raw_credential_export`, which `validate_attenuation` refuses to widen; receipts `assert_no_secret_leak`; egress responses only | `authority_use.rs:70`, `grant.rs:78` |
| Delegate widens scope over time | Attenuation checked at mint *and* the child is immutable; task path adds the ceiling ratchet (shrink-only, ADR 0020) | `grant.rs:78` |
| Confused deputy via MCP | Delegate's inbound bearer is audience-checked and never forwarded (`TokenPassthroughForbidden`); delegated authority is server-side, so there is no delegation token to misdirect | `crates/protocol-mcp/src/passthrough.rs` |
| Re-delegation laundering | Child `maximum_delegation_depth = 0` by default; `DelegationChain::validate` enforces depth, contiguity, cycle-freedom, issuer/beneficiary continuity | `delegation_chain.rs` |
| Guest abuse (mint farm, invoke farm) | Existing provisional quotas + mint rate limits; `GrantConstraints.budgets` per delegation; provider rate-limit attribution via per-delegation receipts | `principals.ts:34`, `provisional.ts:57` |
| Budget race (parallel invokes overspend a delegation) | Synchronous atomic decrement in the same transaction as intent insertion; deny on exhaustion **and** on inability to decrement (contention past retry, quorum unavailable) — same fail-closed posture as `authority_quorum_ok`; receipt-count reconciliation as audit backstop | §7, `broker/src/lib.rs` |
| Bundle aggregation (a group offer grants more than the sum reviewed) | Per-item attenuation against each connection's own owner grant; no bundle-level grant object exists; immutable manifest digest over the item set; full-manifest review with named `accepted_item_ids`; per-connection egress untouched by bundling; one-action set revocation | §3.4 |
| Partial-claim incoherence (subset grants a capability without its prerequisite) | Required-by-default items (all-or-nothing) + dependency-closure check on the accepted set (typed 422), reusing `assertDependencyClosure` semantics | §3.4 |
| Revocation lag | New authorizations fail immediately (`assert_active` + chain walk); in-flight runs follow ADR 0018 mediated restriction — documented, not hidden | ADR 0018 |
| Owner fence erosion | Delegates get `Describe` + invoke only; read/refresh/re-key/revoke/bind stay `owner_subject`-or-operator exactly as ADR 0032 §2 | `lib.rs:556` |
| Audit blindness | New event types + allowlist keys; receipts populate `delegation_chain`; `burned`/`expired` distinguishable | §3.6 |

Threat-model rows to add to `docs/security/threat-model.md` when
implementing: "Delegation offer replay", "Delegate widens via
re-delegation", "Claim-page phishing", each pointing at the tests below.
A dated `docs/security/audit-…` file is *not* pre-created — that series
records found-and-fixed vulnerabilities, not designs.

---

## 5. Alternatives considered

1. **Capability tokens (macaroon/Biscuit/UCAN) as the delegation
   artifact.** Offline attenuation and no claim round-trip are elegant,
   and UCAN's per-hop DID audience binding is the strongest
   non-transferability story. Rejected as the *primary* mechanism: it
   reintroduces authorization-by-possession, which ADR 0005 exists to
   refuse; revocation degrades to denylists; and every verifier needs the
   root secret or chain semantics. Kept as invariants, not wire format.
   Revisit if offline/edge delegation (Pages without gateway reach)
   becomes a requirement — Biscuit third-party blocks would let an offer
   be minted offline and discharged at claim time.
2. **RFC 8693 as a wire protocol** (a real token-exchange endpoint
   issuing delegate-scoped access tokens). Cleanest standards story, but
   it mints *bearer authority* where none is needed, contradicts the
   repo's explicit "no `/token` for agents" guidance, and client
   registration deliberately refuses the grant type. The broker-internal
   exchange (`AuthorityOperation::Exchange`) can adopt 8693 semantics
   against providers that support it later, per the one-shot broker
   prompt WP-D.
3. **Identity-plane-first (delegation as a claim-session subtype living
   in Postgres, gateway consulted at invoke).** Attractive because the
   claim UX and provisional principals already live there. Rejected:
   splits authority state across planes (ADR 0017/0032 both push
   connection state to the host plane), makes invoke-time authorization
   depend on a cross-plane read, and the identity-plane claim store is
   currently in-memory anyway. The identity plane keeps the *ceremony*
   (who is claiming) and the *projection* (what my delegations are); the
   gateway keeps the *authority*.
4. **Sharing the credential itself** (re-wrap the sealed blob for the
   claimant, ossuary-style, like the sealed-store's age multi-recipient
   file). Categorically rejected: violates ADR 0032 §6 ("credential
   material never crosses the API boundary"), destroys revocation, and
   the human-vault deliberately has no recipient-wrap primitive.

---

## 6. Phased implementation plan

**Phase 0 — prerequisites (independently valuable).**
Resolve submitted `connection_ref` in `routes/intents.rs` /
`routes/tasks.rs` instead of `demo-conn`; route the invoke path through
`authorize_authority_use`; move identity-plane claim/provisional stores
onto the existing Postgres repos; add the claim-completion outbox event
the docs already promise. Gates: `pnpm verify`, `cargo +1.88.0 test
--workspace`, `pnpm audit:ast-grep`, `pnpm audit:semgrep`.

**Phase 1 — authority-plane delegation core (item-shaped from day one).**
Migrations for the three tables; broker methods
`create_delegation_offer / claim_delegation / revoke_offer /
revoke_delegation / revoke_delegation_set / list_delegations_for`;
per-item mint validation (ownership, `Shareability`,
`maximum_delegation_depth`, attenuation, dependency cycle check) with
whole-mint failure on any ineligible item; `EventKind::Delegated`; child
grants via `crates/grants::delegate`, one per accepted item in one
transaction; the synchronous budget decrementer (fail-closed);
delegate-aware subject→grant resolution + binding-level
`min(max_invoke_level)`; receipts populate `delegation_chain`. Tests:
attenuation refusals, spend-once race (two concurrent claims, one 410),
burned-state on double-present *revoking the whole set*, all-or-nothing
vs optional items + closure violations (typed 422), one bad item fails
the whole mint, ancestor-revocation kills invoke, set-revocation kills
every member, budget exhaustion and decrement-unavailable both deny,
egress unchanged under delegation (bundled members stay fenced to their
own providers), receipt chain populated, leak denylist over all new
responses.

**Phase 2 — claim ceremony + humans.**
Gateway claim endpoint with control-plane claimant assertion; state-blind
`/delegate` page in the **ceremonies app** (§7, ADR 0045), rendering the
full item manifest and requiring named `accepted_item_ids`;
provisional-principal path with
policy action + quota; mandatory user-code fence; proof-of-possession
verification; `osc_dlg_` in `assertSafeText`; audit events + allowlist
keys; identity-plane projection via outbox (`resource_bundle` claim
session + per-connection `claim_items` + `delegations` rows); console
mint/list/revoke UI with `burned` surfaced distinctly. Tests: guest
claims → upgrades identity → delegation survives; provisional quota
exhaustion; assertion replay refused; manifest-digest mismatch refused.

**Phase 3 — agents + MCP.**
Agent-instance claim binding (jkt-verified); `list_connections` includes
held delegations; frozen-intent path with delegated grants
(`assert_grant_covers_frozen_intent` already narrows on `connection_id`);
agent-card capability advertisement; `apps/example-agent` demo: owner
mints, agent claims, agent invokes `repository.read`, owner revokes,
agent's next invoke fails with a typed denial.

**Phase 4 — GitHub App provider-level attenuation (optional).**
Per-delegation installation tokens (repo/permission subset) for
App-backed connections; cache-and-expire like the backup actor; fall back
to policy-only attenuation for classic OAuth tokens.

Non-goals for all phases: any endpoint returning provider token material;
re-delegation depth > 1 by default; cross-organization delegation
(`validate_attenuation` already refuses it); BFF-merging the planes.

---

## 7. Resolved design decisions

Formerly open questions; each resolved for the most secure option, with
the rationale recorded so a future loosening is a deliberate act.

1. **Claim UX host: the standalone ceremonies app** (originally resolved
   as "console"; amended by ADR 0045). The claim ceremony binds
   authority, so it runs on a dedicated shareable surface that carries
   the properties the console's `ClaimPage` proved: fragment transport
   with `history.replaceState` stripping, principal pinning re-read
   immediately before completion, single-spend in-flight guards, frame
   refusal, and the `claimPageSecurityHeaders()` header set. The static
   Pages origin stays ruled out: ADR 0034's own analysis ("possession of
   the token is equivalent to being the user at the broker origin") is
   exactly the property a claim page must not have on a GitHub-Pages
   origin. The console keeps the authenticated management UI
   (mint/list/revoke, burned surfacing); guests arrive via the existing
   provisional-principal flow, offered in place on the ceremony page.
2. **`burned` handling: fail closed, no new channel.** A re-presented
   token proves the link leaked, so the offer *and* every delegation
   minted from it are revoked in the same transaction (§3.1–3.2). The
   deliberate cost — a token-holder can deny service to the legitimate
   claimant — buys the guarantee that a raced claim never leaves an
   attacker holding live authority. Surfacing is console offer list
   (distinct `burned` state) + immutable audit trail; inventing a
   notification channel is not a v1 dependency, and silence is
   impossible because the claimant's next invoke fails with a typed
   denial that names the burn.
3. **`OrganizationWide`: deferred until real membership tuples exist.**
   Ambient claim-without-offer requires an org-membership authorization
   check; the OpenFGA tuple writers are the follow-up work ADR 0038
   already names, and approximating membership from identity-plane rows
   the gateway cannot verify would be an authorization check that lies.
   Until then `OrganizationWide` behaves as `Delegable` (offers work,
   ambient claims are refused with a typed error naming the
   prerequisite). Fail closed beats almost-right.
4. **Budgets: synchronous atomic decrement, fail closed.**
   `budget_remaining` on the delegation row is decremented in the same
   transaction that inserts the intent; exhaustion denies, and so does
   *inability to decrement* (CAS contention past the broker's standard
   8 retries, or quorum unavailability) — the same posture as
   `authority_quorum_ok`, which already refuses to authorize what it
   cannot verify. Receipt-count reconciliation runs as an audit backstop
   to detect drift, never as the enforcement point: a lagged budget is a
   budget an agent can overdraw in a burst, which defeats its purpose as
   a blast-radius bound.
5. **`credential-connections` (OpenBao-style `CredentialAuthority`
   providers): refused at mint, v1.** Only broker `connections` rows are
   delegable. Dynamic-secret authorities have different lease semantics
   and no per-connection egress fence to inherit; delegating them
   deserves its own analysis rather than a ride-along. The offer schema
   stays provider-agnostic so that analysis can land without migration.
