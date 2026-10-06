# Independent credential observation receiver

This optional sender delivers closed detection metadata to an explicitly paired receiver. It never sends vault roots, submitted passwords, credentials, cookies, or production bearer tokens. Receiving a retired credential remains a possession signal; the receiver does not identify an attacker or revoke production authority.

Owner settings require the current password and current real-owner policy proof. Pairing starts disabled and unverified. A real authenticated ACK test verifies delivery; a separate owner action enables it. Disabling, removal or replacement discards unsent entries and aborts local pending requests where possible. A request already dispatched may have reached the receiver before withdrawal. The sender can operate during a synthetic session without admitting real authority.

The independent 64-byte material is split into AES-256-GCM and HMAC-SHA256 keys. It is sealed under the device at-rest key alongside the separately sealed outbox, never derived from the real vault root. The fixed POST route is `/v1/credential-observations`; cookies are omitted and redirects refused. HTTPS origins are required except an explicitly approved strict loopback HTTP origin. Provisions expire; authenticated ACKs bind the package UUID, receiver binding and key epoch. `protocol-vectors.json` contains public deterministic interoperability fixtures, not production secrets.

The sender retains at most 32 packages and 64 KiB, attempts each package at most five times, and expires packages after at most 24 hours. It suppresses repeated subjects for 60 seconds and permits at most eight new packages per tomb per hour, including owner delivery tests. Clearing canary events or reconfiguring the receiver does not reset that separate budget. Each flush attempts at most two deliveries with a four-second deadline each; remaining queued counts are returned. A durable enqueue starts a tracked background flush. Later enqueues and explicit flushes can retry queued packages. There is no guaranteed timer execution while a browser/PWA is closed or suspended.

Only the independent observation lock is held during dispatch initiation. It is released before awaiting the response. Owner-authentication and BODY locks are released before delivery-test network I/O. An authenticated ACK followed by the current binding check and durable outbox removal is required to report delivery. Receiver failure does not change vault authentication or local detection evidence. `durable:false` means the host's storage cannot survive process/page termination.

## Controlled POSIX reference software

The software implements the authenticated receiver; it does not deploy a service or contact an independent person. Build from the workspace root with existing dependencies:

```sh
pnpm --filter @opensesame/app-core exec esbuild src/node/credential-observation-server.ts --bundle --platform=node --format=esm --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" --outfile=/tmp/opensesame-observation-receiver.mjs
mkdir -m 700 /tmp/my-observation-receiver
node /tmp/opensesame-observation-receiver.mjs --provision /tmp/my-observation-receiver/pairing.json http://127.0.0.1:18791 --allow-loopback
node /tmp/opensesame-observation-receiver.mjs /tmp/my-observation-receiver/pairing.json /tmp/my-observation-receiver/receipts.json 18791
```

Securely import the private pairing file through owner security settings, test the receiver, then enable delivery. The generation command writes independent random material to a new private file and refuses to replace an existing file. It prints no key material. For an independent HTTPS receiver, choose its exact externally controlled HTTPS origin at provisioning and terminate TLS through infrastructure you administer. This loopback reference always listens on `127.0.0.1`; it does not configure TLS or public ingress.

Provision reads use no-follow descriptors and verify file owner, one link, mode 0600, size and unchanged descriptor metadata. Receipt storage requires an owner-controlled mode-0700 directory without symlinked ancestors, verifies directory identity before commit, and uses private temporary files, fsync and atomic rename before issuing an ACK. A private lifetime lock prevents two processes from sharing one receipt namespace. SIGTERM/SIGINT drain receiver work and close the lock. After a crash the lock can remain: confirm the prior process has stopped before manually removing only that `.lock` file, preserving the receipt file. Duplicate authenticated packages return the original ACK after restart without adding a second receipt; conflicting replays are rejected. The reference bounds active requests, request size, stored receipts and the hourly budget.

This Node reference requires POSIX file ownership/mode protections and refuses Windows. Native receivers use their platform protection adapters; a Windows file ACL guarantee is not inferred from POSIX mode bits. At-rest protection does not establish an independent trust boundary against an attacker controlling the original device and its code. Receiver key compromise permits forged observation metadata and ACKs, but grants no real-vault authority. End-to-end notification reliability depends on the receiver, configured networking and running/scheduled clients; this software does not silently add mandatory infrastructure.
