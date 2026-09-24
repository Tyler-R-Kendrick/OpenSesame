# Local authority storage freshness

The browser IAM implementation is not complete. This records a storage
prerequisite, not authentication, authorization, or OIDC conformance.

## Confirmed defects

The general boot hydrator ignores unsuccessful OPFS reads. Reusing it for
directory refresh retained cached records after another tab deleted the file
or storage became unavailable. A successful refresh could therefore expose an
old snapshot. The existing directory enabled flag does not yet enforce access;
this was a latent authority risk, not a demonstrated authorization bypass.

The durable writer also treated failure to obtain an available OPFS root as
session-only success. It could acknowledge a change that did not persist.

## Changes

Directory reads now use a bounded, explicit refresh. A missing file clears the
cache. Other read failures clear it and reject; oversized files are rejected
before reading text. Boot hydration retains its best-effort behavior so storage
failure does not remove guest access or create a setup wall.

Durable writes propagate OPFS access failures and publish to memory only after
the persistent write succeeds. Browsers without the OPFS API still support
explicitly session-only storage. That mode is not durable IAM state.

## Evidence and remaining boundary

Focused Vitest run: `kv.test.ts`, `local-directory.test.ts`, `vfs.test.ts`,
and `settings.test.ts`: 54 tests passed. Pages typecheck, scoped Biome and
scoped strict anti-slop checks passed. No full-repository verification or
model-backed scan is claimed.

The refresh caller must hold the appropriate Web Lock when making an authority
decision or mutation. This does not make the VFS data/index pair transactional,
authenticate directory identities, implement grants, or provide session
revocation. Those controls remain required before local records can authorize
operations. Same-origin malicious JavaScript remains inside the browser trust
boundary; encryption at rest does not isolate it from an unlocked application.
