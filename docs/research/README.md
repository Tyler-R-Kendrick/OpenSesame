# Research

Background reading that informed decisions: surveys of how other systems solve
a problem, and notes on the products OpenSesame is measured against. Each page
names the ADR it fed, or says that no ADR has adopted it yet.

| Page | Fed |
|---|---|
| [Competitors and peers](competitors/index.md) | Positioning in [PRODUCT.md](../../PRODUCT.md): 1Password, Bitwarden, KeePass, `pass`, Infisical, Doppler, HashiCorp Vault, Nango, SOPS, age, Tailscale and others — each marked with its stance: direct, craft bar, peer, study, consume target, adjacent or prior art. |
| [Vault item types](vault-item-types.md) | [ADR 0087](../adr/0087-vault-item-type-plugins.md) — item types as an extension point. |
| [Hooks ecosystem](hooks-ecosystem.md) | [ADR 0065](../adr/0065-connector-hook-architecture.md) — hooks as an extension mechanism. |
| [AI-native product tutorials](ai-native-product-tutorials.md) | [ADR 0088](../adr/0088-ai-native-contextual-support.md) — in-product support. |
| [Android native integration](android-native-integration.md) | [ADR 0133](../adr/0133-shared-app-core.md) — the shared app core (§11). The Android surface itself (§§2–10) is still a proposal that no ADR adopts. |
| [Claimable connection delegation](claimable-connection-delegation.md) | [ADR 0044](../adr/0044-claimable-connection-delegation.md) — what exists, what standards and peers offer, and a phased plan. |
| [Credential surrogates](credential-surrogates.md) | [ADR 0150](../adr/0150-surrogate-credentials-at-the-last-hop.md) — Meta Muse, sandbox-runtime, Tokenizer, Horcrux and peers: where the stand-in lives, where the swap happens, and the reflection and tripwire gaps they share. |
| [Keybinding customization](keybinding-customization.md) | [ADR 0156](../adr/0156-keybindings-and-macros.md) — how editors (VS Code, JetBrains, Vim, which-key) and games (WoW, SC2, Steam Input) let power users bind keys, sequences and macros, and the Keybindings settings redesign that followed. |
| [Travel mode](travel-mode.md) | [ADR 0143](../adr/0143-travel-mode.md) — 1Password's Travel Mode, comparable designs, and what a good travel mode needs. It also fed [ADR 0168](../adr/0168-duress-modes-from-scenarios.md) (duress modes). |
| [Hiding items while traveling](travel-hidden-items.md) | [ADR 0171](../adr/0171-hide-items-while-traveling.md) — the audit of every place an item's name or content persists after it leaves the vault you carry. |
| [Modularity and refactoring](modularity-refactor-strategy.md) | An evaluation, not yet a decision: where the codebase's complexity comes from, and the refactoring strategy that would follow. |
