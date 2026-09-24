# spec/

Language-neutral contracts. Nothing here is code in either plane; both planes
compile against it, test against it, or both. Changing a file here is changing
an interface — expect tests on both sides to tell you who depends on it.

Anything more than one target needs is defined here once, and every target
reads it rather than keeping a copy ([ADR 0139](../docs/adr/0139-one-definition-every-target.md)).

| Path | Contract | Consumed by |
|---|---|---|
| [`wit/`](wit) | WebAssembly component (WIT) worlds: `core` (shared IR), `host` (host capabilities), `client` (vault and sync), `connector` (connector guests — no `secrets.get`), `task`, `proof`, `mediation`. | `crates/core`, `crates/host-core`, `crates/client-core`, `crates/connector-host`, `crates/connector-sdk`, `crates/sandbox` |
| [`openapi/host-api.yaml`](openapi/host-api.yaml) | OpenAPI description of the Host API. The gateway's contract test checks its routes against it. (The Identity API's is generated: `packages/control-plane/openapi.json`.) | `crates/gateway` route contract test, control-plane host-client test |
| [`openfga/`](openfga) | The OpenFGA authorization model (`model.fga`) and the baseline tuples (`baseline.fga`). | `crates/authz`, `packages/policy` additivity tests, the authority-fabric gate |
| [`connectors/catalog.json`](connectors/catalog.json) | **The integration catalog** — every integration any target lists, with its auth, scopes, egress, operations, fields and aliases ([ADR 0139](../docs/adr/0139-one-definition-every-target.md)). | `crates/connection-broker` (loader), drift tests in `crates/connector-host`, `crates/connection-detect`, `crates/daemon`, `packages/app-core` |
| [`connectors/catalog.view.json`](connectors/catalog.view.json) | The Host API's provider view of every catalog row, written by `cargo test -p opensesame-connection-broker --test catalog_view` (`UPDATE_CATALOG_VIEW=1` regenerates). | `packages/app-core` (`connector-catalog.generated.ts`, `pnpm --filter @opensesame/app-core generate:catalog`) |
| [`connectors/fnox-parity.json`](connectors/fnox-parity.json) | The provider parity table shared by the Host connector host and the client connector directory. | `crates/connector-host`, `packages/app-core` |
| [`connectors/mock/`](connectors/mock) | A reference connector manifest, used to test manifest parsing. | `crates/connector-host` |
| [`config/endpoints.json`](config/endpoints.json) | **The services a target talks to** — Host API, Identity API, host agent: one variable each (`OPENSESAME_<ID>_API`), the older names as aliases, the default address and listen address, the Pages runtime/build keys and setting. Every target resolves flag → variable → aliases → default. | `crates/host-core` (`endpoints`: the CLI, daemon and gateway flags), `packages/os-domain` (`endpoints.generated.ts`: MCP servers, client CLI, Identity API, Pages, the extension, the API client), `apps/pages/scripts/write-runtime-config.mjs`; `os-domain`'s test fails on any alias read outside these modules |
| [`config/ceremony-routes.json`](config/ceremony-routes.json) | **The ceremony routes a link can open** on the app origin — `/i/{ref}`, `/claim` (`#token=`, `#token=&key=`), `/device` (`?user_code=`), `/approve/{ref}`, `/invoke/{kind}` (mfa, oid4vp, oid4vci, with each kind's app link), the `/guest` and `/delegate` aliases — and the legacy link shapes still read but never emitted ([ADR 0140](../docs/adr/0140-pages-hosts-every-ceremony.md) §3). | `packages/ceremony-kit` (`ceremony-routes.generated.ts`, `pnpm --filter @opensesame/ceremony-kit generate:routes`: the link builders and parsers, the authenticator invocation), `packages/control-plane` (`INTERACTION_ROUTE`: the `/i/:ref` short link, the rendezvous launcher, the OpenAPI path), `apps/android` (app-link `pathPrefix`, OID4VC schemes); a drift test in each |
| [`conformance/deployment-mode-cases.json`](conformance/deployment-mode-cases.json) | Deployment-mode cases both planes must classify identically. | `crates/host-core`, `packages/control-plane` |
| [`conformance/otp-cases.json`](conformance/otp-cases.json) | RFC 4226 / RFC 6238 codes and the Key URI parsing rules. An invalid parameter is refused, never defaulted. | `crates/authenticator-core`, `packages/vault-core`, the Pages verify harness, the Identity API's dev factor |
| [`conformance/password-policy.json`](conformance/password-policy.json) | **The password generator**: character classes, the ambiguous set, defaults (length 20) and the rules, with cases. Both generators load it at runtime. | `crates/sealed-store` (`opensesame pass generate`, the KeePassXC bridge), `packages/app-core` (Pages, the client CLI, Android) |
| [`conformance/item-type-cases.json`](conformance/item-type-cases.json) | Vault item-type validation (the rejection table) and native projection onto a `pass` entry, as data ([ADR 0087](../docs/adr/0087-vault-item-type-plugins.md) §8). | `crates/vault-item-types`, `packages/vault-item-types` |

The domain model itself is mirrored in code rather than generated from here:
`crates/domain` (Rust) and `packages/os-domain` (TypeScript). WIT task
contracts are described in [docs/reference/wit-task-contracts.md](../docs/reference/wit-task-contracts.md).
