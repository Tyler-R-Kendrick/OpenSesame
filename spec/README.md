# spec/

Language-neutral contracts. Nothing here is code in either plane; both planes
compile against it, test against it, or both. Changing a file here is changing
an interface — expect tests on both sides to tell you who depends on it.

Anything more than one target needs is defined here once, and every target
reads it rather than keeping a copy ([ADR 0139](../docs/adr/0139-one-definition-every-target.md)).

| Path | Contract | Consumed by |
|---|---|---|
| [`wit/`](wit) | WebAssembly component (WIT) worlds: `core` (shared IR), `host` (host capabilities), `client` (vault and sync), `connector` (connector guests — no `secrets.get`), `task`, `proof`, `mediation`. | `crates/core`, `crates/host-core`, `crates/client-core`, `crates/connector-host`, `crates/connector-sdk`, `crates/sandbox` |
| [`openapi/host-api.yaml`](openapi/host-api.yaml) | OpenAPI description of the Host API. The gateway's contract test checks its routes against it. (The Identity API's is generated: `apps/control-plane/openapi.json`.) | `crates/gateway` route contract test, control-plane host-client test |
| [`openfga/`](openfga) | The OpenFGA authorization model (`model.fga`) and the baseline tuples (`baseline.fga`). | `crates/authz`, `packages/policy` additivity tests, the authority-fabric gate |
| [`connectors/catalog.json`](connectors/catalog.json) | **The integration catalog** — every integration any target lists, with its auth, scopes, egress, operations, fields and aliases ([ADR 0139](../docs/adr/0139-one-definition-every-target.md)). | `crates/connection-broker` (loader), drift tests in `crates/connector-host`, `crates/connection-detect`, `crates/daemon`, `packages/app-core` |
| [`connectors/catalog.view.json`](connectors/catalog.view.json) | The Host API's provider view of every catalog row, written by `cargo test -p opensesame-connection-broker --test catalog_view` (`UPDATE_CATALOG_VIEW=1` regenerates). | `packages/app-core` (`connector-catalog.generated.ts`, `pnpm --filter @opensesame/app-core generate:catalog`) |
| [`connectors/fnox-parity.json`](connectors/fnox-parity.json) | The provider parity table shared by the Host connector host and the client connector directory. | `crates/connector-host`, `packages/app-core` |
| [`connectors/mock/`](connectors/mock) | A reference connector manifest, used to test manifest parsing. | `crates/connector-host` |
| [`conformance/deployment-mode-cases.json`](conformance/deployment-mode-cases.json) | Deployment-mode cases both planes must classify identically. | `crates/host-core`, `apps/control-plane` |

The domain model itself is mirrored in code rather than generated from here:
`crates/domain` (Rust) and `packages/os-domain` (TypeScript). WIT task
contracts are described in [docs/reference/wit-task-contracts.md](../docs/reference/wit-task-contracts.md).
