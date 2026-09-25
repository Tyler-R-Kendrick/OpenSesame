# ops/

Running OpenSesame somewhere, and running this repository. Everything here is
a reference or a runbook: the product works without any of it, and an operator
is expected to adapt it rather than adopt it wholesale.

| Directory | What it is |
|---|---|
| [`compose/`](compose) | A Docker Compose stack for local or HA-shaped runs: Postgres, OpenFGA, OpenBao, Keycloak (with the `opensesame` realm in `keycloak/`), NATS, and images for the gateway, worker and callback edge. `docker compose -f ops/compose/docker-compose.yml up`. |
| [`ingress/`](ingress) | The reference trusted ingress for the `trusted_ingress` mTLS profile: a pinned Caddy and its Caddyfile, forwarding RFC 9440 `Client-Cert` evidence. |
| [`nats/`](nats) | NATS server profiles: plaintext loopback for development, client mTLS (`verify`), certificate mapping (`verify_and_map`), the sealed mixed-mode auth callout, and the one tested server-to-server topology; the Host service-role users are defined once in `opensesame-roles.conf`. |
| [`github/`](github) | Repository governance as code: the default-branch ruleset and `governance.mjs`, which applies or verifies it. |
| [`routines/`](routines) | Prompts for the scheduled agent sessions that run audits, fuzz batches and drift checks outside CI. How they are scheduled: [docs/contributing/agent-routines.md](../docs/contributing/agent-routines.md). |

The editor development container lives in [`.devcontainer/`](../.devcontainer),
where editors look for it.

Operator guides — what to configure, and why — are in
[docs/operators](../docs/operators/README.md); transport security in particular
is [docs/operators/mtls.md](../docs/operators/mtls.md).
