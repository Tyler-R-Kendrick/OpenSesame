# PWA secret backends compose local and HTTP adapters

Status: Accepted

Date: 2026-10-14

## Context

The Host catalog describes several password-manager integrations through native
tools and existing credential helpers. Those capabilities do not by themselves
provide a usable Pages configuration or browser item API. Conversely, a
provider that offers a CLI may expose a real HTTP service, export format or
browser SDK that Pages can use. BYO and partner pages need consistent forms and
actual operations without inventing a decrypted vendor API or requiring an
implicit application backend.

## Decision

Define the browser secret-store contract in
`packages/app-core/src/lib/secret-backends/types.ts`: configuration, opaque
sessions, item summaries and values, declared operations, supported fields and
an optional ciphertext-backup descriptor. Each adapter owns credential and SDK
state; public handles contain no credential material. Unsupported operations
remain explicit capability absences.

The checked-in `spec/connectors/secret-backend-presets.json` is the source for
partner choices, defaults, file formats and setup guidance. Generated presets
compose one common configuration form, item workspace and backup controls.
BYO exposes local vault, picked-file import, password Credential Management,
1Password Connect, Bitwarden Vault Management API, Bitwarden Secrets Manager,
Infisical and Passwordstate. Partner presets narrow those same methods rather
than copy their UI or persistence code. Existing Host catalog capabilities and
CLI workflows retain their separate semantics.

Local operations use the real vault port. File imports use the existing
parsers and merge planner, with explicit preview and import. Browser password
Credential Management exposes only the origin-scoped selection and writes the
browser supports; it cannot select a vendor or enumerate a password vault.

HTTP factories capture a single approved `connectors.external` activation and
use direct destination-aware egress with its declared provider purpose.
Credentials are fenced to configured origins/base paths. Redirects and browser
cookies are refused; HTTP responses and SDK transport are bounded. There is no
default relay or automatic local process. Local/file/browser-credential modes
do not need that external transport.

Secrets Manager uses the official browser WASM SDK in a dedicated worker per
connection. This preserves vendor authentication and cryptography while
isolating the published SDK's singleton/logger state. The worker's internal
fetch is an RPC to the captured application transport, pinned to the configured
API and identity services; the main realm's global fetch is never replaced.
Closing or cancelling the session terminates its owned worker.

Saved access tokens and client secrets are first-class Token credential items
inside the owning vault's sealed body. They share its content-key protection,
rotation, synchronization and encrypted backup. The device-sealed connector
ledger publishes public configuration and exact credential-item references.
New immutable item versions are staged before atomic metadata publication;
guarded cleanup removes only the unchanged original items. An interrupted
cleanup can leave a visible unreferenced credential for the owner to inspect.
Blank credentials survive edits only for an unchanged target and scope.
Guards run before and after network legs and result delivery. Lock, vault
switch, configuration replacement or capability deactivation invalidates old
sessions; late authentication handles are disconnected rather than admitted.

Vault backup is an explicit additional capability, not an inference from a
generic item-create method. It stores the existing sealed ciphertext envelope
in the adapter's declared note/secret field, enforces known field bounds, and
reads the item back before reporting success. Restore decrypts locally and
merges through the vault importer without adopting the source vault's identity.
An extension save handoff cannot provide this verified-backup contract.

## Consequences

Every connection can be configured through common fields, but browser access
still requires the operator's TLS, CORS, network policy and endpoint setup.
Vault Management API can be an existing `bw serve` service for Bitwarden or
Vaultwarden; its prerequisite is stated without treating all CLI-backed
protocols as unavailable. 1Password Connect is distinct from its Node SDK and
the official, attended save-only extension button.

Proton's documented tokens and browser-capable source do not establish a usable
cross-origin hosted session. The measured 2026-10-14 preflight rejected the
Pages origin through missing CORS headers while allowing Proton's own origin.
The current partner uses tested local JSON/ZIP import; native CLI capabilities
remain valid. New live support requires real SDK packaging, transport and
authentication evidence rather than a label change.

Adapters expose item operations and explicit snapshots, not automatic
synchronization. Destination size limits, permissions and provider retention
rules remain visible constraints. Operator setup and verification steps live in
[the secret-backend guide](../operators/secret-backends.md).

## Shipped bundle cost, measured 2026-10-14

The final clean production build (`6ad7b281d`) measures 6,979 KiB of JavaScript
and 2,109 KiB gzipped, compared with the identity baseline's 6,786/2,056 KiB:
+193 KiB raw and +53 KiB gzip. This pays for shared BYO/partner configuration
and item UI, native HTTP and capability transports, verified ciphertext backup
controls, actual vault credential custody and held-item offline definitions,
the official 1Password save button, and official Bitwarden SDK worker/glue.
Those implementations load on explicit use, while their shipped assets still
count toward offline installation. The 1,967 KiB official SDK WASM asset fits
the existing total and largest-asset budgets; total output is 10,001 KiB and
CSS remains 180 KiB.

Deliberately set only the default Pages JavaScript ceilings to 7,000/2,120 KiB
(previously 6,800/2,058), leaving 21/11 KiB over this final measurement.
Minimal-local and family-local hardened builds each retain 3,326,736 raw
JavaScript bytes, at most 1,030,779 gzip bytes and 113 files on disk. Independent
reconstruction from disk reports no ownership/reachability violations or
asset mismatches; Networking is absent from both. Their existing budgets pass
unchanged. Profile, total, largest-asset, CSS and structural limits are
unchanged. This is an explicit feature-cost decision, not a regenerated
structural baseline.
