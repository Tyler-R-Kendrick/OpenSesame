# Wallet-interaction traceability — F01–F15 and T-01–T-44

Swarm Q, the integrated-validation swarm for the wallet-native interaction
layer ([ADR 0086](../adr/0086-wallet-native-interaction-layer.md), with
[0084](../adr/0084-external-authorization-notifications.md),
[0091](../adr/0091-account-exits-and-unlock-ceremony.md),
[0115](../adr/0115-front-door-and-connector-directory.md) and
[0119](../adr/0119-wallet-native-control-plane-composition.md)).

This binds the findings (`Fnn`) and their threats (`Tnn`) to the tests that
actually enforce them, with the exit each test suite produced **in this
session** at dirty checkout `4358f7fe`. The machine-readable companion is
[`wallet-interaction-evidence.json`](wallet-interaction-evidence.json).

## How to read this

- The F- and T- numbers are the swarm's own labels. They are **not** enumerated
  in a single committed ledger; they live in the code comments of the tests and
  routes that enforce them (`Swarm S — … findings F01/F02, threats T-01..T-03`,
  `Swarm D — T-17, finding F15`, …). This document is the ledger, derived from
  those committed anchors — nothing here is invented.
- `Status` is the ACTUAL result observed this session. `not_run` means exactly
  that: Swarm Q did not execute a test that establishes it, and does not claim
  one passed. `owner` names the swarm that authored the enforcing code where a
  committed anchor states it.
- Where a threat has no committed enforcing test in this tree, it is marked
  `unmapped_in_tree` and left `not_run` rather than fabricated.

## Findings

| Finding | Invariant (from the enforcing code/tests) | Enforced in | Anchor tests | Status |
|---|---|---|---|---|
| **F01** | A digest echo over an authenticated session must **not** approve a privileged interaction; `session_reauth` alone is not evidence. | `apps/control-plane/src/routes/interaction-handoff.ts`, `interaction-activation.ts` | `interaction-approval-bypass.security.test.ts` (T-01), `interaction-handoff.test.ts` | **passed** (17/17 + 82/82) |
| **F02** | The approve body may carry **no** client-constructed `ApprovalProof`; a caller cannot name its own mechanism/assurance and have it recorded (evidence manufacture). | `packages/contracts/src/interactions.ts`, `interaction-handoff.ts` | `interactions.security.test.ts` (T-02), `interaction-approval-bypass.security.test.ts` | **passed** (4/4 + 17/17) |
| **F03** | The browser-local access-request/consent path is preserved and offline-complete (no backend required). | `apps/pages/src/lib/local-access-requests.ts`, `local-request-authorization.ts` | `local-access-requests.test.ts`, `local-request-authorization.test.ts`, `access-requests.test.ts` | **passed** (37/37); owner Swarm L — no explicit `F03` tag in-tree, mapped by area |
| **F04** | Every attempt to answer an interaction with a proof is a **durable** record; a proof-attempt store exists (not a session flag). | `packages/database/src/repos/interfaces.ts`, `schema/index.ts` (`findings F04, F05`) | `packages/database/tests/interactions-repos.test.ts` | **partial_fail** (27/28 — see T-07) |
| **F05** | Consuming an approval commands a **real, digest-bound effect**; the executor recomputes the binding from the interaction's own fields, and a consumed row is not itself an effect. | `apps/control-plane/src/routes/subject-adapters.ts`, `interaction-handoff.ts` | `subject-adapters.test.ts` (T-16), `interaction-subject-settlement.test.ts` | **passed** (17/17) |
| **F06** | `/i/:ref` continues into the configured client app (or address mode) without becoming a second authority. | `apps/control-plane/src/interactions/rendezvous.ts`, `routes/interaction-handoff.ts`, `ui/rendezvous-pages.ts` | `rendezvous.test.ts`, `rendezvous-landing.test.ts` | **passed** |
| **F07** | Wallet registration is mounted under `/v1/wallet/registrations`; a pass carries a reference only and authorizes nothing. | `packages/wallet/src/registration.ts`, `apps/control-plane/src/routes/wallet-registration.ts`, `create-wallet-native-mounts.ts` | `wallet-native-mounts.test.ts`, `wallet-registration.test.ts`, `interaction-handoff.q.test.ts` | **passed** (mounts + service); live Google save remains external_prerequisite |
| **F08** | A proof records only what the server **established**; no client value becomes recorded authority. The OpenID4VP holder signature commits to the **approval** digest, not the protocol digest. | `packages/os-domain/src/crypto/interaction-digests.ts`, `interaction.ts`; `packages/openid4vp/src/digests.ts`, `transaction-binding.ts`, `request.ts` | `interaction-proof.test.ts` (T-20), `openid4vp/verify.test.ts`, `request.test.ts` | **passed** (38/38 + 94/94) |
| **F09** | The verifier accepts exactly one **closed DCQL profile**: one credential, the §6.1 id alphabet, a verifiable format, non-empty `vct_values`. | `packages/openid4vp/src/dcql.ts`, `request.ts`, `verify.ts` | `openid4vp/request.test.ts`, `verify.test.ts` | **passed** (94/94) |
| **F10** | An offer **by reference** is still a bearer: it is refused at mint time unless it carries a Transaction Code **or** a `protectedRedemption` promise gated by the same authentication as the offer fetch. | `packages/openid4vci/src/offer.ts`, `errors.ts`; `apps/control-plane/src/routes/openid4vci.ts`, `repos/openid4vci-stores.ts` | `openid4vci/offer.test.ts` (T-24) | **passed** (115/115) |
| **F11** | *(No committed enforcing anchor for an ADR 0086 `F11` was found in this tree.)* | — | — | **unmapped_in_tree** / `not_run` |
| **F12** | Legacy session-only `approved` interactions with no durable proof are **quarantined** before the guard is added; concurrent settlement is serialized by a commit-time compare-and-set, not an eager check. | `packages/database/src/repos/memory.ts` (CAS), `drizzle/0023_*.sql`, `schema/index.ts` quarantine ledger | `interactions-repos.test.ts` (T-07) | **partial_fail** (27/28) |
| **F13** | Phishing resistance is a property of **how** a human was asked, not a label a record may carry; a session re-auth or an out-of-band code may never claim `phishing_resistant`. | `packages/policy/src/approval-mechanisms.ts` | `approval-mechanisms.test.ts` (T-39) | **passed** (12/12) |
| **F14** | *(No committed enforcing anchor for an ADR 0086 `F14` was found in this tree.)* | — | — | **unmapped_in_tree** / `not_run` |
| **F15** | One approval rests on **three separate digests** — operation, decision-under-policy, presentation — and they must not collapse; a reverted operation is a new revision, not the earlier one. | `packages/os-domain/src/crypto/interaction-digests.ts` | `interaction-digests.test.ts` (T-17) | **passed** (38/38) |
| **S12** | No agent surface (MCP host/client, WebMCP, CLIs) may **create, approve, deny, or mint a proof** for a cross-device interaction; settlement and proof are human-only. | `packages/capability-registry/src/interaction-boundary.ts`, `registry.ts` | `capability-registry/registry.test.ts` (T-34), `mcp-host`/`mcp-client`/`pages` `registry-parity.test.ts`, `sdk-cli/device-flow-subject.test.ts` | **passed** (14/14 in capability-registry) |

## Threats

Confirmed anchors carry the test that names them; the remainder have no
committed `Tnn` marker in this tree and are honestly left `not_run`.

| Threat | Finding | Named in | Status |
|---|---|---|---|
| **T-01** | F01 | `interaction-approval-bypass.security.test.ts` — "a bare digest echo over an authenticated session does NOT approve" | **passed** |
| **T-02** | F02 | same file — "a client-constructed ApprovalProof cannot manufacture evidence"; `interactions.security.test.ts` | **passed** |
| **T-03** | F01/F02 | same file — "a generic TOTP success cannot be redeemed as an interaction proof" | **passed** |
| **T-04** | F01/F02 | `interaction-handoff.test.ts` — "contract: create, scan, read, approve, consume" with `enrolPasskey` + `/activation` + `/activation/complete` | **passed** |
| **T-05, T-06** | — | unmapped_in_tree | **not_run** |
| **T-07** | F04/F05/F12 | `interactions-repos.test.ts` (durable proof-attempt + consumed-at constraint + CAS) | **partial_fail** — 27/28; failing: "refuses a consumption time on a row that is not consumed" (missing `interactions_consumed_at_check` in dirty-tree schema) |
| **T-08 … T-15** | — | unmapped_in_tree | **not_run** |
| **T-16** | F05 | `subject-adapters.test.ts` — "verifyInteractionBinding recomputes before it trusts"; `interaction-handoff.ts` comment | **passed** |
| **T-17** | F15 | `interaction-digests.test.ts` — "separates a reverted operation from the earlier revision" | **passed** |
| **T-18, T-19** | — | unmapped_in_tree | **not_run** |
| **T-20** | F08 | `interaction-proof.test.ts` header (`Swarm D — T-20, finding F08`) | **passed** |
| **T-21 … T-23** | — | unmapped_in_tree | **not_run** |
| **T-24** | F10 | `openid4vci/offer.test.ts` — "refuses an offer with neither a tx_code nor protected redemption" | **passed** |
| **T-25** | — | unmapped_in_tree | **not_run** |
| **T-26** | F07 | `wallet-native-mounts.test.ts` — persistent registration surface mounted independently of interaction lifetime | **passed** (mount/list; vendor save external) |
| **T-27** | F07/R-01 | `rendezvous-admission.test.ts` — scanner learns no owner; address probe 404 | **passed** |
| **T-28** | R-02 | `rendezvous-admission.test.ts` — admit refused without enabled address registry | **passed** |
| **T-29 … T-30** | — | unmapped_in_tree | **not_run** |
| **T-31** | F06 | `rendezvous-landing.test.ts` — `/i/:ref` continuation into client app | **passed** |
| **T-32 … T-33** | — | unmapped_in_tree | **not_run** |
| **T-34** | S12 | `capability-registry/registry.test.ts`, `mcp-host`/`mcp-client`/`pages` `registry-parity.test.ts`, `sdk-cli/device-flow-subject.test.ts` | **passed** |
| **T-35 … T-38** | — | unmapped_in_tree | **not_run** |
| **T-39** | F13 | `approval-mechanisms.test.ts` header (`Swarm D — T-39, finding F13`) | **passed** |
| **T-40 … T-44** | — | unmapped_in_tree | **not_run** |

## Q integration harness (Q-02)

`packages/wallet/src/interaction-handoff.q.test.ts` is the one test that crosses
the seam the per-package suites leave open: it mints an interaction reference
with the **production** os-domain factory (`mintInteractionRef`), issues a pass
with the **production** wallet factories (`createWalletProvider` and
`createGoogleWalletProvider`), verifies the RS256 save link with the matching
public key, and asserts the composed invariant.

| Test | Proves | Status |
|---|---|---|
| carries the canonical URL as its only barcode, and no request secret | The barcode is exactly the canonical interaction URL; the `canonicalRequestDigest`, binding-message digest, fronted id, amount, payee and detail type are **absent** from the signed pass. | **passed** |
| the barcode reference round-trips its MAC and is not a bearer | The reference the pass carries resolves under the minting pepper only (`resolveInteractionRef`); a one-character MAC flip and a foreign pepper both resolve to null. | **passed** |
| the production issue path refuses a display row smuggling a secret | The production `issuePass` refuses a Luhn-valid PAN in a display row and names a **path**, never the value. | **passed** |

Run standalone: `pnpm --filter @opensesame/wallet exec vitest run
src/interaction-handoff.q.test.ts` → 3/3, exit 0. Anti-slop:
`pnpm lint:anti-slop:files packages/wallet/src/interaction-handoff.q.test.ts`
→ clean.

## Caveats recorded honestly

- **Package typecheck is red from untracked sibling WIP.**
  `pnpm --filter @opensesame/wallet exec tsc --noEmit` fails on
  `packages/wallet/src/google-client.ts` and
  `packages/os-domain/src/interaction-proof.ts` — both untracked (`??`, not on
  HEAD) concurrent-swarm work. Swarm Q did not touch either; the Q harness file
  itself is type-clean, and vitest transpiles per file so every suite above
  runs regardless.
- **`interactions-repos.test.ts` has one real failure** (27/28), in the
  F12/T-07 durable-store area, on a `interactions_consumed_at_check` constraint
  absent from the dirty-tree schema. It is recorded as `partial_fail`, not
  papered over.
- **The full-repository `pnpm lint:anti-slop` did not finish** (~13 min over the
  dirty tree, terminated). The scoped file lint stands in and is clean; no
  repo-wide clean result is claimed.
- **F06, F07 (router half), F11, F14 and the majority of the T-series** have no
  committed enforcing test in this tree and are left `not_run` rather than
  assigned a fabricated pass.
