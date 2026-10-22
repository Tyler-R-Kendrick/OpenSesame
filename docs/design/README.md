# Design

Interface design for the Pages app and the ceremony surfaces. The visual
contract — tokens, type, spacing, touch rules — is [`DESIGN.md`](../../DESIGN.md)
at the repository root; the product's users and voice are in
[`PRODUCT.md`](../../PRODUCT.md). Pages here apply those to specific screens.

## Contracts

| Page | Covers |
|---|---|
| [Design tooling](tooling.md) | Storybook defines the system, Figma sets the look, Stitch prototypes alternatives; per-agent skill and MCP configuration. |
| [Controls](controls.md) | The control vocabulary: icon keys, which glyph means what, and why a verb is never painted on a button. Enforced by `pnpm lint:design`. |
| [Access screen](access-screen.md) | The Access section — the PAM plane (original Host-bound design, with the as-built tabs). |
| [Access domains](access-domain-forest.md) | Access domains as a realm-bound forest. |
| [Identity screen](identity-screen.md) | People, agents, providers, devices, applications and organizations. |
| [Vault VFS](vault-vfs.md) | The vault as a first-party tree with keyboard-first navigation. |
| [Encrypted VFS](encrypted-vfs.md) | Tombs in the browser. |
| [Secret drop](secret-drop.md) | The one-time share ceremony and the claim page that opens it. |
| [Writing a vault item type](vault-item-types.md) | The item-type JSON format, field by field. |
| [Item formats](item-formats.md) | The closed parsers and synthetic generators for checksummed and issuer-shaped secrets. |
| [Item rotation](item-rotation.md) | Default 30-day schedules, the locked-vault rotation queue, and the optional relay boundary. |
| [Agent Vault](agent-vault.md) | The native/PWA split for brokered agent access, the Infisical parity contract, and the delivery slices. |
| [Machine identity auth](machine-identity-auth.md) | Every Infisical machine-identity auth method, its fields, native/PWA applicability, and the parity gaps. |
| [Group provisioning](group-provisioning.md) | GitHub team sync, SCIM Group CRUD and approval, and groups as sharing principals. |
| [Email domain verification](email-domain-verification.md) | DNS-proved work domains, SSO routing, SCIM enforcement, expiry and the current parity gaps. |
| [Assume privilege](assume-privilege.md) | Time-boxed, audited permission testing for owned agents and applications, scoped to one vault or project. |

## Design canvases

Each directory holds a written brief and interactive `*.dc.html` canvases
exploring one flow. Open the HTML files in a browser.

| Canvas | Flow |
|---|---|
| [Authentication flow](canvases/auth-flow/README.md) | Sign-out, switching accounts, and the unlock ceremony ([ADR 0091](../adr/0091-account-exits-and-unlock-ceremony.md)). |
| [First-run setup](canvases/first-run-setup/README.md) | What a new device shows first. |
| [Setup next steps](canvases/setup-next-steps/README.md) | What an operator can do after first-run setup. |
| [Settings connectivity](canvases/settings-connectivity/README.md) | A connector strip and ceremony for the Settings pane (not built as drawn). |
| [PWA install](canvases/pwa-install/README.md) | Installing the app from inside the app. |
| [Shared sessions](canvases/shared-sessions/README.md) | Making a session shareable: who is in it, what they may do. |

Screenshots of shipped changes, before and after, are in
[`docs/evidence/`](../evidence/README.md).
