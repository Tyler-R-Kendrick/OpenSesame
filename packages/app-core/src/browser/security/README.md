# Extension security

Human security settings and a trusted background-worker admission protocol for
both OpenSesame browser extensions. Password matching, owner enrollment and
independent synthetic vault construction come from `app-core`; this adapter owns
browser-port identity and production permits.

Each live owner port receives an opaque, five-minute permit after authoritative
current-password verification. Synthetic permits never authorize real runner,
pairing or autofill operations. No roots, submitted passwords or permits are
stored in extension storage or returned to content scripts. Disconnect, lock,
worker restart, expiry and header changes revoke admission. Unprotected legacy
installations retain existing consent controls; once a worker sees protected
state, missing state fails closed until it restarts.

This is device-local enforcement. An attacker who modifies extension code or
storage can defeat local reporting or existing device-sealed runner protection.
The synthetic core vault key still cannot decrypt the real vault ciphertext.
No external canary receiver is automatically provisioned.

`pnpm --filter @opensesame/app-core test` exercises broker and client
revocation, concurrency and isolation. Integration tests beside each extension
exercise production runner and nonce-bound autofill denial. Real browser evidence
is recorded in the repository's retired-credential validation matrix.
