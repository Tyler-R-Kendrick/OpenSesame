# Exposure matrix

The exposure matrix makes combinations of artifacts and missing controls a
repository rule. Its decision is about what an observer can obtain together,
which proof remains necessary, and which authority enforces that proof.
[ADR 0216](../adr/0216-deterministic-exposure-matrix.md) records the decision.

The policy lives in [`tools/security/exposure-matrix.json`](../../tools/security/exposure-matrix.json).
The checker is [`scripts/security/exposure-matrix-gate.mjs`](../../scripts/security/exposure-matrix-gate.mjs).
It runs locally with Node and has no model, scanner or network dependency.
Source and hook line endings are pinned to LF in `.gitattributes`, so checked-out
source fingerprints agree with committed/index blobs across operating systems.

## What the classifications mean

Classify the actual observer and custody boundary before classifying an
artifact. An unlocked owner's browser necessarily holds plaintext and a vault
key. A recipient who has only a share link must not obtain the secret merely
by replacing the page's JavaScript. A disk thief holding an encrypted backup
has a different attack surface from a caller submitting guesses to a server.

| Combination | Required boundary behavior |
|---|---|
| Public key and ciphertext | Public keys may be published. Their presence is not evidence of key compromise. Identify whether a secret, verifier or online acceptance oracle is also exposed. |
| Public JWKS and signing keys | Project only the supported public parameters. Symmetric keys have no public JWK representation. Private RSA/EC/OKP parameters and unknown private extensions cannot enter the public projection. |
| Share-link ciphertext, payload key and separate access code | The separate code must protect payload release at the authority or cryptographically protect the portable manifest. A client-only check is bypassable. |
| Portable secret release and offline code verification | Use code-bound authenticated encryption and a generated independent code with at least 80 bits of entropy. Fix and bound KDF parameters; reject unsupported legacy formats that release the manifest without the code. |
| Guessable online proof and success/failure response | Reserve attempts atomically before checking guesses. The durable budget must cover the relevant verifier owner and challenge/profile, survive restarts, and be shared by replicas and alternate verification routes. |
| CAPTCHA or caller-IP limit and a guessable proof | Treat these as supplementary controls. They cannot replace the proof's durable shared attempt budget or turn a short code into a strong secret. |
| Long EST password and password-only availability | The reviewed exception uses five durable checks per profile and authoritative source in ten minutes, with a minimum 16-byte password. Source identity comes from verified originating-client evidence or canonical TCP IP, never requester headers, ports or CSR fields. |
| Public caller identifiers and finite credential-budget capacity | Allocate Bitwarden counters only for loaded credential owners. Existing owners retain independent admission; nonexistent identifiers or another owner's buckets cannot exhaust a shared row-count admission cap. |
| Required proof and an optional request field | Missing, empty, malformed and alternate-route requests cannot weaken the configured policy. Check the proof before releasing data or committing the protected effect. |
| One-use, expiry or revoke claims | Name the enforcing authority. Browser-local state cannot establish global consumption, trusted expiry or revocation of copied offline data. |
| Secondary listener, development fallback or ingress credential | Classify exposure and fail closed under production safeguards. Ingress/TLS peer identity and custody of a leaf key do not confer end-client authorization or permission to export another credential. |
| Untrusted migration metadata and filesystem or response-body authority | Treat source IDs as data, confine archive reads without following links, bound body/file intake before allocation, and pin credential-bearing requests to their configured origin. Operator-selected imports do not inherit public sign-in or Send budgets. |

Public certificates and private certificate keys are separate artifacts. A
certificate-download surface does not imply private-key delivery. Inspect
ownership, organization, export grants and the actual response before making
that claim.

EST source partitions preserve replica and alternate-route sharing while avoiding
a five-request lockout of every password-only enrollee. Use randomly generated
passphrases. IPv4 addresses and IPv6 /64 networks define TCP source groups;
clients behind one NAT share a group, and distributed sources receive separate
budgets. This is not a five-guess global ceiling. An ordinary unmarked reverse
proxy shares its TCP source group like a NAT. A declared `TrustedIngress` without
validated originating-client evidence cannot supply a password-budget identity.
Missing trusted source metadata fails closed. Active source capacity is bounded
per profile with expiry-only cleanup; it does not consume another profile's
capacity. Short account/claim codes retain their owner-wide budget contracts.

Public exposures are visible to every observer cohort in the same flow. A public
ciphertext endpoint and an unguarded link-only key endpoint still compose.
Generic authentication, link possession and network contact can also belong to
one caller; their exposures compose within the same flow. These labels confer
no resource-specific export grant. Owner and authorized-recipient custody remain
separate. Use distinct flows for distinct data or contexts, not to hide a join.
Required server proof must be enforced by its authoritative release path. Ordinary
authentication also does not confer permission to export another credential.
The core flow/observer classifications, minimum implementation/test bindings
and reviewed budget bounds cannot be weakened by editing only matrix entries.
Every new online guess oracle also requires an explicitly reviewed owner and
budget contract in the checker. A short code cannot inherit a permissive budget
merely by choosing a new surface ID.

Record the release of each artifact accurately. A public ciphertext is safe when
its key is genuinely withheld behind independent proof. For secret drops, the
payload key is already in the link: separate mandatory rows record that
unconditional exposure, while the hosted ciphertext or portable manifest remains
code-protected. A second ungated ciphertext copy would compose with that key.

Local PIN unlock and opt-in backup recovery slots are separate reviewed
custody classes. A stolen complete artifact may permit offline guesses despite
local UI throttling. Record that residual risk explicitly; do not present
frontend counters, local expiry or a server rate limit as protection against
an observer who can verify guesses without that server.

## What the check establishes

The matrix records the intended observer, exposed artifacts, required controls,
reviewed source/default settings and lifecycle scope for classified surfaces.
The checker evaluates forbidden combinations and binds the classification to
reviewed implementation files by their exact SHA-256 fingerprints. Discovery
is closed within its named, bounded source lanes: a newly discovered protected
file needs a classification. This is not discovery of every listener or route
in arbitrary repository code; extending a boundary beyond those lanes also
requires extending and testing discovery.

Missing sources, source drift, unknown classifications and unsupported policy
input fail closed. Merely naming a helper or a regression test does not prove
it executes. The implementation binding must include the code that enforces
the claim, including shared proof helpers and persistence where applicable.

This is a review fence beside behavioral tests. It is not whole-program taint
analysis or a proof that a declared control works. For example, atomicity and
replica sharing require concurrent tests against the real persistence
operation. A source pin forces review when that operation changes; it does not
replace those tests. The checker does not contact a running deployment or
evaluate its environment variables, database contents or effective operator
configuration. Reviewed budget and entropy declarations describe the bound
source/default contract, not a measurement of a deployment. A green result
applies to the inspected snapshot and classified boundaries.

## Run the check

```bash
pnpm audit:exposure
node scripts/security/exposure-matrix-gate.mjs --staged
```

The first command checks the working snapshot. The staged command reads the
matrix and protected sources from Git index blobs, including their modes, so
an unstaged fix cannot hide a vulnerable staged version.

Pre-commit runs staged validation. Pre-push uses `--push-refs` with the refs
supplied by Git and runs the policy before any optional verification mode can
skip other checks. Root lint runs exposure validation first. The existing CI
changes job runs it as a mandatory prerequisite before affected builds are
selected. Hook and checker errors are failures, not clean results.

## Change a protected boundary

1. Inspect the changed source and its full release/verification path. Identify
   who can obtain each artifact, which proof remains necessary, and which
   process or store enforces it. Review relevant helpers and alternative routes.
2. Fix the enforcement boundary. Required proofs must remain required when a
   caller bypasses the UI, omits fields, replays a challenge or chooses another
   route. Admit guesses before verification through the real shared budget.
3. Add and run behavior regressions appropriate to the change. Include failures
   for omitted/incorrect proof and success for the legitimate flow. For shared
   state, cover concurrency, separate instances, restart, expiry and isolation
   between accounts, claims or profiles. Do not claim a test ran when its
   toolchain or fixture was unavailable.
4. Review the resulting source diff. Update its matrix classification and exact
   reviewed fingerprints deliberately. Include the reason, test results and
   remaining limits in the review. There is no automatic fingerprint-refresh
   or accept-new-debt command.
5. Run `pnpm audit:exposure`, stage the intended source and policy together, and
   run staged validation. Run the applicable package, security and repository
   checks before shipping.

Adding a surface follows the same process. Give it a distinct classification
where its observers, artifacts or enforcing authority differ; do not place it
under an unrelated row to satisfy discovery. Include its entrypoint and all
implementation files that carry the protection. Deleting or moving a protected
file requires updating the reviewed classification and preserving coverage of
the replacement path.

Changes to discovery, the checker, the matrix schema or source bindings are
policy changes. They require review and deterministic negative controls.
Changing a recorded fact to make a failing gate green is not remediation.

## Negative controls

Checker tests must demonstrate rejection of unsafe combinations and drift:
private material in public projections, co-exposed portable payload keys with
client-only code gates, absent shared admission, optional required proofs,
unsupported lifecycle claims and unclassified listeners. Commented helper
names, string literals, unused helpers and test-file names cannot count as an
enforcing implementation.

Snapshot tests must distinguish the index from the working tree: vulnerable
staged source with a fixed working copy fails staged validation; fixed staged
source with a vulnerable working copy is assessed as the staged snapshot.
Missing matrix/source files, unresolved stages, unsafe file modes, symlinks,
malformed policy input and checker failures must produce a failing result.

Behavioral regressions remain separate from these checker tests. Both are
needed: one establishes the runtime boundary; the other establishes that
repository policy notices when its reviewed assumptions change.
