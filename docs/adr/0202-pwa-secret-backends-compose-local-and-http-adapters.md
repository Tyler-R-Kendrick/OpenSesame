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

Saved metadata and write-only credentials share the atomic device-sealed
connector ledger. Records bind to a real owning vault; credentials are opened
only while that vault is current and unlocked. This is a runtime ownership
boundary, not a claim that the ledger is encrypted with the vault's content
key. Blank credentials survive edits only for an unchanged target and scope.
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
