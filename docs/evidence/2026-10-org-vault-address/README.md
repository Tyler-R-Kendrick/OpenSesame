# Org vault addressing (ADR 0181) — visual evidence

Captured at desktop width (1280px) from a Pages build with `sharing.relay` enabled.

| File | Scene |
|------|--------|
| `org-directory.png` | Settings › Sharing › Relay — organization vault directory |
| `vault-list-address.png` | Vault list row showing `owner/slug` address |
| `create-org-vault.png` | Creating an organization vault entry |
| `member-publish-refused.png` | Member role refused publish (tray notice) |

Regenerate:

```bash
VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  node docs/evidence/2026-10-org-vault-address/capture.mjs
```
