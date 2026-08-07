# Architecture Overview

```
Clients (CLI, extension, SDK, MCP, PWA, toolbar)
        │  mesh / mTLS / HTTPS / DPoP / local daemon
        ▼
┌───────────────────────┐     ┌──────────────────────────┐
│ Identity API (:8788)  │     │ Host API gateway (:8787) │
│ control-plane (TS)    │     │ uses host-core (Rust)    │
└───────────────────────┘     └────────────┬─────────────┘
                                           │
                              Policy PEP + Broker (host-core)
                                   ┌───────┴───────┐
                                   ▼               ▼
                            E2EE client-core   Authority adapters
                            (local sync)       (OpenBao / OpenFGA / WASM)
```

**APIs stay separate** (ADR 0017). Polyglot cores share WIT contracts.

- Host/client topology: `docs/architecture/host-client-topology.md`
- Identity plane: `docs/architecture/identity-plane.md`
- Availability classes A0–A3: ADR 0003
- ConnectionRef over SecretRef: ADR 0005
