# Operator guides

How to deploy, configure and run OpenSesame. Each guide is task-shaped: what to
set, in what order, and how to tell it worked. For the mechanisms behind them
see [architecture](../architecture/README.md); for every environment variable,
[`.env.schema`](../../.env.schema) is authoritative.

## Start here

| Guide | When you need it |
|---|---|
| [Local operator guide](local.md) | Running both planes on one machine: the daemon, devcontainers, env-spec resolution, live providers. |
| [Health and operations](health-and-operations.md) | Health and readiness endpoints, logs, and day-two checks for both planes. |
| [Pages origin](pages-origin.md) | What the GitHub Pages build can and cannot do from a shared origin, and how to give it its own. |
| [Capability composition](capability-composition.md) | Deciding which optional features a deployment contains, permits and lets a device run. |

## Identity

| Guide | When you need it |
|---|---|
| [Identity administration](identity-administration.md) | Running the Identity API as an OIDC issuer and administering it from the Pages Identity screen. |
| [Self-host the authentication service](authentication-service.md) | Passkey and password sign-in for your own applications through the Identity API. |
| [Browser-local IAM](browser-local-iam.md) | People, organizations and application sign-in kept inside the encrypted vault, with no service at all. |
| [Ambient SSO](ambient-sso.md) | Opt-in automatic sign-in and the safe default account session. |
| [Live provider verification](live-provider-verification.md) | Proving Google, Entra ID, GitHub and Apple sign-in against real providers. |
| [Connectors on Vercel Connect](connect-connectors.md) | Creating a connector from its plan, authorizing as yourself, proving the user token, and granting access (ADR 0146). |
| [Native SIOPv2 on Pages](siop-deployment.md) | Using the Pages vault as a Self-Issued OpenID Provider. |
| [Host-to-Identity mapping](mapping-resolve.md) | How the Host resolves an upstream issuer and subject to a principal. |

## Host and authority

| Guide | When you need it |
|---|---|
| [Host project-config authorization](config-authorization.md) | The operator-managed Host role ceiling for configuration and project permissions. |
| [Local authority migration](local-authority-migration.md) | Moving local authority and deployment configuration onto the hardened interfaces. |
| [General authority support matrix](general-authority-support-matrix.md) | Which hierarchical-authority features are enforced where, and which are not yet. |
| [Access portal](access-portal.md) | The Access screen: just-in-time grants, approvals and live sessions. |
| [Credential helpers](credential-helpers.md) | git, Docker, AWS and kubectl authenticating with short-lived derived tokens. |
| [Browser identity verification](host-browser-verification.md) | Pairing a browser to the Host and the one-use controls that follow. |
| [Encrypted sync pages](sync-pages.md) | The sync page format and the legacy-ownership migration. |
| [Tailnet vault sync](tailnet-sync.md) | Run a drive on the daemon, open slots, pair devices over Tailscale (ADR 0144). |

## Transport and alerting

| Guide | When you need it |
|---|---|
| [Serving Bitwarden clients](bitwarden-compat.md) | Point `bw` and the Bitwarden apps at the Host: Argon2id, signups, scope. |
| [Optional mTLS and workload identity](mtls.md) | Per-hop TLS profiles, service bindings, SPIFFE, NATS and ingress references. |
| [Security alerting](security-alerting.md) | Routing security notices to Alertmanager, PagerDuty, syslog and the built-in notifier. |
| [Notification channels](notification-channels.md) | Where people are asked to approve, and what each channel can be trusted with. |

## Vaults and duress

| Guide | When you need it |
|---|---|
| [Vault key protection](vault-key-protection.md) | Unlock methods, recovery keys, age recipients and cloud KMS for a vault. |
| [Duress profiles](duress-profiles.md) | Presets, consent, delays and rehearsal for coerced unlocks. |
| [Duress inventory and recovery](duress-inventory-recovery.md) | Inventorying unlock paths, migrating, recovering and retiring duress setups. |
| [Duress troubleshooting](duress-troubleshooting.md) | PRF support, RP-ID changes and other failure modes. |
| [New-item links](vault-draft-links.md) | Links that open a reviewable draft item with generated defaults. |

## Payments

| Guide | When you need it |
|---|---|
| [Wallet spending — local verification](wallet-spending.md) | Running the wallet spending gates locally. Never against mainnet. |
