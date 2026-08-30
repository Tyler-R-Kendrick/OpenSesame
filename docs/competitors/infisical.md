# Infisical — craft bar (agent secret delivery)

> Competitive reference for OpenSesame’s **authority / agent delivery** craft
> bar ([PRODUCT.md](../../PRODUCT.md)). Not a password-manager clone.

**Stance: craft bar** for agent/secret injection workflows (`infisical run`,
Agent Proxy). OpenSesame aims at the same *operator habit* — inject authority
into a process without teaching agents to `getSecret()` — without becoming an
Infisical product or copying brand marks.

## Overview

[Infisical](https://infisical.com/) is an open-core secrets platform: projects,
environments, machine identities, CLI injection (`infisical run`), and an Agent
Proxy that keeps secrets out of application config by mediating access at
runtime. Teams use it as a centralized secret store plus delivery path for
apps, CI, and agents.

| Dimension | Infisical |
|-----------|-----------|
| Category | Secrets platform + agent/runtime injection |
| Trust model | Server-held secrets; identities / tokens unlock delivery |
| Sync | Cloud or self-hosted control plane |
| Agent story | Strong — `run` / proxy inject env or mediate fetches |
| Human vault UI | Secondary to platform secrets, not Bitwarden-class UX |
| License | Open-core (OSS + commercial) |

## Feature surface (what operators compare)

- Project / environment scoped secrets and folders.
- CLI: login, secret pull/push, `infisical run <cmd>` to inject into a child process.
- Machine identities, service tokens, and (where enabled) Agent Proxy.
- Integrations across clouds, CI, Kubernetes, and developer tools.
- Self-host and SaaS deployment modes.

OpenSesame’s Host plane answers a related question with a different contract:
ConnectionRef → authorize → invoke → receipt ([ADR 0005](../adr/0005-authority-handle-connectionref.md)),
not env injection as the primary agent API.

## Differentiators (why operators still pick Infisical)

- Mature secrets *platform* UX (projects, envs, audit, team RBAC).
- Drop-in `infisical run` for existing apps that expect env vars.
- Broad CI/K8s/cloud sync ecosystem already adopted by many teams.

## Differentiators (why OpenSesame wins a different slot)

- **Dual plane** — Host authorization fabric + Identity API; Infisical is not an
  OIDC/Identity product topology ([ADR 0017](../adr/0017-host-client-product-topology.md)).
- **No agent reveal** — agents never get plaintext via `show` / `getSecret()`.
- **Device human store** — Pages/OPFS vault for ceremonies; Infisical is not the
  Bitwarden craft bar.
- **Git sealed store** — `opensesame pass` / `.osseal` for local git ciphertext
  ([ADR 0037](../adr/0037-git-sealed-store.md)).

## OpenSesame mapping

| Infisical concept | OpenSesame |
|-------------------|------------|
| Project secrets | Host connections + sealed store / vault items (by role) |
| `infisical run` env injection | Craft bar only — prefer ConnectionRef invoke over env dump |
| Agent Proxy | Host authorize → invoke; receipts for audit |
| Machine identity | Device / workload auth + connection grants |
| Human password UI | Pages vault habits (Bitwarden craft bar), not Infisical |
| Private CA / issue cert | Host `/api/v1/certs` · `opensesame cert issue` · Pages certificate vault item |
| Certificate Manager | Host `/api/v1/certmgr/*` + `opensesame cert` verbs + the Pages Certificates section ([ADR 0066](../adr/0066-certificate-manager-domain-model.md)) |
| CA hierarchy (root + intermediate) | `certificate_authorities` with parent links, path-length constraints, DN fields, RSA-2048/4096 and ECDSA P-256/P-384 keys; externally-signed intermediates via CSR export + chain import |
| Certificate templates | Split in two: **policies** (constraints) and **profiles** (CA + policy + defaults), reusable across applications ([ADR 0066 §2](../adr/0066-certificate-manager-domain-model.md)) |
| Projects / workspaces | `pki_applications` with `admin`/`operator`/`auditor` members layered over the existing organization caller model |
| Enrollment methods | API (CSR or managed key), ACME server (RFC 8555, EAB required), EST (RFC 7030), SCEP (RFC 8894) — [ADR 0068](../adr/0068-enrollment-protocol-servers.md) |
| Revocation | RFC 5280 CRL v2 with reason codes, embedded CDP, ≤4 advertised mirrors — **plus an RFC 6960 OCSP responder, which Infisical does not ship** ([ADR 0067](../adr/0067-certificate-revocation-crl-ocsp.md)) |
| Certificate syncs | Broker-fenced pushes to admin-configured destinations; SSH/WinRM executors feature-gated default-off; never agent-triggerable ([ADR 0069](../adr/0069-certificate-syncs.md)) |
| Code signing / Sign API | Signers as authority handles with no key read path; digest-only Sign API; scope-pinned approvals with counters and windows; PKCS#11 provider module ([ADR 0070](../adr/0070-code-signing.md)) |
| HSM-backed keys | PKCS#11 connectors (`cryptoki`); HSM keys implement the same `Signer` trait as sealed keys ([ADR 0071](../adr/0071-hsm-connectors.md)) |
| Kubernetes issuer | `apps/k8s-issuer` kube-rs controller with `certmgr.opensesame.dev` CRDs, or the stock cert-manager ACME issuer against our ACME server ([ADR 0072](../adr/0072-kubernetes-external-issuer.md)) |
| Microsoft ADCS via MS-WCCE | **Not built** — DCOM/RPC transport; the HTTPS web-enrollment adapter covers the reachable surface ([ADR 0066 §N2](../adr/0066-certificate-manager-domain-model.md)) |
| Post-quantum ML-DSA CAs | **Not built** — roadmap; no ML-DSA X.509 path in the pinned stack ([ADR 0066 §N1](../adr/0066-certificate-manager-domain-model.md)) |
| Terraform provider | **Not built** — REST / CLI / MCP are the IaC surfaces under ADR 0065 ([ADR 0066 §N5](../adr/0066-certificate-manager-domain-model.md)) |

Also not built, each with rationale in
[ADR 0066 §Non-goals](../adr/0066-certificate-manager-domain-model.md): SCEP
Intune challenge validation (roadmap), cloud-provider and filesystem discovery
(roadmap — Infisical lists it as planned too), and KMS/KMIP/SSH-CA/PAM (separate
products in both line-ups). Validation depth per area — including which parts are
fixture-mocked or build-only — is in
[docs/validation/certificate-manager.md](../validation/certificate-manager.md).

> **Delivery status.** The `Private CA / issue cert` row above describes what
> ships today (ADR 0052: private CA, ACME DNS-01 client, `/api/v1/certs`). Every
> row from `Certificate Manager` onward describes the **decided target state**
> recorded in ADRs 0066–0072 and is being implemented — the ADRs are accepted,
> but do not read these rows as shipped capability. Current delivery status per
> area lives in
> [docs/validation/certificate-manager.md](../validation/certificate-manager.md);
> that document is the source of truth for what is actually built and how deeply
> it is validated.

Related: [PRODUCT.md](../../PRODUCT.md), [REUSE.md](../../REUSE.md) (study only),
catalog provider `infisical` in Host connector catalog.
