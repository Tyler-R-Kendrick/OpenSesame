# OpenSesame documentation

Pick the path that matches why you are here. Every section below has its own
index page with one line per document.

## Start here

| If you want to… | Read |
|---|---|
| Understand what OpenSesame is and why | [Root README](../README.md), then [PRODUCT.md](../PRODUCT.md) |
| Run it on your machine | [Getting started](getting-started/README.md) |
| Find your way around the code | [Repository tour](getting-started/repository-tour.md) |
| Understand how it works | [Architecture](architecture/README.md) |
| Deploy or operate it | [Operator guides](operators/README.md) |
| Integrate a website, agent or CLI | [Examples](../examples/README.md) and [Reference](reference/README.md) |
| Change it | [Contributing](contributing/README.md) and [`AGENTS.md`](../AGENTS.md) |
| Review its security | [Security](security/README.md) |
| Know why something is the way it is | [Architecture decision records](adr/README.md) |

## Sections

| Section | What is in it | Kind |
|---|---|---|
| [getting-started/](getting-started/README.md) | Install, run each plane, run the tests, tour the repository. | Tutorial |
| [architecture/](architecture/README.md) | How the system is built: planes, topology, the vault format, authority, rotation, sign-in. | Explanation |
| [adr/](adr/README.md) | Architecture decision records — one decision each, with its context and cost. | Explanation |
| [operators/](operators/README.md) | Deploying, configuring and running OpenSesame: identity, Host, Pages, mTLS, duress, alerts. | How-to |
| [reference/](reference/README.md) | Protocol profiles, standards support, wire contracts, the daemon socket, dependencies. | Reference |
| [design/](design/README.md) | Interface design: the control vocabulary, screens, and design canvases for major flows. | Explanation |
| [security/](security/README.md) | Threat models, trust boundaries, the key hierarchy, and the dated [audit log](security/audits/README.md). | Reference |
| [validation/](validation/README.md) | Test strategy, coverage, quality gates, and the evidence each feature shipped with. | Reference |
| [evidence/](evidence/README.md) | Before/after screenshots for every user-visible change, one directory per change. | Record |
| [implementation/](implementation/README.md) | Working plans and baselines for multi-part features still being built out. | Record |
| [research/](research/README.md) | Ecosystem research and [competitor notes](research/competitors/index.md). | Explanation |
| [contributing/](contributing/README.md) | How work gets done here: gates, automation routines, team runbooks. | How-to |
| [archive/](archive/README.md) | Superseded plans and one-shot agent prompts, kept for provenance. | Record |

The repository root also carries four documents that tools read by name:
[`AGENTS.md`](../AGENTS.md) (the rulebook for coding agents and humans),
[`DESIGN.md`](../DESIGN.md) (the visual design contract),
[`PRODUCT.md`](../PRODUCT.md) (users, purpose, positioning) and
[`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Vocabulary

A few words carry specific meaning everywhere in these documents.

| Term | Meaning |
|---|---|
| **Host** | The Rust authority service (`apps/gateway`, Host API on `:8787`). It holds connections, authorizes intents, performs calls and signs receipts. |
| **Identity API** | The TypeScript OIDC issuer (`apps/control-plane`, `:8788`): principals, passkeys, claims, federation. Always separate from the Host. |
| **Daemon** | The local host agent (`apps/daemon`, `:18790`) that issues short-lived session capabilities to devcontainers, WSL, the toolbar and credential helpers. |
| **ConnectionRef** | A handle naming a connection. It carries no secret; presenting it lets the Host act, never the caller read. |
| **Intent** | What a caller wants done with a ConnectionRef. The unit the Host authorizes and the receipt records. |
| **Grant** | Authority given to an agent or person, bounded by a capability ceiling. Grants only narrow. |
| **Receipt** | The Host's signed record of an authorized invocation. |
| **Vault** / **tomb** | The end-to-end-encrypted store on a device. A device can hold several (personal, one per project, guest); each is a tomb. |
| **Capability** | An optional product feature an operator turns on. Its code never loads before consent ([ADR 0130](adr/0130-operator-controlled-capability-composition.md)). |
| **Plane** | Identity (who), Host/authority (what may be done), client (what runs on a person's device). |

## Writing documentation

- **Put it where its reader looks.** A how-to for someone running a deployment
  goes in `operators/`; an explanation of a mechanism goes in `architecture/`;
  a table somebody looks things up in goes in `reference/`.
- **Add it to the section index.** Each section's `README.md` lists every page
  with one line. The ADR and audit indexes are generated: run
  `pnpm docs:index`.
- **Link relatively**, so links work on GitHub and in a checkout alike.
- **Decisions go in ADRs**, dated audits in `security/audits/`, screenshots in
  `evidence/<yyyy-mm-dd>-<topic>/`. None of the three is edited after the fact
  except to mark a decision superseded.
- **Plans that are done move to `archive/`**, with a line in its index saying
  what replaced them.
