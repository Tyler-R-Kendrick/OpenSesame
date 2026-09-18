# Product-experience baseline

- Checkout: `config-files` at `041aad7955fac098b0dad5adc615a3d7e7492428`.
- Prompt baseline `4358f7feacee97468b17abdd9b5ccc02c81ee68d` is an ancestor.
- Unrelated worktrees (`feat/ga-v-33b-fabric-bin`, agent-auth, pages-stack) were not reset or overwritten.
- Shell: five sections, `AppShell`, `page-to-tree`, keymap, `VaultPrefs` at `config/prefs`, command bar (`Ctrl-l` / `:`), approval inbox, Host secret-config history, guest/static Pages.
- Missing at start: Visual/Source draft, prefs.yaml aliases, configurable keybindings persistence, saved views as queries, hosted claim projection beyond pairwise `sub`, `clientCredentials` enabled, SCIM selector-only member remove, explicit group-role mappings.

## Stale prose

`DESIGN.md` still contains historical no-recovery/PIN wording. Implemented unlock, PIN, passkey, and recovery-code ceremonies stay. Encrypted storage is not a same-origin XSS boundary; an unlocked custodian remains a trust root.

## Classification

| Capability | Status |
| --- | --- |
| Five-section shell, keymap, command bar, inbox, Host config history | existing / extend |
| Visual/Source prefs document and aliases | new |
| Keybinding import/reset, saved views, palette metadata search | extend |
| Hosted claims + client_credentials + SCIM groups | new / extend |
| Native SAML IdP, LDAP server, outbound SCIM, reverse proxy | out_of_scope |
