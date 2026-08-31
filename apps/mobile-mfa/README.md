# Mobile MFA PWA

The phone half of a cross-device approval (ADR 0086), and the enrolment surface
for the authenticators it uses.

Opened on an interaction link, the approval **is** the screen:

1. `GET /i/<ref>` — unauthenticated summary. Scanning is not approving.
2. Sign in, then `GET /v1/interactions/<ref>` for the approver's view.
3. `POST /v1/interactions/<ref>/approve` or `/deny`, echoing the request digest.

Links, parsing, fragment hygiene and the four calls are
`@opensesame/ceremony-kit`'s — this app owns the JSX and nothing else about
them. The canonical link is `https://<host>/i/<ref>`; `?user_code=`, `?code=`,
`opensesame://invoke/mfa` and `opensesame-mfa://approve` still parse, as
adapters for links already printed, and land on the device-approval ceremony.

Opened on nothing, it is the standalone surface:

- `POST /v1/mfa/passkey/registration-options` + `/register` + `/assert`
- `POST /v1/mfa/totp/enroll` + `/verify`
- `POST /v1/device/approve` (user code typed by hand)

```bash
pnpm --filter @opensesame/mobile-mfa dev
# VITE_IDENTITY_API=http://127.0.0.1:8788
```

Approving a device grants a short-lived client session. It never transfers
ownership of anything — a `claim_id` on a link is shown as a dead end and sent
to the Identity console (ADR 0009).
