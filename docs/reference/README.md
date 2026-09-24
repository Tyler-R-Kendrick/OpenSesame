# Reference

Facts to look up: which standards OpenSesame implements and how strictly,
what goes over each wire, and what it is built on.

## Standards and protocols

| Page | Contents |
|---|---|
| [Standards matrix](standards-matrix.md) | Every standard OpenSesame touches — RFCs, OIDC, WebAuthn, MCP, DPoP — its status and where it lives in the code. |
| [Protocol profiles](protocol-profiles.md) | How external authorization standards map onto internal `ProtocolProfile` values: token presentation, downgrade policy, task binding. |
| [Protocol conformance](protocol-conformance.md) | Identity-plane conformance: feature, spec, library, and what OpenSesame owns. |
| [Static-site AgentAuth](protocols/agent-auth-static.md) | Advertising OpenSesame as the authorization server of a static origin. |
| [`auth.md` template](protocols/auth.md.template) | The shape of the `/auth.md` agent document the Identity API generates. |
| [Wallet protocol compatibility](wallet-protocol-compatibility.md) | Payment and mandate profiles and why none is production-enabled. |

## Wire contracts

| Page | Contents |
|---|---|
| [Daemon socket](daemon-socket.md) | The daemon's TCP and Unix-socket contract, environment variables and routes. |
| [WIT task contracts](wit-task-contracts.md) | Versioned task-scoped WIT packages and their compatibility rules. |
| [Host OpenAPI](../../spec/openapi/host-api.yaml) | The Host API, route by route. |
| Identity OpenAPI | Generated to `packages/control-plane/openapi.json` by `pnpm generate:openapi`. |
| [Vault format v1](../architecture/vault-format-v1.md) | The vault file format and its golden vectors. |

## Dependencies and licensing

| Page | Contents |
|---|---|
| [Foundations we reuse](reuse.md) | What OpenSesame builds on instead of reinventing, the pinned choice, and its license stance. |
| [Identity-plane dependencies](identity-dependencies.md) | The Identity API's direct dependencies and why each is there. `pnpm generate:sbom` writes a CycloneDX SBOM. |

Command-line and API usage is documented where agents and people look for it:
the [`skills/`](../../skills/README.md) directory has one guide each for the
APIs, the CLIs, the MCP servers and the browser extension.
