# Retired-credential isolation: evidence and bounds

This feature detects exact use of selected retired credentials. A match has no
production authority: its response is rejection or a new synthetic session.
The safety goal is unchanged real-vault confidentiality and authority even if
the holder knows the source and recognizes the decoy. Detection and deception
are separate outcomes, and a match does not establish malicious intent.

The tests below are executable regression evidence, including deterministic
property tests. They are not a formal proof of the complete implementation or
of arbitrary client operating systems. The cryptographic argument assumes
WebCrypto's random generation and AES-GCM security, independent random roots,
and that the real root and a previously authenticated owner session have not
already been compromised.

## Executed adversarial invariants

Run from the repository root:

```sh
pnpm --filter @opensesame/app-core exec vitest run \
  src/lib/retired-credentials/records.property.test.ts \
  src/lib/retired-credentials/isolation.property.test.ts
```

On 2026-10-05, the two files passed all eight tests (Vitest 4.1.11, Node runtime).
The deterministic property seeds are `1730105`, `1730106`, and `1730107`.
The same files passed Biome and strict anti-slop Oxlint without warnings.

| Invariant or residual | Adversarial stimulus | Executed evidence |
| --- | --- | --- |
| Classification rejects malformed state | Generated cross-vault records, duplicate IDs, excessive traps, wipe response, invalid salt/verifier, extra authority field | 28 generated mutation cases; refusal before successful classification and owner state unchanged |
| Matching has no response-order fallback | Two valid records have the same verifier and different responses | Ambiguous matches refuse without recording a successful decision |
| Evidence has bounded cost and closed semantics | Mixed synthetic writes, denied authority, unknown IDs, and reject-only IDs | 12 generated operation sequences of 33–80 steps compared after every step with an independent 32-event model |
| Storage bounds count encoded bytes | UTF-8 payload below 32,768 JavaScript code units but above 32,768 bytes | Probe refuses, as does an unsupported `attacker_confirmed`/wipe event |
| Stale legitimate credentials are non-destructive | Retired reject credential is replayed while the real owner is unlocked | Owner snapshot, real encrypted header/body, and duress fence remain identical |
| Decoy key admission remains isolated after discovery | Clear presentation labels and the local decoy marker, then directly use admitted keys on actual real-vault ciphertext | AES-GCM refuses; admitted key is non-extractable; direct real snapshot merge into the scratch store also refuses |
| Another unlocked store retains its real data | Construct an unlocked owner store before entering the synthetic session in the original store | Owner snapshot stays identical; stored real header/body are unchanged |
| Ciphertext is bound to its destination | Try 32 generated different tomb bindings with the real encryption key | Every substituted binding refuses; original binding decrypts |
| Password rewrapping cannot revoke old recoverable roots | Recover the reused root through a retained old password wrap | Current header rejects the old password, but the old wrap still opens newly sealed data under the reused root |

The last row deliberately demonstrates a residual exposure. The feature must
never be described as retroactively protecting old snapshots. If a recovered
old snapshot reveals a root still used by current ciphertext, compromised-key
recovery requires root rotation and appropriate re-encryption. Data already
decrypted by an attacker cannot be recovered by this feature.

## What the key-admission argument covers

A retired credential authenticates only against a separately retained matching
record. It does not unwrap the real root. The synthetic compartment and guest
store each mint independent roots. The executable test uses the actual owner
snapshot and the actual admitted decoy compartment key; it removes presentation
state before trying direct decryption. The scratch store's direct snapshot
merge refusal separately exercises its guest root rather than a screen guard.

Relabeling a session or removing a local UI guard cannot make these independent
keys open current real ciphertext. A discovered decoy may stop being convincing
while retaining that cryptographic boundary.

This argument does not establish an independent trust boundary for code running
with unrestricted access to the owner's browser profile or native process. A
modified client can bypass local telemetry and UI transport guards, issue its
own network requests with ambient cookies, or use a real key already admitted
to another compromised authenticated context. Client code cannot turn an
existing production cookie into a cryptographically invalid cookie. Production
services must enforce their own authentication, authorization, and token
audience checks; callers must not inherit real authority into a synthetic
session. Application API denial tests check the shipped application boundary,
not a mathematical guarantee about arbitrary modified local code.

## Cross-runtime and operational evidence

These property tests run against the shared core, using the real vault
cryptography and public store APIs rather than replacement cryptographic
primitives. Client adapters must separately demonstrate persistent scoped
storage, exclusive credential changes, fresh owner authentication, secret-safe
input, exact unlock routing, and authority denial. A build or a shared-core
passing suite alone does not establish those adapter properties.

The task's [evidence record](../evidence/2026-10-05-retired-credential-traps/README.md)
records the actual client, browser, native, CLI, and release checks performed
and any remaining blockers. No unexecuted client check, browser journey, hosted
notification path, mutation campaign, or external canary deployment is claimed
by this document. Local observations are bounded best-effort evidence that can
be lost, withheld, or altered by someone controlling the client storage.

Attacker-controlled values are excluded from event semantics. Submitted
passwords are never logged; incident consumers must still treat client-origin
evidence as untrusted data and never execute it as instructions.

## Extension trusted-worker permit evidence

The extension's background broker issues short-lived opaque permits after
trusted classification. A permit for the synthetic realm cannot authorize
production operations. A caller-supplied realm or permit is not an unlock
request field. This worker boundary is tested independently from a popup's
presentation marker.

```sh
pnpm --filter @opensesame/app-core exec vitest run src/browser/security
```

On 2026-10-05, `broker.test.ts` passed all 14 tests (Vitest 4.1.11, Node runtime).
The tests cover:

- Forged permits, missing permits, and worker-minted synthetic permits refuse
  production authority; worker-minted real permits succeed.
- Disconnect, lock, failed unlock, and replacement with a synthetic session
  revoke the requesting port's earlier permit. Independent real ports retain
  their own permits.
- Permits expire exactly at five minutes and disappear on worker restart.
- Changed header revisions refuse old permits. A worker that has observed a
  protected vault refuses a downgrade to a missing header.
- Header changes during authentication refuse admission. Deferred classification
  and final revision reads exercise lock/disconnect races. A superseded real
  unlock finishing after a newer synthetic unlock cannot mint real authority.
- At most 32 live ports attach; disconnect releases capacity. Closed request
  schemas refuse unknown authority fields, unsupported operations, invalid IDs,
  empty passwords, and passwords exceeding 1,024 UTF-16 code units.

These are broker tests with controllable classification, revision, and time
ports; they do not replace executing the installed extension's popup,
background transport, origin checks, or browser/native integration. The initial
unprotected-installation consent path is deliberately preserved. The broker's
observed-protection state and permits are process-local; worker restart loses
permits, and the persisted installation state must independently establish
whether a vault is protected. Password request limits count UTF-16 units rather
than UTF-8 bytes.

## Extension production-message regressions

On 2026-10-05, six autofill security tests passed as part of the companion's
full Vitest suite: 138 tests across 13 files. The security tests use the real
`ExtensionRealmBroker` and production `createFillService`, with the existing
typed browser/daemon harness rather than module replacements.

They establish that synthetic admission sends no arm and calls no daemon;
each gesture retains its original worker authorization closure; a content
request cannot replace that closure; revocation before the value request or
during site verification prevents daemon value retrieval; revocation while
the daemon awaits withholds the returned secret; and refused nonces remain
spent across retries and fresh authentication. A fresh real gesture still
fills once, while popup replies, arm messages, and stored choices contain no
secret.

Four main-extension `runner/security-listener.test.ts` tests also passed using
the real broker and a structurally typed runner service. Synthetic or forged
permits prevent production calls, status finishing after disconnect is
withheld, an arm finishing after revocation is disarmed without starting a
tick, and only the extension's own page receives responses. These tests do
not establish that a full native-backed runner tick succeeds; they exercise
the production listener's authorization boundary directly.

Twelve `packages/app-core/src/browser/security/client.test.ts` tests passed for the
production page client with a typed in-memory worker port. Late replies after
lock or disconnect cannot restore permits; concurrent out-of-order replies
cannot supersede the newest classification; disconnect resolves pending
requests as locked and prevents later posts; post failures fail closed;
malformed and unsolicited replies are ignored. Synthetic permits remain
classified as synthetic and still require worker authorization checks for any
production operation.

Live authorization is also round-tripped to the trusted worker rather than
inferred from a page-held permit. Five `broker-authorization.test.ts` tests
verify owner-port binding (a stolen real permit on another port refuses),
synthetic and expired refusal, lock/disconnect and revision-change races, and
the protected-to-missing-header downgrade guard. Client authorization tests
verify that worker denials, dead ports, post failures, and a lock between reply
delivery and promise continuation all return false. On 2026-10-05, the complete
shared browser security suite passed 36 tests in four files.

Five additional capacity regressions enforce at most two active password
classifications per port and 32 across the worker. Overload revokes the port's
previous permit and supersedes in-flight replies. Lock and disconnect retain
occupied slots until classification settles, preventing cancellation or port
churn from bypassing the bound. Failed work releases capacity; closed ports
cannot start another classification.

These four new files passed Biome and strict anti-slop Oxlint. The task
evidence record, rather than these focused passes, is the authority for full
main-extension suites and real-browser installation checks.

## Integrated admission and realm-transition evidence

The [October 6 adversarial evidence](../evidence/2026-10-06-retired-credential-release/adversarial/README.md) records
309 passing tests in 41 files and final scoped V8 coverage over eighteen
production modules, including the new real-admission and activation helpers.
It retains exact source hashes and mutation outcomes, including failed
temporary 100% mutation thresholds rather than a claim of complete proof.

Actual production crypto regressions pause owner password/PIN unwrap, root
import, body load, MFA confirmation, passkey/recovery proofs, guest minting,
and writes while a successor realm is admitted. Stale work is withheld and
raw copied roots are wiped; it cannot install real data into a synthetic
store, resume a cancelled MFA challenge, commit a queued synthetic write into
the owner's new session, or roll back that session on a late write failure.
The operation-guard property campaign independently exercises key-only and
realm-only substitutions, with seed `1731007`, 128 sequences, and at most
32 transitions per sequence.

The current extension worker has two active classification slots globally,
two per port, and 32 live ports. Disconnect does not release a running KDF
slot until that work settles. This updates the historical 32-work-slot
snapshot retained in the older mutation evidence.
