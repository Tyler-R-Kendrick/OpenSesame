# ADR 0097: Bounded password-wrapper KDF work

Status: accepted

## Context

An encrypted wrapper's Argon2 parameters are untrusted before authentication.
The historical ceiling admitted one GiB and sixteen passes, which can exhaust
portable clients before a password or ciphertext is validated. This is a
resource-admission defect, not a weakness of Argon2id.

## Decision

Rust human-vault writers retain Argon2id v0x13 with 64 MiB, three passes and one
lane. Neither the security floor nor the existing cryptographic envelope changes.
Native readers admit at most 256 MiB, eight passes and four lanes. Wasm readers
admit at most 64 MiB, three passes and one lane. The platform selects the policy;
wrapper metadata cannot select or increase it. Parameter admission and checked
memory/work estimates precede Argon2 allocation. Encoded salt, nonce and wrapped
key lengths are also checked before derivation.

The offline native CLI exposes metadata-only inspection of a standalone
`PasswordWrapper` JSON file and an explicit rewrap operation. Inspection reports
resource estimates and platform compatibility, never a password-validation
claim. Input is bounded to 4096 bytes and must be a regular local file.

Rewrap requires explicit memory/pass arguments, displays the diagnostic, then
requires the human to type `MIGRATE` at an interactive terminal before asking for
the password without echo. The budget cannot exceed the historical one GiB,
sixteen-pass, four-lane limit. No network route, wrapper field, environment
credential or model tool grants this exception. Passwords are not arguments or
logs; the CLI holds its acquired password in a zeroizing secret container.
The existing cryptographic migration function unwraps and rewraps the same root
key with the unchanged portable writer policy.

Output is a separate, newly created owner-only file, staged and synchronized
before atomic no-clobber publication. Existing files, including the input, are
never overwritten. Directory synchronization errors distinguish publication
from durable completion. The initial command refuses non-Unix platforms because
this CLI does not yet have a verified owner-only Windows ACL writer; inherited
ACLs are not treated as equivalent protection.

## Compatibility and recovery

Existing compatible wrappers require no migration. Over-budget wrappers remain
intact and receive a metadata diagnostic instead of expensive attempted work.
The command accepts standalone Rust password wrappers, not a sealed-store
manifest, a Pages vault, or the TypeScript PBKDF2 format. Operators retain the
original until they have verified the new wrapper against their vault data.
Interrupted work before publication leaves no partial destination; retry uses
a new output name if a prior publication completed. Rollback selects the retained
original with an explicitly permitted offline budget, never relaxed network
admission. Rewrapping preserves the vault root key and therefore ciphertext.

## Evidence and limits

Policy tests cover native/Wasm ceilings, floor preservation, overflow, and
confirmation requirements. CLI tests cover metadata-only reporting, malformed
and oversized files, owner-only publication and refusal to overwrite.
These ceilings bound admitted work, not available RAM: operators must inspect
their actual machine resources before approving legacy work. Same-user malware
and a compromised operating system can still observe an active password ceremony.
