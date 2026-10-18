# ADR 0207: Retired credentials and controlled canaries are owner ceremonies

Status: Accepted

## Context

Retired passwords can disclose that an old credential was used, refuse access,
or select an independent synthetic vault. Controlled agent canaries export a
purpose-built detection artifact. Either defense could be disarmed or misused
by an agent allowed to change its enrollment. Both management flows may require
primary secrets, configured factors and sealed local signing material.

## Decision

The local vault owns every inspection and mutation. A fresh current primary and
all configured factor requirements precede the accepted operation. The private
Store's generation, root and physical credential/body leases bind completion.
An Identity login, DTO, copied receipt or successful KDF alone grants no REAL or
management capability. Synthetic sessions cannot acquire those capabilities.

The PWA exposes both management ceremonies under Settings → Security. The Node
client exposes `vault retired` and `vault canary` using terminal owner prompts.
The latter pairs an explicitly selected receiver, then inspects, enrolls,
removes or exports detection-only artifacts. Enrollment requires explicit
consent; neither command accepts a primary secret on the command line.

MCP Host, MCP Client and WebMCP deliberately exclude **management** of these
features. Tools must never accept the owner's primary/factor secrets, choose
retired passwords, create traps, change receiver signing custody, remove
observations or export artifact bearers. The canary artifact's separate MCP
endpoint implements only protocol initialization, tool discovery and a
synthetic status response; it records detection and delegates no production
operation or credential. This is not an exception permitting management from
an agent surface.

`security canary serve` is a local Node service using an owner-exported public
pairing file and private authenticated filesystem state. Browsers do not bind
this listener. Explicit endpoint, service ID, origin, public key, expiry and
one-use command challenge bind receiver operations. Remote HTTPS requires an
explicit TLS proxy; no default endpoint or remote account is inferred.

The browser extension's existing runner has its own credential store. Its
Security navigation opens the actual PWA origin; it does not copy a PWA root,
turn retired-password checks into a privileged background message, or enroll a
receiver through an agent bridge. Registry exclusions cover direct management
in the runner rather than silently recording an unimplemented parity surface.

## Native product scope

`apps/android/README.md` defines the Android/iOS application as an OpenID4VC
holder/authenticator and expressly excludes password, OTP and passkey provider
behavior. Its Kotlin/Swift wallet and native identity flows do not open the PWA
password vault. A phone running the PWA uses the same local owner ceremonies as
a desktop browser; a mobile browser screenshot is not native-wallet evidence.
No parallel password-vault product is invented for those authenticators.

`packages/sdk-cli/src/index.ts` exports Identity device-flow, loopback-login and
control-plane clients. It is not the Node vault application or a source of
local primary/factor/REAL authority. Local vault cryptographic state remains
inside app-core's actual owning runtime; the SDK receives no management API
that accepts an identity token as substitute authority.

## Client vault versus the Rust sealed store

This ADR's implemented portable management contract targets the Pages/Node
client vault. `context-v2.ts` admits only `pages-auth-header-v1`;
`packages/cli/src/vault-host.ts` installs `native-vault-ports` for that client's
physical NodeData header/body projection. The packaged `opensesame` companion
supplies real filesystem custody and leases, not a replacement owner issuer.
Its presence does not activate every feature in the Rust Host command tree.

The Rust `opensesame vault pass` product is the git-native hierarchical store
specified in `crates/sealed-store/README.md`. ADR 0133 explicitly preserves two
vault formats: Pages uses PBKDF2/AES-GCM; human-vault/sealed-store uses
Argon2/XChaCha20. `crates/human-vault/README.md` separately identifies its Pages
reader. Sharing a root-protection model or a native executable does not merge
their ciphertext, factor ceremonies or mutation authority.

The existing `crates/sealed-store/src/retired_native.rs` is an authenticated,
read-only prerequisite inspection for supported native policies. Its own
contract says that its returned metadata cannot enroll a trap, decrypt an item
or clear a synthetic realm; future mutations require fresh private admission.
No `opensesame vault pass` retired/canary command is activated by this change.
That product is unsupported for this feature, not counted as a native pass or
silently claimed complete. An extension of the requirement to every human
password-store format would require a separate native owner/classifier/
synthetic and factor integration; it cannot be satisfied by relabeling the
Client companion's verification or forwarding a Pages owner receipt.

## Consequences

The capability registry maps the PWA and Node commands and cites this ADR for
all withheld surfaces. Both PWA management operations belong to the existing
always-present local-unlock capability. Its egress declaration includes only
the owner's explicitly configured detection receiver in addition to configured
second-step delivery. This introduces no automatic external request.

Receiver local-clock expiry cannot defend against host clock rollback. Private
receiver state and origin-bound owner custody must remain on supported storage;
unsupported privacy semantics fail closed. Platform and installed-client tests
remain separate from portable codec, UI-state and protocol tests.
