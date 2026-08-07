# Threat Model — OpenSesame

Method: STRIDE + asset/actor/data-flow analysis.

## Assets
- Human vault plaintext / VRK / PCK / IDK (client-only)
- Authority credentials (OAuth refresh, CA keys, dynamic secret engines)
- Grants, policy model, revocation state
- Claim tokens / device codes (one-time secrets)
- Receipt signing keys
- Connector components (signed OCI)

## Actors
Human, device, workload, service, agent, agent instance, malicious connector, compromised node, malicious admin, external IdP, public callback edge.

## Trust boundaries
1. Client crypto boundary (E2EE)
2. Gateway PEP
3. Authority plane (OpenBao/KMS)
4. WASM capability boundary
5. Public callback edge (narrow)
6. Mesh transport (not authorization)

## High-risk abuse cases & mitigations

| Threat | Mitigation | Test anchor |
|--------|------------|-------------|
| Token theft via logs/env | Opaque handles, redaction, host agent | `crates/redaction`, CLI tests |
| Claim/device code replay | Hash-at-rest, single-use, expiry | `crates/claims`, authn tests |
| Confused deputy / MCP passthrough | Separate inbound/outbound creds; audience validation | gateway authn tests |
| SSRF via connector | Host allowlist, DNS/IP checks | connector-host tests |
| Cross-tenant access | Org FK + policy + opaque IDs | authz policy fixtures |
| Extension message forgery | Origin/frame binding; no getSecret | browser tests |
| Quorum loss write | A2/A3 fail closed | availability tests |
| Malicious WASM | Capability denial + digest verify | sandbox tests |
| Rotation failure | verify-before-revoke, reconcile | rotation tests |
| Supply chain | pins, deny, SBOM, signatures | CI |

## Credential / authority abuse (added)

| Threat | Mitigation | Test anchor |
|--------|------------|-------------|
| Agent knows ConnectionRef → extracts secret | Resolve/Materialize denied without export grant | `authz::authority_use` |
| Gateway string-replaces SecretRef to attacker URL | Egress binding + typed ops; no generic substitution | `EgressBinding`, connector-host redirect tests |
| Authenticated 302 to evil.example | Cross-authority redirect denied while credential held | `follow_redirect_with_credential` |
| WASM `secrets.get` | Not in WIT imports; authorized-http/sign only | `wit/connector/world.wit` |
| SecretRef late-binding into agent env | Agent API is ConnectionRef+Intent (ADR 0005) | domain `resolve_secret_for_agent` |
| Unconstrained placeholder substitution (email token away) | Placement + max occurrences fail-closed | `PlaceholderPlacement` / connector-host |
| Same-UID agent reads host keychain | Host agent session capability; sandbox egress via broker | credential-agent + ADR 0006 |
| Agent `materialize` via `.env` | DevDeliveryPolicy denies materialize for agents | `opensesame dev --agent` |

See ADR 0005–0006 and SUDP (arXiv:2604.24920) for custodian execution semantics.
