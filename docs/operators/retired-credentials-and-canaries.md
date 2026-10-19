# Retired credentials and controlled canaries

This runbook records the recovered feature contract and the implementation's
acceptance boundaries. It does not certify a release: focused results and the
native-browser lifecycle are distinct from the final aggregate verification,
installed-client checks and platform evidence. Read the actual final gate
receipts before treating the feature as ready to ship.

## Product and trust boundaries

The owner manages retired passwords and controlled canaries in Settings →
Security, or through `opensesame-id vault retired` and `vault canary`. Each
inspection or change starts a fresh local primary operation. The configured factor policy
must be satisfied before a result is delivered. An already signed-in Identity
account, copied result object, root-shaped bytes or a successful password KDF
is not an owner or REAL capability.

The PWA and Node CLI own their respective local storage and root. They do not
share a root merely because they show the same account. The extension runner
has a separate credential store and navigates to the configured PWA Security
page; it does not copy that page's root into a background management message.
Its build and unit checks are bounded evidence. Actual extension runtime
validation remains policy-blocked in this environment; do not describe it as
an exercised installed-extension lifecycle.

The Android/iOS application is an OpenID4VC holder/authenticator. Its README
explicitly excludes password, OTP and passkey-provider behavior. It is not a
second password-vault application that needs invented retired-password screens.
A mobile PWA browser journey is separate evidence from native wallet behavior.
`packages/sdk-cli` provides Identity device-flow, loopback and control-plane
clients; it does not own the Node vault or accept identity tokens as local
primary/factor authority. See [ADR 0207](../adr/0207-retired-credentials-and-controlled-canaries-are-owner-ceremonies.md).

The packaged Rust companion used by the Node client is physical custody for
the Client vault's Pages-format header/body projection. It is not activation of
`opensesame vault pass`. That separate git-native sealed-store product uses the
Argon2/XChaCha20 format; ADR 0133 explicitly preserves both formats. Its existing
`retired_native.rs` supplies read-only prerequisite inspection, not enrollment,
classification or a synthetic session. Host sealed-store retired/canary flows
are unsupported here and are not counted as native Client evidence. Extending
this feature to every human password-store format remains additional work;
the presence of a shared root-protection model or executable is insufficient.
See ADR 0207's Client-versus-sealed-store section and the two crate READMEs for
this boundary.

## Retired-password policy and owner flow

A retained password is matched as exact scalar UTF-8 bytes, without Unicode
normalization. V2 uses Argon2id v19, 64 MiB memory, three iterations,
parallelism one and a 32-byte verifier. A vault retains at most three traps and
32 events in a bounded 32 KiB record. Retention is owner-selected from one
millisecond to 90 days; the existing default is 90 days. Expiry uses the local
clock and does not erase stolen verifiers or older backups.

1. Open Retired passwords, or run `opensesame-id vault retired inspect`.
2. Authenticate with a current local primary and the configured second step.
3. Enroll an old password and choose its response explicitly. `reject` records
   use and refuses entry. `synthetic_decoy` opens an independent fictional
   vault and requires the displayed owner consent. Legitimate use of old
   passwords or stale autofill can trigger either response.
4. Authenticate again for enrollment, removal, stale-record cleanup or event
   cleanup. No management result authorizes another command by itself.

At the terminal, `vault retired enroll --response reject` or
`--response synthetic_decoy` privately prompts twice for the retired password.
Use `--retention-days 1` through `90` to select its duration. `remove <id>`,
`clear-stale` and `clear-events` each require fresh owner authentication.
`--primary password|pin` and `--factor totp|email|sms|recovery` select methods;
the primary and factor values are read privately from the terminal, never argv
or a piped agent request.

## Collision exclusion in both directions

Enrollment must refuse a current primary, a retained duplicate, or an enrolled
duress credential. The comparison uses the real physical device inventory,
including contexts absent from the cached registry. Malformed or unfinished
physical state is unavailable, not an empty enrollment list.

The inverse rule is equally important: a retained retired literal cannot become
a current password, alternate PIN or newly selected rotation PIN. Prevention
considers retained expired, future and stale/foreign-context records; those
matches remain data for exclusion, not permission to select a synthetic realm.
The credential lease precedes body/publication leases and remains held through
the actual current-credential write. Cancellation must drain the original
readers and release those leases before another operation proceeds.

NEW vault setup requires an originally unsealed destination. Calling a public
creation method with a noncolliding candidate must not replace a sealed owner
vault. A stale passkey setup callback must not publish into a later project or
synthetic session. Knowing only the primary while its configured second step is
pending must not permit removing TOTP, another factor or the password and then
opening an unprotected session. The regression is
`store-pending-owner-mutations.test.ts`; successful primary unwrap alone remains
insufficient owner authority.

## Synthetic entry, exit and denied authority

Only a live, current-context, unambiguous retired record can select the synthetic
response. Stale hashes remain for collision prevention; they cannot select a
realm. The response uses an independent scratch tomb and key. It preserves the
owner's real ciphertext and any unrelated guest vault, never derives the real
root, and never marks the private session genuine.

A synthetic user can interact with fictional items. Supported interaction events distinguish reads, writes, export
attempts and denied authority against the exact originating trap.
Private admission must refuse real sealed export/sync/merge, root or protector
changes, owner management, real project carry/fork, provider/connector calls,
AI credentials and local secret-backend delivery. A presentation flag or a
forged `getSnapshot()` result cannot bypass that admission. Agent MCP tools
remain independent, narrowly authorized Host surfaces; no synthetic root or
identity token is converted into their bearer authority.

Locking or leaving the synthetic session invalidates accepted work, clears its
key and scratch storage, and returns to the original locked owner vault. It
must not resume a real session automatically. Detection writes already accepted
are drained against their original context; a changed or removed trap is not
silently rebound to a new owner record.

## Controlled receiver and artifact lifecycle

See [Controlled agent-canary receiver](controlled-agent-canaries.md) for exact
pairing, private-file and service commands. The owner chooses the endpoint,
service ID, browser origin and bind port; there is no inferred remote account
or placeholder credential. The receiver gets a public P-256 pairing document,
not the vault's private signing key.

Each pair/review/enroll/remove/export ceremony requires the local owner and
configured factors. Receiver commands bind a one-use, 60-second nonce to the
exact command hash, service and audience. The receiver enforces origin/host,
context, retention and replay bounds and keeps authenticated private state.
MCP-configuration and connection-reference artifacts carry detection-only
bearers. They can report connection/tool activity and return a synthetic status;
they never proxy production credentials, create real sessions or invoke a
production connector. Removing or expiring a record refuses its bearer. Expired
records cannot permanently exhaust the enrollment capacity.

## Evidence and remaining release checks

| Boundary | Relevant concrete verification |
| --- | --- |
| Fresh owner, factors, cancellation and exact result lifetime | `retired-owner-operation.test.ts`, `retired-owner-canary.test.ts`, `store-pending-owner-mutations.test.ts` |
| Physical inventory, restored contexts and both collision directions | `retired-owner-duress.test.ts`, `current-credential-retired-guard.test.ts`, `current-credential-retired-store.test.ts`, `browser-rotate-retired.test.ts` |
| Browser storage and whole owner/reject/synthetic/exit lifecycle | `apps/pages/test/original-browser-physical/native-retired-flow.ts` |
| Receiver cryptography, authenticated persistence, expiry/replay and actual MCP SDK transport | `node/agent-canary-receiver.test.ts`, `node/agent-canary-http.test.ts`, `agent-canaries/canary-owner-effects.test.ts` |
| Accessible owner actions and consent | Retired/Canary credentials panel tests and two-build desktop/phone evidence |
| Node owner commands and installed service | `vault-retired.test.ts`, `vault-canary.test.ts`, installed Client/native NodeData worker receipts; no Host sealed-store activation |
| Deliberately withheld agent and mobile surfaces | Capability-registry parity and ADR 0207 |

Codec tests do not establish physical storage guarantees. UI doubles do not
establish authentication. A browser phone profile is not phone hardware. A
service started from TypeScript is not an installed package. Extension build or
unit success is not a policy-blocked runtime pass. The repository's final
verification, required native jobs, packaging and browser controls must be
reported with their actual outcomes; an incomplete, failed or pending check is
never counted as a pass.
