# Product-experience baseline

> Status (2026-10-08): a record of the checkout this programme started from, not
> a description of today's Pages. Since then Pages dropped its Host panels
> ([ADR 0128](../../adr/0128-pages-without-host.md)), so the Host secret-config
> history named below is not in `apps/pages`, and `apps/pages/src/sections`
> holds more than five sections (`VaultSection`, `AccessSection`,
> `ConnectionsSection`, `IdentitySection`, `ActivitySection`, `WalletSection`,
> `SettingsSection`). Every path in `traceability.json` resolves in this tree.
> `DESIGN.md` has since been reworded for passkey and PIN sealing
> ([ADR 0180](../../adr/0180-vaults-are-sealed-by-passkey-not-password.md)), so
> the Stale prose note below describes the baseline, not today's file.

- Checkout: `config-files` at `041aad7955fac098b0dad5adc615a3d7e7492428`.
- Prompt baseline `4358f7feacee97468b17abdd9b5ccc02c81ee68d` is an ancestor.
- Unrelated worktrees (`feat/ga-v-33b-fabric-bin`, agent-auth, pages-stack) were not reset or overwritten.
- Shell: five sections, `AppShell`, `page-to-tree`, keymap, `VaultPrefs` at `config/prefs`, command bar (`Ctrl-l` / `:`), approval inbox, Host secret-config history, guest/static Pages.
- Missing at start: a preferences draft (since a file, not a toggle), prefs.yaml aliases, configurable keybindings persistence, saved views as queries, hosted claim projection beyond pairwise `sub`, `clientCredentials` enabled, SCIM selector-only member remove, explicit group-role mappings.

## Stale prose

`DESIGN.md` still contains historical no-recovery/PIN wording. Implemented unlock, PIN, passkey, and recovery-code ceremonies stay. Encrypted storage is not a same-origin XSS boundary; an unlocked custodian remains a trust root.

## Classification

| Capability | Status |
| --- | --- |
| Five-section shell, keymap, command bar, inbox, Host config history | existing / extend |
| Prefs document (a file; its Visual/Source toggle was removed 2026-10-05) and aliases | new |
| Keybinding import/reset, saved views, palette metadata search | extend |
| Hosted claims + client_credentials + SCIM groups | new / extend |
| Native SAML IdP, LDAP server, outbound SCIM, reverse proxy | out_of_scope |
