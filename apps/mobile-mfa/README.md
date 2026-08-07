# Mobile MFA PWA

Step-up UX against the **Identity API** (`:8788`):

- `POST /v1/mfa/passkey/register` + `/assert`
- `POST /v1/mfa/totp/enroll` + `/verify`
- Optional Host API device approve (`:8787`)

```bash
pnpm --filter @opensesame/mobile-mfa dev
# VITE_IDENTITY_API=http://127.0.0.1:8788
```

Passkey verify in this slice is DEV-only (non-empty signature). Wire SimpleWebAuthn for production.
