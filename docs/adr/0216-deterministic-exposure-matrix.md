# ADR 0216 — Enforce the exposure matrix at reviewed boundaries

- **Status:** Accepted
- **Date:** 2026-10-30
- **Amends:** [ADR 0062](0062-secret-drop.md), secret-release proof enforcement;
  [ADR 0215](0215-trunk-builds-only.md), mandatory static boundary validation
- **Operating contract:** [Exposure matrix](../security/exposure-matrix.md)

## Context

Individually ordinary artifacts can compose into an authentication bypass.
Ciphertext and a decrypting key in a share link defeat a separate access code
when the code is checked only by the recipient UI. A four-digit code behind
unrestricted server verification is enumerable even when every submitted guess
is encrypted with an RSA public key. Public keys are expected to be public;
private signing material and usable verification oracles are different assets.

Source review found both release-code bypasses and unrestricted enrollment
passphrase checks. An exported public-JWKS helper also relied on an incomplete
private-field deletion list. Fixing those functions leaves the same composition
available to the next implementation unless the repository records and checks
the boundary contract.

## Decision

Maintain the observer, artifact, proof and lifecycle classifications in
`tools/security/exposure-matrix.json`. Run the local deterministic checker at
`scripts/security/exposure-matrix-gate.mjs` through `pnpm audit:exposure`.
The checker uses Node and checked-out source; it sends no source to an external
model or scanner and requires no remote service.

Policy rejects these combinations within the classified boundaries:

- Public projections containing private key material or unknown key extensions.
- A portable secret-release package that provides ciphertext and its decrypting
  key while treating a client-only access-code check as another required proof.
- An online guessable proof without an atomic, durable verification budget
  shared across the relevant owner and service replicas. A CAPTCHA, IP limit or
  frontend counter cannot replace a short code's owner-wide budget. Long EST
  passwords use an explicitly reviewed profile/source partition, with trusted
  source evidence and a minimum 16-byte password, so one source cannot lock out
  all password-only enrollees.
- Caller-chosen nonexistent Bitwarden identifiers allocating durable counters,
  or a shared counter-capacity cliff denying unrelated existing credentials.
- Observer-held portable secret release without both code-bound authenticated
  encryption and a generated independent code with at least 80 bits of entropy.
- One-use, expiry or revocation claims whose advertised authority does not
  enforce them. A recipient's own browser is not a global lifecycle authority.
- Optional or omitted proofs weakening a policy that requires those proofs.
- Secondary listeners or development fallbacks outside their declared exposure
  and production safeguards, or transport/ingress custody being treated as an
  end-client authorization grant.
- Untrusted migration IDs selecting local filenames or escaping their archive,
  response/file limits checked only after an unbounded allocation, or malformed
  API paths redirecting credential-bearing requests beyond their pinned origin.

Bind classifications to reviewed implementation files using explicit SHA-256
fingerprints. Discover protected files within named, bounded source lanes and
require classification of new ones. Extending a boundary beyond those lanes
requires extending and testing discovery. Missing, changed or unclassified
protected source fails closed. A review
must examine implementation changes and run the corresponding behavior
regressions before updating a classification or fingerprint; there is no
automatic rebaseline command.

The matrix is a policy input, not a proof supplied by its author. Source pins
are review fences. The checker does not prove arbitrary interprocedural data
flow, cryptographic entropy, concurrency or authorization semantics. Declarations
describe reviewed source/default settings; the checker does not inspect a live
deployment's configuration or state. Real
boundary tests establish those properties; deterministic negative controls
establish that omitted guards, exposure drift and unsafe combinations fail the
repository check. Keep coverage and residual offline risks explicit.

Pre-commit validates the Git index, including the staged matrix and source.
Pre-push validates the proposed refs before its optional verification mode can
skip other work. Root lint runs the check first. The existing CI changes job
runs it as a mandatory static prerequisite; no additional CI job or external
scanner is introduced. These checks remain required when test suites are
deferred to delivery qualification under ADR 0215.

## Consequences

A protected implementation change requires an explicit boundary review, even
when a small edit preserves its public API. Newly discovered surfaces require
classification instead of silently inheriting another route's protection.
Reviewed source fingerprints add maintenance cost; that cost is the point at
which a reviewer must reconsider the composition and its regressions.

Portable sharing can enforce code-dependent confidentiality without claiming a
global one-use, revoke or expiry service. Local PIN/backup recovery remains a
separate custody class with its own disclosed offline-guessing risk. It must
not borrow the assurance or lifecycle claims of server-held verification.

A green exposure check means the classified, source-bound policy passed for
the inspected snapshot. It does not certify the repository or a live deployment
as free of vulnerabilities. Changes to the checker, discovery and matrix are
themselves reviewable policy changes, not an exemption from security review.
