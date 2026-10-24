# Autofill pairing bearer custody

Status: candidate implemented; full integration verification remains incomplete.
Do not close the finding or merge this change on focused results alone.

## Boundary and change

The autofill extension previously persisted its daemon bearer in
`storage.local`. Reading the browser profile could recover that credential;
loopback Host and extension Origin headers are not proof of a browser process.
Both match and fill ultimately verified it against an approved digest.

The bearer now lives only in volatile `storage.session`, with an in-memory
fallback when that API is unavailable. The background deletes the legacy local
key on startup and makes no daemon call if cleanup fails. It does not migrate
that credential into the new session. Concurrent initialization shares one
promise, so simultaneous commands use the same credential. Session-storage
failure never falls back to disk.

The daemon accepts and writes pairing-file version 2 only. Version 1 digests
are deliberately not migrated: otherwise previously copied credentials would
remain authorized after the extension deleted its copy. Unknown versions also
fail closed. The HTTP format, approval channel, origin binding, plugin switch
and field/origin restrictions remain unchanged.

This removes the disk-copy path without introducing an authentication protocol
or storing a key alongside ciphertext. It does not add proof of possession or
protect live browser memory or a compromised extension.

## Compatibility and rollout

Upgrade and restart both the extension and daemon, then approve a new pairing
code. Old daemon processes retain their old behavior until restarted.

Browser restart, extension reload or extension update now requires a new
approval. Background-worker suspension retains the browser session token.
Daemon restart retains approved version-2 digests. Without `storage.session`,
a background-process restart also requires pairing again. Site grants and
enabled-site settings retain their existing behavior.

## Changed files and regression coverage

- `apps/browser-extension-autofill/lib/fill/browser-ports.ts`: volatile bearer
  binding, legacy cleanup and serialized initialization.
- `apps/browser-extension-autofill/lib/fill/daemon.ts`: custody documentation.
- `apps/browser-extension-autofill/lib/fill/browser-ports.test.ts`: legacy
  deletion/nonuse, concurrency, worker recreation, browser-session reset,
  memory-only fallback, cleanup failure and session-write failure.
- `apps/browser-extension-autofill/e2e/fill.e2e.mjs` and
  `e2e/harness/extension.mjs`: real-browser custody assertion and session bearer
  access for the origin-refusal harness.
- `apps/browser-extension-autofill/README.md`: rollout and session lifetime.
- `crates/daemon/src/fill/pairing.rs`: pairing-file version boundary.
- `crates/daemon/src/fill/pairing_tests.rs`: legacy and unknown version rejection.
- `crates/daemon/src/fill/migration_tests.rs` and `mod.rs`: HTTP match/fill
  rejection before and after re-pairing, pending-only replay to the pairing
  route, and current-session persistence across daemon reload.
- `crates/daemon/src/fill/caller.rs`: precise residual threat boundary.
- This audit and its generated index.

## Verification record

The initial implementation was checked on
`4798795f83c63c219f973a23cab56457811d878e`. The scratch checkout later expired;
the patch was restored on `5b8272b337fa7e4dc9b10568b5fdae16c043390c` for its PR.
The following results distinguish those runs.

### Initial implementation

- All five original browser-storage regressions failed against the original
  implementation. With the candidate, 141 extension unit tests and 17 contract
  tests passed; typecheck, production build, lint and formatting passed.
- A direct-source Rust harness using the actual `pairing.rs`, its tests and
  host-core `operator.rs` passed 16 tests. Those checks included rejecting
  legacy/unknown files and preserving approval, revocation, exact-origin
  binding and digest-only daemon restart persistence. The new legacy-version
  regression failed on version 1 against the exact original `pairing.rs`.
- That focused Rust harness was not a daemon package build or an HTTP
  integration run. Full daemon tests waited on a shared Cargo build lock and
  were interrupted before execution.
- The browser end-to-end build succeeded, but Chromium aborted at startup;
  all 45 cases were cancelled before assertions ran.
- `pnpm verify` passed lint, then stopped because Oxlint returned no JSON.
  `pnpm quality:gate` separately reported pre-existing complexity debt in
  `NativeConnectorPanels.tsx`, outside this patch.
- An independent read-only investigation and candidate review found no
  concrete surviving bypass within the disk-profile-reader threat model.

### Restored candidate

The restored candidate passed 141 extension unit tests and 17 contract tests,
typecheck, production build, changed-file Biome, Rust formatting, MJS syntax
checks and `git diff --check`. Prior source-level Rust results are historical
and do not constitute fresh integration verification on the new base.

Required completion commands include:

```sh
pnpm --filter @opensesame/browser-extension-autofill test
pnpm --filter @opensesame/browser-extension-autofill typecheck
pnpm --filter @opensesame/browser-extension-autofill test:e2e
CARGO_TARGET_DIR=$HOME/.cache/packages/cargo-target \
  cargo +1.88.0 test -p opensesame-daemon fill:: --locked
pnpm verify
```

The storage trigger no longer reproduces through the browser-port binding
under mocked browser APIs. The legacy digest trigger no longer reproduces
through the source-level pairing verifier. Actual HTTP rejection and live
browser lifecycle behavior remain unverified; the finding stays open pending
those tests and the required repository checks.
