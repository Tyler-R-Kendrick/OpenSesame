# Native host and self-issued identity — implementation plan

The work behind [ADR 0138](../../adr/0138-self-issued-identity-one-native-host.md):
identity self-issued by default on every surface, one native process per
machine that hosts it, MCP as a capability of every app, and `apps/` reduced
to the products a person installs.

Every phase leaves `main` shippable, with the existing gates green, and
removes something. Nothing is deleted before its replacement has passed
the same tests the original did.

## Where things stand

| Area | Today | Source of the fact |
|---|---|---|
| Self-issued sign-in | Pages is a SIOPv2 provider for registered local apps (ES256, thumbprint subject, pairwise keys, passkey-gated consent). Pages' own sign-in is not SIOP. | `packages/siop-v2`, `apps/pages/src/screens/SiopAuthorize.tsx`, ADR 0116 |
| Principal | The in-tab principal is a random `prn_…`, not key-derived. Promotion to durable needs a broker. | `packages/app-core/src/lib/device-identity-host.ts` (`mintProvisional`), ADR 0033 |
| Identity without a service | Pages answers its own Identity API when none is set: principals, projects, orgs, agents, OAuth clients, audit. Writes, the approval inbox and MFA codes are unavailable. | `device-identity-local.ts`, ADR 0118 |
| Host authorization | The gateway accepts only the control-plane's RS256 `host-authorization+jwt`, so Join's verify and agent-run control need the Identity API. | `crates/gateway/src/host_authorization.rs`, `packages/app-core/src/lib/join/client.ts` |
| Gateway issuer | Defaults to `https://keycloak.local/realms/opensesame`. | `crates/gateway/src/config.rs` |
| Daemon | Loopback `:18790` and optional Unix socket, served by `opensesame daemon run`. The `sessions` map is never filled, so `mint_capability` always answers `no_session`. `lib.rs` is 1,581 lines. | `crates/daemon/src/lib.rs` |
| Helper minting | The daemon requires the operator token even on the socket; the helpers send none, so `/v1/mint` answers 401. | `crates/daemon/src/lib.rs` (`require_operator`), `crates/credential-helpers/src/lib.rs` |
| Dependency budget | The gate checks depth one; the full tree reaches `sqlx` and `chacha20poly1305` through `host-core`. | `scripts/audit/daemon-deps-gate.sh`, `cargo tree -p opensesame-daemon` |
| Rust identity primitives | DPoP, JWK thumbprints, PKCE, device flow, discovery parsing, X.509. No OIDC provider, no ID-token minting, no SIOP, no WebAuthn relying party. | `crates/proof`, `crates/authn`, `crates/pki-core` |
| MCP | Two stdio servers with duplicated sync tools and two audiences; 13 of 189 capabilities reach MCP. Pages has 24 WebMCP tools on a transport-neutral spec the servers do not use. | `apps/mcp-{host,client}`, `packages/webmcp/src/registrar.ts`, `packages/app-core/src/webmcp/` |
| Desktop | None. The toolbar is `opensesame daemon info / approve-device / approve-claim`. | `apps/cli/src/daemon_toolbar.rs` |

## Target

```
apps/
  pages/              the PWA (unchanged role)
  desktop/            Tauri shell: Pages on the host's loopback origin, tray, daemon supervisor
  android/            renamed from authenticator-native
  browser-extension/  rebuilt on app-core
  cli/                `opensesame`: verbs, `daemon run`, `mcp serve`, argv[0] entry points
  connect-backend/    serverless callback relay (unchanged)
crates/
  host-api/           was crates/gateway (routes, actors) as a library
  host-agent/         the agent surface: mint, exchange, discover; gate checks its full tree
  host-identity/      SIOP verify, WebAuthn verify, the narrow local OpenID provider
  host-mcp/           the MCP adapter over the registry catalog (rmcp)
  credential-helpers/ pm-bridges/   libraries behind argv[0] entry points
packages/
  mcp/                the TypeScript MCP adapter over the same catalog
  hosted-identity/*   what apps/control-plane, ceremonies, mobile-mfa and the TS worker become
ops/
  hosted-identity/    the optional hosted deployment recipe (own origin, ADR 0045)
```

## Phases

Phases 1, 5 and 8 can run in parallel with the others once phase 0 lands.
Phase 3 depends on 2. Phase 4 depends on 1 and 3. Phases 6 and 7 depend on 4.

### Phase 0 — Decide, and fix what is broken today

- Accept ADR 0138; amend ADRs 0007, 0017, 0033, 0047 §6, 0048 §5, 0049 §4,
  0053, 0065, 0092 and 0124 by reference; update `AGENTS.md` §1 and §4.
- Fix helper minting: a same-user socket peer is the helper's authority on
  `/v1/mint`, as `peer_auth.rs`, `mint.rs` and the helper docs already
  claim. Add an integration test that runs `git-credential-opensesame get`
  against a real daemon.
- Make `daemon-deps-gate.sh` check the full tree and record today's
  violations as a ledger that may only shrink, so phase 3 can be measured.

**Exit:** `cargo test -p opensesame-daemon -p opensesame-credential-helpers`,
`pnpm audit:daemon-deps` (new ledger), the new helper integration test.

### Phase 1 — The principal is a key

- The vault gains one identity key (P-256, non-extractable in the browser,
  wrapped by the vault key) and a `principal = jwk_thumbprint(identity_key)`
  derivation in `packages/vault-core`, with golden vectors shared with a new
  Rust reader in `crates/human-vault`.
- `device-identity-host.ts` mints `prn_<thumbprint>` instead of a random
  ID. Existing random principals are kept and linked by a signed statement
  from the new key.
- Pages' own sign-in becomes a SIOP self-authentication. The Shoo road stays
  as an optional link that attaches a Google account to the principal
  (ADR 0078); the guest road is unchanged (ADR 0135).
- Promotion to durable no longer calls a broker: it is enrolling a primary
  unlock method on the vault that holds the key (amends ADR 0033).
- Key rotation: a `principal.rotate` statement signed by the old key,
  verified in both languages.

**Exit:** `pnpm --filter @opensesame/pages verify:auth`, `verify:local-iam`,
`verify:static`, `verify:keyboard`; vault-core golden vectors pass in Rust
and TypeScript; the guest tests (`SignInPanel.test.tsx`,
`UnlockScreen.test.tsx`, `store.test.ts`) unchanged and green.

### Phase 2 — The host trusts self-issued proof

- New crate `host-identity`: SIOP ID-token verification (ES256 over
  `p256`, thumbprint subject), WebAuthn assertion verification
  (`webauthn-rs`), and host-authorization minting with a host key.
- `host_authorization.rs` accepts a SIOP ID token or a passkey assertion
  from the person's vault and mints its own short-lived authorization. A
  hosted issuer's JWT is accepted only when one is configured.
- `OPENSESAME_ISSUER` stops defaulting to Keycloak; an unset issuer means
  self-issued only.
- Join's verify step (`join/client.ts`) and agent-run control stop
  answering `verify_needs_identity` when no Identity API is configured.

**Exit:** `cargo test -p opensesame-gateway` with new cases (self-issued
accepted, wrong audience, replayed assertion, rotated key);
`pnpm --filter @opensesame/pages verify:auth`; a Join journey against a
local gateway with no Identity API; a security audit note under
`docs/security/audits/`.

### Phase 3 — One native process

- Move `crates/gateway/src` into `crates/host-api` and `crates/daemon/src`'s
  agent routes into `crates/host-agent`. `host-agent` depends only on a
  `HostPort` trait (mint, exchange, discover, invoke-through), never on
  storage, the sealed store or OAuth; `daemon-deps-gate.sh` checks its full
  tree against ADR 0048's list and the ledger from phase 0 reaches zero.
- `opensesame daemon run` starts one process: the agent socket
  (`host-agent`), the loopback Host API (`host-api`), the background actors
  (lifecycle scanner, security dispatch, breach scanner; sync and backup
  when configured). `--shared` adds the mTLS listener (ADR 0132).
- `opensesame daemon install` writes a systemd user unit or launchd agent;
  Windows uses a named pipe with a peer-SID check.
- ~~Fold into `opensesame`: the toolbar's four commands, the credential
  helpers and the password-manager bridges as argv[0] entry points~~ — done.
  `opensesame` is the only native executable: `host run` (the Host API,
  `crates/gateway`), `daemon run` (`crates/daemon`), `worker run`
  (`crates/worker`), `daemon info | approve-device | approve-claim` (the
  toolbar), and `apps/cli/src/entry.rs` answers as each helper and bridge
  under its link name (`opensesame helpers link`). The callback edge is Host
  API routes (`crates/gateway/src/callback_ingress`). `apps/toolbar` and
  `apps/callback-edge` are gone; `crates/*` hold libraries only.
- Still open: one process per machine (`daemon run` also serving the Host
  API), the `host-agent` split and its full-tree dependency check.

**Exit:** `cargo +1.88.0 test --workspace --all-targets`; `pnpm test:live-stack`,
`test:nats-dogfood`, `test:task-access`, `test:mtls`, `test:mtls:integration`
against `opensesame daemon run`; `pnpm audit:daemon-deps` at zero; the
browserpass and KeePassXC bridge tests through the argv[0] entry points.

### Phase 4 — The host is a local OpenID provider

- In `host-identity`: discovery, JWKS, authorization endpoint (consent
  rendered by Pages on the loopback origin), token endpoint. One profile:
  code + PKCE S256, loopback or custom-scheme redirects, ES256, no refresh,
  no dynamic registration. `sub` is pairwise per client, derived from the
  person's thumbprint.
- Agent tokens (ADR 0092 auth.md AgentAuth, ADR 0124 ID-JAG) move from the
  control-plane to the host for local agents.
- Retarget the examples: `rp-alpha`, `rp-beta`, `static-rp`,
  `static-agent`, `agent` and `headless` default to the local host, or to
  SIOP where they already can; the hosted issuer remains a documented
  option.

**Exit:** the OpenID conformance suite's basic OP profile against
`opensesame daemon run`; the relevant `packages/oauth-provider` test cases
ported as a Rust oracle; every example's tests green against the local
host.

### Phase 5 — MCP in every app

- Extend each `packages/capability-registry` entry that reaches an agent
  with an operation: tool name, JSON Schema input, disposition, and the
  Host API call. Generate the catalog into `capabilities.json` as today.
- `packages/mcp`: the TypeScript adapter over the catalog (low-level
  `Server`, tools/list and tools/call), used by Pages' WebMCP registration,
  the extension, Android's embedded core and the desktop webview. The 24
  existing WebMCP tools move onto it.
- `crates/host-mcp`: the Rust adapter (`rmcp`), served by
  `opensesame mcp serve` (stdio) and by the daemon (Streamable HTTP on the
  agent socket).
- One audience, `urn:opensesame:agent:mcp`: gateway `AUDIENCES`,
  `agent-client`, the CLI's `--audience` parser, the OpenAPI spec and the
  storage tests change together.
- Registry: one `mcp` surface replaces `mcp_host` and `mcp_client`; parity
  tests, `tests/redteam` (which spawns `apps/mcp-host` by path) and
  `apps/cli/tests/capability_parity.rs` follow. Delete `apps/mcp-host` and
  `apps/mcp-client`.

**Exit:** the registry parity suites; `pnpm test:redteam` against
`opensesame mcp serve`; `pnpm --filter @opensesame/pages verify:webmcp`.

### Phase 6 — The web apps collapse into Pages

- ~~Delete `apps/pwa`~~ — done: its registry entries now map to Pages or are
  excluded under ADR 0128, and its build, budget and lint wiring is gone.
- Move the console's task-access page into Access and its organization
  settings into Identity; sign-in and device approval already exist in
  Pages. Delete `apps/console`.
- `packages/cli` (`opensesame-id`): move `vault verify` / `vault ls` into
  `opensesame` over the Rust vault reader from phase 1, checked against the
  golden vectors; delete the TypeScript CLI.

**Exit:** `pnpm quality:bundle`, `verify:keyboard`, `verify:mobile`,
before/after evidence for the moved screens (`skills/visual-evidence`).

### Phase 7 — The hosted identity service becomes optional packaging

- Split `apps/control-plane` along the gap table below: what is self-issued
  or host-side is already covered by phases 1–4; what is hosted-only becomes
  packages under `packages/hosted-identity/`.
- `apps/ceremonies` and `apps/mobile-mfa` merge into one hosted ceremony
  build (ADR 0045 keeps it off the Pages origin); the TypeScript worker's
  outbox loop runs inside the hosted deployment.
- `ops/hosted-identity/`: the deployment recipe (container and database),
  documented as optional in `docs/operators/`.
- Delete `apps/control-plane`, `apps/worker`, `apps/ceremonies`,
  `apps/mobile-mfa`; `pnpm dev` no longer starts an Identity API.

**Exit:** the control-plane's test suite runs green against the hosted
deployment; `pnpm --filter @opensesame/pages verify:static` still shows no
"No Identity API" copy anywhere; the Settings override (ADR 0118 §3)
tested against the hosted deployment.

### Phase 8 — The shells

- `apps/desktop`: Tauri. Loads Pages from the host's loopback origin, shows
  approvals in a tray (replacing the toolbar), installs and supervises
  `opensesame daemon run` as a login item, hosts WebMCP through
  `packages/mcp`.
- `apps/browser-extension`: rebuilt on app-core's browser host and
  vault-core; autofill and WebMCP through `packages/mcp`.
- `apps/android`: rename, then embed an app-core bundle through the sandbox
  host (`packages/app-core/src/sandbox`), which requires amending ADRs 0058
  and 0133 §8.

**Exit:** each shell's own tests plus `verify:keyboard` and `verify:mobile`
where the shell renders Pages.

## Control-plane capabilities and where each one goes

| Capability | Goes to | Phase |
|---|---|---|
| Guest and provisional principals | Client, key-derived | 1 |
| Principal mapping for the Host | Host (`host-identity`) | 2 |
| Host-authorization minting | Host | 2 |
| Server passkeys and TOTP (`/v1/mfa`) | Client: vault passkeys and local second steps already exist (ADR 0103) | 1 |
| Projects, agents list, OAuth client list, audit, support | Client: already served in the tab (ADR 0118) | — |
| Claims (ownership transfer) | Host (`crates/claims` already exists); drop claims are already local | 3 |
| Device approval proxy | Removed: the Host already serves `/api/v1/device/*` | 3 |
| Agent registration and tokens (auth.md, ID-JAG) | Host, for local agents | 4 |
| OIDC issuer for local apps | Host, narrow profile | 4 |
| OIDC issuer for third-party websites, origin-profile clients | Optional hosted service | 7 |
| Upstream brokering needing a client secret, BYO, back-channel logout | Optional hosted service | 7 |
| Magic link, email and SMS codes | Optional hosted service | 7 |
| Organizations, SCIM, SAML, LDAP | Optional hosted service; the local org directory (ADR 0105) covers households | 7 |
| Approval inbox, cross-device interactions, notification channels, webhooks | Optional hosted service (needs a public relay) | 7 |
| SIOP link bridge (ADR 0117) | Optional hosted service | 7 |
| Wallet, OpenID4VP verifier, OpenID4VCI issuer | Optional hosted service (mostly flag-gated today) | 7 |
| Authentication-as-a-service for RP backends | Optional hosted service, or dropped if unused | 7 |

## Risks

- **A Rust OpenID provider we own.** There is no Rust equivalent of
  oidc-provider. The mitigation is the narrow profile, the conformance
  suite and the TypeScript suites as an oracle; anything outside the
  profile goes to the hosted service rather than being added.
- **Crate isolation is weaker than process isolation.** A bug in the Host
  API can reach memory the agent surface shares. The mitigation is that
  `host-agent` cannot name the credential surface, the deps gate checks its
  whole tree, and the Codex Security review (`AGENTS.md` §6) scopes
  `crates/host-agent` and `crates/host-identity` before phase 3 merges.
- **Key loss is identity loss.** Phase 1 does not merge until recovery
  codes, backup restore and `principal.rotate` are covered by the
  `verify:auth` journey.
- **Two languages, one catalog.** The MCP catalog must be data, not code;
  anything a tool needs that is not a Host API call stays out of the
  catalog.
