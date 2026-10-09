# Operator guides

How to deploy, configure and run OpenSesame. Each guide is task-shaped: what to
set, in what order, and how to tell it worked. For the mechanisms behind them
see [architecture](../architecture/README.md); for the environment variables it
lists, [`.env.schema`](../../.env.schema) is authoritative, and a guide that
introduces its own (mTLS, plugins) names them where they are used.

## Start here

| Guide | When you need it |
|---|---|
| [Local operator guide](local.md) | Running both planes on one machine: the daemon, devcontainers, env-spec resolution, live providers. |
| [Health and operations](health-and-operations.md) | Health and readiness endpoints, ports, backup and restore, agent-hooks and web-login housekeeping, and signing-key rotation. |
| [Logs and events at rest](log-and-event-sealing.md) | The sealed log file, the keys that seal logs and event rows, what refuses to start without one, and how to read a sealed log. |
| [Pages origin](pages-origin.md) | What the GitHub Pages build can and cannot do from a shared origin, and how to give it its own. |
| [Capability composition](capability-composition.md) | Deciding which optional features a deployment contains, permits and lets a device run. |
| [Encrypted search](encrypted-search.md) | Keeping the browser's identifier databases encrypted with no readable name, id or field and still searchable (ADR 0175); using the library. |
| [Vault files](vault-files.md) | Every secret as its own file on disk: the tree, what a file shows and holds, backing up and sharing, two writers, and the privately hosted store (ADR 0182). |
| [Optional plugins](plugins.md) | Installing, pinning and switching on runtime plugins such as the surrogate proxy; the boundary gate. |

## Identity

| Guide | When you need it |
|---|---|
| [Identity administration](identity-administration.md) | Running the Identity API as an OIDC issuer and administering it from the Pages Identity screen. |
| [Self-host the authentication service](authentication-service.md) | Passkey and password sign-in for your own applications through the Identity API. |
| [Browser-local IAM](browser-local-iam.md) | People, organizations and application sign-in kept inside the encrypted vault, with no service at all. |
| [Ambient SSO](ambient-sso.md) | Opt-in automatic sign-in and the safe default account session. |
| [Live provider verification](live-provider-verification.md) | Proving Google, Entra ID, GitHub and Apple sign-in against real providers. |
| [Connectors on Vercel Connect](connect-connectors.md) | Creating a connector from its plan, authorizing as yourself, proving the user token, and granting access (ADR 0147). |
| [Native SIOPv2 on Pages](siop-deployment.md) | Using the Pages vault as a Self-Issued OpenID Provider. |
| [Use OpenSesame Pages as your login](use-pages-as-your-login.md) | For a relying-party developer on another origin: register the application, read `siop-metadata.json`, verify the token with the kit (Express and single-page examples), and what Pages is not (ADR 0161). |
| [Host-to-Identity mapping](mapping-resolve.md) | How the Host resolves an upstream issuer and subject to a principal. |

## Host and authority

| Guide | When you need it |
|---|---|
| [Host project-config authorization](config-authorization.md) | The operator-managed Host role ceiling for configuration and project permissions. |
| [Local authority migration](local-authority-migration.md) | Moving local authority and deployment configuration onto the hardened interfaces. |
| [General authority support matrix](general-authority-support-matrix.md) | Which hierarchical-authority features are enforced where, and which are not yet. |
| [Agent hooks](agent-hooks.md) | The policy that decides what an agent may do, who is asked when it needs a person, the audit, and what fails closed (ADR 0159). |
| [Web-login recipes](web-login-recipes.md) | Storing a recipe, pinning the keys that sign them, signing locally, and proving one with an attended canary before the scanner rotates a login on its own (ADR 0076 §4). |
| [Access portal](access-portal.md) | The Access screen, the local PAM plane: grants, requests, sessions, connectors, resources and policies, and what an Identity service adds. |
| [Credential helpers](credential-helpers.md) | git, Docker, AWS and kubectl authenticating with short-lived derived tokens. |
| [Browser identity verification](host-browser-verification.md) | The host-authorization ceremony that follows pairing, and the one-use browser-control approval. |
| [Encrypted sync pages](sync-pages.md) | The sync page format and the legacy-ownership migration. |
| [Tailnet vault sync](tailnet-sync.md) | Run a drive on the daemon, open slots, pair devices over Tailscale (ADR 0144). |
| [Tailnet device management](tailnet-devices.md) | Connect the daemon to a tailnet, pair the web app, approve, rename, tag, route, expire, remove and add machines (ADR 0169). |

## Transport and alerting

| Guide | When you need it |
|---|---|
| [Serving Bitwarden clients](bitwarden-compat.md) | Point `bw` and the Bitwarden apps at the Host, and move people over from vaultwarden or Bitwarden: Argon2id, signups, the importer, scope. |
| [Optional mTLS and workload identity](mtls.md) | Per-hop TLS profiles, service bindings, SPIFFE, NATS and ingress references. |
| [Security alerting](security-alerting.md) | Routing security notices to Alertmanager, PagerDuty, syslog and the built-in notifier. |
| [Notification channels](notification-channels.md) | Where people are asked to approve, and what each channel can be trusted with. |
| [Live sessions across networks](live-sessions.md) | Tunnel addresses, STUN/TURN, relay only and the code carriers (Nostr, MQTT, NATS, ntfy) a live session may use; every one optional. |

## Vaults and duress

| Guide | When you need it |
|---|---|
| [Vault key protection](vault-key-protection.md) | Unlock methods, recovery keys, age recipients and cloud KMS for a vault. |
| [Customer key segmentation](customer-key-segmentation.md) | Separate customer vaults, envelope encryption across secret stores, and deployment-root custody. |
| [Duress profiles](duress-profiles.md) | Presets, consent, delays and rehearsal for coerced unlocks. |
| [Duress inventory and recovery](duress-inventory-recovery.md) | Inventorying unlock paths, migrating, recovering and retiring duress setups. |
| [Duress troubleshooting](duress-troubleshooting.md) | PRF support, RP-ID changes and other failure modes. |
| [New-item links](vault-draft-links.md) | Links that open a reviewable draft item with generated defaults. |
| [Travel mode](travel-mode.md) | Crossing a border carrying only the vaults that are safe to carry, or only some of one vault's items, and bringing the rest back (ADR 0143, ADR 0171). |

## Payments

| Guide | When you need it |
|---|---|
| [Wallet spending — local verification](wallet-spending.md) | Running the wallet spending gates locally. Never against mainnet. |
