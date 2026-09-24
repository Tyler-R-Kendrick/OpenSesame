# ADR 0138 — Self-issued identity by default, one native host, apps are packages

- Status: Proposed
- Date: 2026-09-24
- Amends: [ADR 0007](0007-dual-plane-identity-authority.md) and [ADR 0017](0017-host-client-product-topology.md)
  (the Identity API stops being a required plane), [ADR 0033](0033-federated-identity-admission.md)
  (a durable principal no longer needs an upstream broker),
  [ADR 0047](0047-daemon-connector-discovery.md) §6,
  [ADR 0048](0048-capability-moded-connector-discovery.md) §5 and
  [ADR 0053](0053-pm-bridge-binaries.md) (process isolation becomes crate
  isolation), [ADR 0049](0049-derived-short-lived-materialization.md) §4
  (helpers become entry points of one binary), [ADR 0065](0065-agent-surface-parity.md)
  (one `mcp` surface), [ADR 0092](0092-auth-md-agent-registration.md) and
  [ADR 0124](0124-agent-auth-provider-id-jag.md) (agent tokens come from the
  host)
- Builds on: [ADR 0090](0090-static-frontend-complete-without-backend.md),
  [ADR 0116](0116-browser-native-siop-v2.md), [ADR 0118](0118-device-native-identity-host.md)
- Plan: [docs/implementation/native-host](../implementation/native-host/README.md)

## Context

The repository has nineteen deployables under `apps/` and six products a
person actually uses: the PWA, the CLI, a native daemon, the browser
extension, Android, and a desktop app that does not exist yet. The gap
between the two numbers is mostly identity and process topology, not
features.

**Identity is already self-issued where it matters, and required-hosted
everywhere else.** Pages is a SIOPv2 provider (ADR 0116), answers its own
Identity API when none is configured (ADR 0118), and runs people, apps,
grants and agent keys browser-locally (ADRs 0102–0112). But ADRs 0007, 0017
and 0033 still describe an Identity API (`apps/control-plane`) as a plane
every deployment has. That leaves hard couplings: the Host accepts only a
`host-authorization+jwt` the control-plane signs, so Join a session and
agent-run browser control fail without it; a durable principal "originates
from a trusted upstream broker" (ADR 0033), so a device with no broker can
admit no durable user; the principal a device mints is a random `prn_…`,
not a key; and the CLIs, console, ceremonies, mobile-mfa, the thin PWA and
six of the seven examples point at `:8788` by default.

**The native side is several processes that nothing requires to be
several.** No ADR says the gateway and daemon must be separate processes.
ADRs 0047, 0048 and 0053 say the daemon must not *link* the credential and
database surface, and the separation followed from that. The rule no longer
holds in fact: `cargo tree -p opensesame-daemon` reaches `sqlx` (through
host-core → broker → storage) and `chacha20poly1305` (through host-core →
connector-host → sealed-store); the dependency gate checks only depth one.
Meanwhile the split costs real defects: the daemon demands the operator
token even on its Unix socket, so the credential helpers, which send none,
cannot mint; `apps/toolbar` duplicates `opensesame daemon`;
`apps/worker`'s Rust binary accepts no work; `apps/callback-edge` forwards
nothing.

**MCP is two apps where it should be one capability of every app.**
`apps/mcp-host` and `apps/mcp-client` implement `sync_push`/`sync_pull`
twice, name health twice, and differ only in an audience string. Pages
exposes 24 tools over WebMCP from a transport-neutral catalog
(`WebMcpToolSpec`) that the MCP servers do not use.

## Decision

### 1. Identity is self-issued by default, everywhere

A person's principal is the JWK thumbprint (RFC 7638) of an identity key held
in their vault, passkey-gated, synced end-to-end with the vault. Every
surface — PWA, desktop, CLI, extension, Android — signs in by proving
possession of that key (SIOPv2, as ADR 0116 already does in Pages). Relying
parties get pairwise subjects derived from it. Nothing about signing in,
unlocking, or being a durable user requires a network service.

A hosted identity service is an **optional deployment**, not a plane: an
operator runs one only for what cannot be self-issued — a public OIDC issuer
for third-party sites that cannot verify self-issued tokens, brokering
upstream IdPs that need a client secret, email/SMS/magic-link delivery,
SCIM/SAML/LDAP for enterprise tenants, and a publicly reachable relay for
cross-device approvals and provider callbacks. When one is configured it is
an override (ADR 0118 §3), and it links a hosted account *to* the
self-issued principal; it never replaces it.

A durable principal is a key, so durability is a vault property. Losing the
key is losing the identity unless the vault's recovery applies (recovery
codes, backup, duress recovery). Rotation is a signed statement from the old
key naming the new one.

### 2. One native host process

Each machine runs one OpenSesame process, `opensesame daemon run`. It serves:

- the **agent surface** on a Unix socket (named pipe on Windows): capability
  mint and exchange, credential mint for helpers, discovery — authenticated
  by peer credentials, never by a bearer the caller could leak;
- the **Host API** (today's gateway routes) on loopback, and on a configured
  listener with mTLS for a shared host (ADR 0132);
- **self-hosted identity** for this machine: SIOPv2 verification, a narrow
  local OpenID provider for local apps and agents (§3), and passkey
  verification for host authorization;
- the **MCP** endpoint (§5) and, for the desktop app, the Pages build on a
  loopback origin.

`apps/gateway` and `apps/daemon` become library crates this process links;
the gateway binary remains as `opensesame daemon run --shared` for a team
host.

ADR 0048's threat model — the agent-facing surface must not become a
credential oracle — is kept by **crate isolation instead of process
isolation**. The agent surface is its own crate that can call only a narrow
internal port (mint, exchange, discover) and cannot name storage, the
sealed store, OAuth or the database. The dependency gate checks that crate's
full tree, not the process's depth one.

### 3. The local OpenID provider is deliberately narrow

For local apps, CLIs and agents that speak OIDC rather than SIOP, the host
is an OpenID provider on its loopback issuer with one profile:
authorization code with PKCE S256, loopback or custom-scheme redirects
only, ES256, discovery and JWKS, no refresh tokens, no dynamic
registration, no implicit or hybrid flows. `sub` is pairwise per client,
derived from the person's self-issued thumbprint; the consent screen is
Pages on the loopback origin. Anything broader belongs to the optional
hosted service. There is no mature Rust OpenID provider comparable to
oidc-provider (ADR 0008), so the profile is kept small enough to own, and it
is tested against the OpenID conformance suite's basic profile and the
existing TypeScript `oauth-provider` suites as an oracle.

### 4. Host authorization accepts self-issued proof

The host verifies a SIOP ID token or a WebAuthn assertion from the person's
vault passkey directly, and mints its own short-lived host authorization.
A control-plane-signed `host-authorization+jwt` remains accepted only from a
configured hosted issuer.

### 5. MCP is a capability of every app, not an app

Each tool is declared once, in `packages/capability-registry`, as an
operation: its name, JSON Schema input, disposition, and the Host API call it
makes. Two thin adapters execute that catalog:

- `@opensesame/mcp` (TypeScript), used by Pages (WebMCP), the extension,
  Android's embedded core and the desktop webview;
- the host's MCP module (Rust, the official `rmcp` SDK), served by
  `opensesame mcp serve` (stdio) and by the daemon (Streamable HTTP on its
  socket).

The agent audience collapses to one value, `urn:opensesame:agent:mcp`. ADR
0065's parity check has one `mcp` surface where it had `mcp_host` and
`mcp_client`.

### 6. `apps/` holds products; everything else is a package or an entry point

| Stays an executable | Why the process boundary is real |
|---|---|
| `pages` | The PWA. |
| `desktop` (new) | A Tauri shell: Pages on the host's loopback origin, a tray for approvals, installs and supervises the daemon as a login item. |
| `android` (was `authenticator-native`) | The mobile app; later embeds app-core through the sandbox host. |
| `browser-extension` | Runs in the browser's process; rebuilt on app-core. |
| `cli` | The `opensesame` binary: every CLI verb, `daemon run`, `mcp serve`, and argv[0] entry points for `docker-credential-opensesame`, `git-credential-opensesame` and the password-manager native-messaging hosts. |
| `connect-backend` | Serverless functions for OAuth and GitHub App callbacks a static page cannot receive. |

Everything else becomes a library or disappears:

| Today | Becomes |
|---|---|
| `gateway`, `daemon` | Library crates linked by `opensesame daemon run`. |
| `toolbar` | CLI verbs now, the desktop tray later. |
| `credential-helpers`, `pm-bridges` | Crates plus argv[0] entry points of `opensesame` (each still runs in its own short-lived process when git, Docker or a browser spawns it). |
| `worker` (Rust) | Removed; it accepts no work. |
| `callback-edge` | Removed until a hosted relay needs it; its signature and replay code moves to a crate. |
| `mcp-host`, `mcp-client` | `@opensesame/mcp` and the host's MCP module (§5). |
| `pwa` | Removed; Pages superseded it and nothing depends on it. |
| `console` | Its screens move into Pages (device approval and sign-in exist already; task access and organization settings become Access and Identity sections). |
| `control-plane`, `worker` (TS), `ceremonies`, `mobile-mfa` | Packages assembled into the optional hosted identity deployment (§1) under `ops/`, on its own origin as ADR 0045 requires. |
| `packages/cli` (`opensesame-id`) | Its vault verbs move into `opensesame` over the Rust vault reader, checked against vault-core's golden vectors. |

## Consequences

- A fresh machine with only `opensesame` installed can sign a person in,
  hold durable identity, authorize agents, run Join, serve MCP, and act as an
  OIDC provider for local apps — with no Identity API, no Postgres, and one
  process.
- The dependency budget becomes enforceable again, at the crate that faces
  agents, instead of nominal at a process that already links everything.
- ADR 0017 decision 5 ("TypeScript owns MCP servers") no longer holds: the
  catalog is language-neutral and each runtime has an adapter.
- The hosted identity code is not deleted. It stops being a prerequisite and
  becomes an operator's choice, shipped as packages and a deployment recipe.
- New work the project owns: a narrow Rust OpenID provider, WebAuthn
  verification in the host (webauthn-rs), SIOP verification in Rust, the
  Tauri desktop shell, and the Rust MCP adapter.
- Key loss is identity loss. Vault recovery, backup and key-rotation
  statements carry the weight a hosted account used to.

## Open questions

1. One binary for CLI and daemon (one install, larger CLI) or two
   (`opensesame` and `opensesamed`)? The plan assumes one.
2. Windows: named pipe with peer SID checks for the agent surface (ADR 0048
   §8 had no Windows socket mode).
3. Does the local OpenID provider sign ID tokens with a host key, the
   person's self-issued key, or both (host-signed, with the self-issued
   thumbprint as `sub` basis)? The plan assumes a host key, so a local app
   need not understand SIOP.
