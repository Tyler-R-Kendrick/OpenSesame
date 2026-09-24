# packages/

TypeScript libraries, each published inside the workspace as
`@opensesame/<directory>`. Applications in [`apps/`](../apps/README.md) and
[`examples/`](../examples/README.md) depend on them with `workspace:*`.

```bash
pnpm --filter @opensesame/app-core test         # one package
pnpm --filter @opensesame/app-core typecheck
pnpm quality:packages                           # cycles, phantom deps, coupling
```

Every package extends [`tsconfig.base.json`](../tsconfig.base.json) (strict,
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) and tests with Vitest.
`pnpm quality:packages` scores each one against Robert C. Martin's component
principles and fails on a dependency cycle or an undeclared workspace import.

## Domain and contracts

The bottom of the dependency graph. Nothing here imports a framework.

| Package | Purpose |
|---|---|
| [`os-domain`](os-domain) | The canonical domain model: principals, grants, access domains, notifications, transport contracts. Must not import Better Auth, oidc-provider, Hono, Drizzle or React. |
| [`contracts`](contracts) | Zod request/response schemas shared across planes: the Identity API and its clients, and Host API shapes (connections, sync targets, TaskBus, transport security). |
| [`capability-registry`](capability-registry) | Every product capability mapped onto CLI, PWA, MCP and WebMCP — or excluded by ADR ([ADR 0065](../docs/adr/0065-agent-surface-parity.md)). |
| [`capability-composition`](capability-composition) | Pure capability composition: policy documents, the resolver, consent deltas ([ADR 0130](../docs/adr/0130-operator-controlled-capability-composition.md)). |

## Client application core

Everything a client does that is not UI, shared by the Pages PWA, the CLIs
and Android ([ADR 0133](../docs/adr/0133-shared-app-core.md)).

| Package | Purpose |
|---|---|
| [`app-core`](app-core) | The client core: vault store, identity and federation, browser-local IAM, connectors, duress, SOPS, WebMCP tools, screen view-models. Plugs into a shell through one host (`configureHost`). |
| [`vault-core`](vault-core) | The vault format kernel: header, KDF, seals, unlock records, item model, TOTP, backups, golden vectors. No host, no storage, no platform. |
| [`vault-item-types`](vault-item-types) | Item-type parser and registry; embeds [`marketplace/item-types/builtin`](../marketplace/item-types/builtin) ([ADR 0087](../docs/adr/0087-vault-item-type-plugins.md)). |
| [`client-core`](client-core) | TypeScript façade over the Rust `client-core` sync shapes. |
| [`api-client`](api-client) | Typed client for the Host API. |
| [`webmcp`](webmcp) | WebMCP (`document.modelContext`) detection and a fenced tool registrar for the PWAs. |
| [`qr`](qr) | QR encoding to SVG and terminal. |
| [`mcp-host`](mcp-host) | MCP server over the Host API and daemon: task, intent, sync and health tools under a short-lived agent capability; operator headers are refused. Served by `opensesame-id mcp host` (stdio, or HTTP with `OPENSESAME_MCP_TRANSPORT=http`). |
| [`mcp-client`](mcp-client) | Agent MCP server over a narrowly scoped, short-lived Host capability. Served by `opensesame-id mcp client`. |

## Identity plane

Building blocks of the Identity API in [`apps/control-plane`](../apps/control-plane).

| Package | Purpose |
|---|---|
| [`oauth-provider`](oauth-provider) | OIDC provider configuration on oidc-provider: clients, consent, grants, replay cache. |
| [`auth-upstream`](auth-upstream) | Upstream authentication: Better Auth adapter, OIDC registry, passkey challenges, email-link policy. |
| [`database`](database) | Drizzle schema, repositories and migrations for the Identity database. |
| [`claims`](claims) | Claim sessions: ownership and delegation transfer (not device authorization). |
| [`device-auth`](device-auth) | RFC 8628 device-authorization projection for policy, UI and audit. |
| [`policy`](policy) | Authorization policy: agent scopes, approval mechanisms, authority tuples. |
| [`trust-broker`](trust-broker) | Assurance evaluation for approvals. |
| [`audit`](audit) | Hash-chained audit trail, changelog and redaction. |
| [`observability`](observability) | Structured logging with deep redaction. |
| [`telemetry`](telemetry) | Product analytics with an allowlist of events; anything not listed is dropped. |
| [`notification-adapters`](notification-adapters) | Slack, Teams, Telegram, WeChat, SMS, Web Push and webhook channels — provenance, rendering, delivery ([ADR 0084](../docs/adr/0084-external-authorization-notifications.md)). |
| [`webhooks`](webhooks) | Standard Webhooks signing and verification. |

## SDKs and protocols

What a third party integrates with.

| Package | Purpose |
|---|---|
| [`sdk-browser`](sdk-browser) | Browser SDK: "Sign in with OpenSesame", callbacks, claim requests. |
| [`sdk-server`](sdk-server) | Resource-server SDK: ID-token verification, introspection, Hono middleware. |
| [`sdk-cli`](sdk-cli) | CLI SDK: device flow, loopback PKCE, Identity API client. |
| [`static-auth`](static-auth) | Sign-in for static sites with no backend: hosted and browser-local profiles. |
| [`agent-protocols`](agent-protocols) | Agent-facing protocol adapters: `auth.md`, agent cards, ID-JAG assertions. |
| [`agent-client`](agent-client) | Agent-side client for grants, including the daemon's Unix socket. |
| [`ceremony-kit`](ceremony-kit) | Ceremony logic shared by every surface that runs one ([ADR 0086](../docs/adr/0086-wallet-native-interaction-layer.md)). |
| [`openid4vp`](openid4vp) | OpenID4VP verifier: request construction and digest-bound presentation checks. |
| [`openid4vci`](openid4vci) | OpenID4VCI issuer for the minimal OpenSesame credential. |
| [`siop-v2`](siop-v2) | Self-Issued OpenID Provider v2 utilities — read its support matrix first. |
| [`ingress-evidence`](ingress-evidence) | RFC 9440 `Client-Cert` parsing, browser-safe, with Node origin re-validation. |
| [`env-spec-bridge`](env-spec-bridge) | Parses `.env.schema` with `@env-spec/parser` and emits JSON for the Rust `env-spec` crate. |
| [`cli`](cli) | The client CLI, `opensesame-id`: device login, `vault verify` / `vault ls` over exports. |

## Wallet and payments

Payment *authorization* only — no package here stores card data
([ADR 0123](../docs/adr/0123-wallet-spending-authority.md)).

| Package | Purpose |
|---|---|
| [`wallet`](wallet) | Wallet passes for cross-device interactions; Google Wallet adapter. |
| [`wallet-consent`](wallet-consent) | Consent intents: digest, wrap, verify, redact. |
| [`wallet-policy`](wallet-policy) | Spending-constraint vocabulary and enforcement assessment. |
| [`wallet-budget`](wallet-budget) | Budget journal: atomic reserve, commit, release; idempotent attempts. |
| [`wallet-mandates`](wallet-mandates) | AP2/UCP mandate codecs. |
| [`wallet-evm`](wallet-evm) | EVM payment-adapter boundary (fail-closed). |
| [`wallet-x402`](wallet-x402) | Bounded x402 exact-payment profile. |

## In-product support

| Package | Purpose |
|---|---|
| [`guide-lang`](guide-lang) | GuideLang — the tutorial language a support model may write. It cannot express a click, selector or URL ([ADR 0088](../docs/adr/0088-ai-native-contextual-support.md)). |
| [`guide-runtime`](guide-runtime) | Deterministic GuideLang execution over ports; no DOM, no timers. |
| [`support-agent`](support-agent) | Provider-neutral support port, page context and egress boundary. |

## Test support

| Package | Purpose |
|---|---|
| [`testing`](testing) | Shared test utilities: sentinel values, PACT helpers, the `test:security` suite. |

Whole test suites that span packages live in [`tests/`](../tests/README.md).

## Adding a package

Create `packages/<name>/` with a `package.json` named `@opensesame/<name>`
(private, `"type": "module"`, a `description`, and `typecheck` + `test`
scripts), a `tsconfig.json` extending `../../tsconfig.base.json`, and list it
in the right table above. Depend on other packages with `workspace:*`.
