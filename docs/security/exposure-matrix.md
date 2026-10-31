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
| Primary vault unlock material and pending local factors or contact approval | Bind every completion to its original owner and lifetime. Keep ordinary VFS access closed until configured factors and quorum complete; lend only bounded private IAM verification before approval. Cancel or lock synchronously revokes provisional custody. |
| Admitted provider credentials and asynchronous secret results | Retain the original provider transport and connection revision through secret reads, local decryption and the final revision lock. Refuse publication after withdrawal even when a caller omits an optional abort signal. |

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
Every custody surface likewise needs an explicit core custody contract. A new
device-owner row cannot silently borrow the privileged import classification or
the local vault activation controls.

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

## Local vault activation

`local-vault-activation` classifies the owner's local process: `custody`,
`device-owner`, `client-only` verification and `advisory` enforcement. Its
artifacts include ciphertext, the payload key, plaintext secrets and private
keys held by an authorized unlocked session. Its lifecycle guarantees are
empty. The checker rejects removing or relabeling this boundary, hiding those
artifacts, changing its enforcement classification, or adding global guarantees.

| Required control | Reviewed behavior |
|---|---|
| `original-owner-lifetime` | Primary, second-step and contact completions retain the original scope, session generation, cancellation signal and transport identity. A stale completion cannot adopt or close a newer session. |
| `synchronous-provisional-revocation` | Cancel, expiry and lock clear owned provisional key/body/VFS custody immediately; cleanup releases only the original attempt's resources. Late decrypted project, org and IdP hydration cannot republish retired session state. |
| `bounded-preapproval-iam` | An opaque, revocable handle reads only trusted policy, identity directory and identity credentials, with fixed size limits. Genuine WebAuthn verification may advance an existing assertion counter through a writer that checks the original owner before durable commit and cache publication. Unsupported transports refuse this write and policy enrollment; they cannot borrow the default KV writer. It opens no ordinary VFS, releases no root/key or ordinary file, and issues no consumable IAM sign-in evidence. |
| `owned-single-flight-publication` | Activation and acquired leases have one owner. Duplicate/concurrent approvals cannot publish multiple activations or lose a lease; metadata, preferences, credential counters and device-key/body publication retain the original operation checks. Late authentication bookkeeping cannot overwrite newer deadman state, and late self-authenticator registration cannot restore a removed or replaced factor. |
| `separate-ordinary-file-metadata-writes` | An already unlocked vault may reconcile its device identity through an explicit file-store writer. The original owner is checked at the backend commit and before mirror, index and registry publication. This metadata capability refuses BODY projection and does not provide the private IAM writer or a fresh authentication reader. Unsupported stores refuse guarded writes instead of borrowing another transport. |

The mandatory source and regression inventory lives in
[`exposure-local-vault.mjs`](../../scripts/lib/exposure-local-vault.mjs).
It binds the store entrypoints and lifetime checks, primary and second-step
helpers, private IAM readers and WebAuthn verifier, general VFS and KV write
ordering, lease custody, metadata caches and device-key reconciliation. Deadman
authentication binds its signed state, shared arm/disarm commit fence and write
helpers; that bookkeeping does not classify relay release authority or establish
global expiry. Shared
package exports and factor/header integrity helpers are bound too. The genuine
store regressions cover canceled or expired completions, newer-session survival,
quorum before ordinary file access, real contact assertions, counter custody,
lease cleanup, guarded file/index/registry commits and late cache/device-key,
deadman and factor-registration results. Their controlled-completion
fixture is also fingerprinted; naming a test alone cannot establish that proof.
Discovery includes new modules under these named lanes and their nested helper
directories. Every discovered local activation helper must bind to the mandatory
local contract; another row in the same area cannot substitute for its controls.
A new authentication road outside them requires extending discovery. File-backed
stores retain ordinary unlock and identity adoption/replacement without contact
quorum. Their separate ordinary metadata writer carries the same owner check
through memory publication, directory rename and signed S3 request dispatch,
including retry and success-recovery paths. Withdrawal cannot publish a stale
mirror or start a later index/registry write. An already accepted physical or
remote write is not rolled back. Private preapproval IAM and policy enrollment
still require their own supported transport; an ordinary metadata capability
cannot stand in for it.

An unverified failed primary owns no root. Retiring that attempt preserves an
already admitted native identity; once a primary root is retained, cancellation
still synchronously clears its custody. Genuine OIDC admission regressions cover
wrong PIN/password followed by legitimate unlock and explicit lock, using a real
local vault and an independently signed TLS exchange. Device sync/restore tests
retain separate per-device storage maps, with guarded writes asserting ownership
immediately before publication into the same device map. Their real protocol,
ceremony and device fixtures are bound as evidence support; this adds no OIDC,
S3 or tailnet authority classification to the local custody row.

The two private-IAM and WebAuthn helper paths are shared source infrastructure:
core vault activation, Access approvals and local identity use them. Their
classification rules and boundary regressions are bound too. Sharing these
helpers grants no capability; optional sections and runtimes retain their
existing owners and approval requirements.

This is LOCAL process policy, not an offline cryptographic quorum. Someone with
copied vault artifacts and the primary unlock material can bypass these browser
checks and decrypt the artifacts. Local counters do not impose an offline guess
budget, and local cancellation or expiry cannot revoke copied data. Source pins
and these regressions also do not establish crash atomicity or cancellation of
physical storage writes already accepted by a transport.

## Native provider results

`native-provider-custody` is a separate local `device-owner` custody boundary,
with `client-only` verification, `advisory` enforcement and no global lifecycle
guarantees. It covers provider ciphertext, symmetric payload keys and raw
secrets held by an admitted local operation. It does not borrow the vault's
preapproval IAM or contact-quorum classification.

The mandatory contract in
[`exposure-native-provider.mjs`](../../scripts/lib/exposure-native-provider.mjs)
requires five controls: the original provider transport, the captured connection
revision, admitted secret reads, and publication checks after both provider work
and the final revision lock. HTTP completion alone is insufficient: local
authenticated decryption can continue after the last response. The same fence
applies to direct key-flow callers and the registered API driver when no optional
abort signal is supplied.

Provider status proofs retain the same refusal, redirect, deadline and owner
checks as JSON responses. A documented status cannot accept authorization
refusal or a rate limit, and its contract cannot also require body predicates.
Publication follows unread-body cleanup while the original deadline remains
live. The verification schema and its regressions are mandatory source bindings.

Regressions use actual Bitwarden ciphertext and WebCrypto, hold item decryption
or the final real Web Lock, withdraw the transport, and require refusal. A live
operation must still return the actual decrypted value. Generic API and
configured OAuth regressions also hold revision reads, physical metadata close
and public result mapping. The registered API dispatch checks its captured
transport after completion even when no caller signal is provided, covering
custom resource helpers at the shared public boundary. Other bound tests cover
provider families, connection revisions, private record admission and browser
transport ownership. Discovery includes new named native key, Bitwarden,
Tailscale, API resource, OAuth owner and bridge helpers; only the mandatory
native row may classify them.

This fence controls local result publication. It cannot revoke plaintext or
credentials already copied by an authorized recipient, cancel a remote effect
already accepted, or establish global expiry. Provider authentication and remote
revocation remain separate authorities. Declared credential fields also remain
provider-owned: Tailscale's registered client-credential mode admits its masked
secret, while arbitrary labels, plaintext secret fields and editable fixed
token endpoints remain refused by the form contract.

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
Local custody controls additionally need negative cases for unknown custody
IDs, each missing control, boundary removal/relabeling, overstated lifecycle
guarantees, binding theft, exact source drift and newly added named helpers.

Snapshot tests must distinguish the index from the working tree: vulnerable
staged source with a fixed working copy fails staged validation; fixed staged
source with a vulnerable working copy is assessed as the staged snapshot.
Missing matrix/source files, unresolved stages, unsafe file modes, symlinks,
malformed policy input and checker failures must produce a failing result.

Behavioral regressions remain separate from these checker tests. Both are
needed: one establishes the runtime boundary; the other establishes that
repository policy notices when its reviewed assumptions change.
