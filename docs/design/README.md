# Design

Interface design for the Pages app and the ceremony surfaces. The visual
contract — tokens, type, spacing, touch rules — is [`DESIGN.md`](../../DESIGN.md)
at the repository root; the product's users and voice are in
[`PRODUCT.md`](../../PRODUCT.md). Pages here apply those to specific screens.

## Contracts

| Page | Covers |
|---|---|
| [Controls](controls.md) | The control vocabulary: icon keys, which glyph means what, and why a verb is never painted on a button. Enforced by `pnpm lint:design`. |
| [Access screen](access-screen.md) | The Access section — the PAM plane. |
| [Access domains](access-domain-forest.md) | Access domains as a realm-bound forest. |
| [Identity screen](identity-screen.md) | People, providers and devices. |
| [Vault VFS](vault-vfs.md) | The vault as a first-party tree with keyboard-first navigation. |
| [Encrypted VFS](encrypted-vfs.md) | Tombs in the browser. |
| [Secret drop](secret-drop.md) | The share ceremony and burner items. |
| [Writing a vault item type](vault-item-types.md) | The item-type JSON format, field by field. |

## Design canvases

Each directory holds a written brief and interactive `*.dc.html` canvases
exploring one flow. Open the HTML files in a browser.

| Canvas | Flow |
|---|---|
| [Authentication flow](auth-flow/README.md) | Sign-out, switching accounts, and the unlock ceremony ([ADR 0091](../adr/0091-account-exits-and-unlock-ceremony.md)). |
| [First-run setup](first-run-setup/README.md) | What a new device shows first. |
| [Setup next steps](setup-next-steps/README.md) | What an operator can do after first-run setup. |
| [Settings connectivity](settings-connectivity/README.md) | The Settings pane's connection configuration. |
| [PWA install](pwa-install/README.md) | Installing the app from inside the app. |
| [Shared sessions](shared-sessions/README.md) | Making a session shareable: who is in it, what they may do. |

Screenshots of shipped changes, before and after, are in
[`docs/evidence/`](../evidence/README.md).
