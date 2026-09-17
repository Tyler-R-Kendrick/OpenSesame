# Ambient SSO operator guide

Automatic sign-in is **opt-in**. The shipped personal GitHub Pages default
does not probe providers.

## Entra public client

1. Register a Single-page application in Entra ID.
2. Redirect URIs, exact, no wildcards:
   - `https://<origin>/` (root hosting)
   - `https://<origin>/OpenSesame/` (GitHub Pages project site)
   - `https://<origin>/OpenSesame/auth/redirect.html` (MSAL v5 bridge; header-capable hosts)
3. Enable authorization code flow with PKCE. Do not create a client secret.
4. Token configuration: ID tokens. Do not add Microsoft Graph, `User.Read`,
   mail, calendar, or `offline_access` for this client.

## Same-origin runtime config

Write `os-runtime-config.json` beside the Pages bundle:

```json
{
  "ambientAuth": {
    "schemaVersion": 1,
    "mode": "deployment-selected",
    "selectedProviderKey": "entra|https://login.microsoftonline.com/<tenant-id>/v2.0|<spa-client-id>|",
    "allowedTransport": "silent-redirect",
    "allowVisibleTopLevel": true
  }
}
```

Also add the matching provider under Pages Settings → sign-in methods
(`issuer`, `clientId`, `providerId: "microsoft"`). Policy will not enable
automatic acquisition for a key that is not in that allowlist.

`silent-redirect` is a top-level `prompt=none` authorize. Use `silent-iframe`
only on hosts that can omit COOP on `/auth/redirect.html` (Vercel headers,
not GitHub Pages).

## Browser prerequisites

- Edge on Windows can use PRT SSO to Entra; Chrome needs CloudAPAuthEnabled
  or the Microsoft SSO extension. OpenSesame does not read PRTs or Windows
  passwords.
- Successful SSO is not device-compliance evidence.

## GitHub Pages / Vercel

GitHub Pages cannot set COOP, CSP, or cache-control on the callback. The
static top-level `prompt=none` path still works. Do not disable site-wide
security headers to make popups work.

Vercel: omit `Cross-Origin-Opener-Policy` for `/auth/redirect.html` only.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| No automatic request | Default is disabled; last method is not consent |
| `login_required` | No upstream session, cookies blocked, or prompt=none iframe failed |
| Account shown, vault locked | Expected. Unlock remains the vault ceremony |
| Signed out user immediately signed in | Suppression/generation fence; file a bug if this happens |
| Shoo/Google button | Automatic acquisition is unsupported on Shoo |
