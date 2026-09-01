# Authentication flow — design canvas

Design record for [ADR 0090](../../adr/0090-account-exits-and-unlock-ceremony.md):
the Pages vault's unlock screen redrawn to state both things a device knows —
**who** is signed in and **which key** opens the vault — with the roads out of
an account that the app never had (sign out, switch account, attach another),
and an authenticator-code enrollment that can no longer brick a vault.

Published canvas:
<https://claude.ai/code/artifact/c1b6217c-62d1-4ba9-8d0d-af5d83ed2b66>

## Artboards

| File | Page | What it shows |
|------|------|---------------|
| `Main.dc.html` | Screens | **Live.** Unlock on a 390×844 phone: the account row above both tabs, the step rail an enrolled authenticator code earns, tabs for exactly the enrolled methods, and the code as step 2. Tweaks: dark mode, MFA on/off, a PIN enrolled or not, signed in or not. Sign out and Switch say what the device can and cannot end. |
| `SignIn.dc.html` | Screens | The Sign in tab beside a sealed vault with an account already signed in: the same row, the social bar, guest, the identifier field. |
| `AccountMenu.dc.html` | Screens | Inside the app: the `who@vault:/` prompt with its menu open — the account named at the top, org profiles, and the three exits. |
| `EnrollMfa.dc.html` | Screens | Settings → Security: enrolling MFA now asks for a code before it turns on, and the same row withheld beside a guest session. |
| `Flow.dc.html` | Flow | The whole flow on one page: the *who* lane and the *key* lane, each with its own exit, and the rule that neither stands in for the other. |
| `Today.dc.html` | Flow | Today's unlock screen beside the redraw, with what each line answers. |
| `canvas.json` | | Two pages, layout, sticky notes, launch view. |

## What the research established (shoo.dev)

Verified against the live service, its docs and the published `@shoojs/*`
packages on 2026-09-01; the details are in the ADR and in
`apps/pages/src/lib/federation.ts` comments.

- Shoo is a Google-only broker (Ping Labs / t3.gg), free, "super early WIP",
  hosted on Railway; `github.com/pingdotgg/shoo` is "coming soon" and 404s.
- Its authorize dialect is exactly five parameters plus `pii=true`
  (`@shoojs/types` `AuthorizeRequest`). `response_type`, `scope`, `nonce`,
  `prompt`, `login_hint` and `max_age` are silently ignored. Code + PKCE S256
  only; no refresh tokens; `POST /token` and `POST /session/check` are the only
  CORS endpoints; JWKS and discovery serve no CORS; `frame-ancestors 'none'`.
- Official clients: `@shoojs/auth` 0.2.2 (`createShooAuth`, `startSignIn`,
  `handleCallback`, `checkSession`, `startSessionMonitor`, `clearIdentity`),
  `@shoojs/react` (`useShooAuth`), and the page include
  `<script src="https://shoo.dev/shoo.js">` which exposes `window.Shoo`,
  upgrades `<a href="https://shoo.dev/authorize?redirect_uri=…">` links with
  PKCE and state, finishes the callback on `/shoo/callback`, and stores the
  identity in `localStorage["shoo_identity"]`. Our Pages CSP is
  `script-src 'self'`, so the app speaks the dialect itself
  (`apps/pages/src/lib/federation.ts`) — nothing in it has to change.
- **Sign-out is local only.** `clearIdentity()` deletes web storage; there is
  no `end_session_endpoint` and no revocation endpoint (all 404). The
  `shoo_session` cookie on shoo.dev survives and is ended at `shoo.dev/me`.
  With a live Shoo session a new `/authorize` completes without showing
  Google; on a fresh one Shoo sends Google `prompt=select_account`.
- Shoo performs no MFA and exposes no `acr`/`amr`/`auth_time`; whatever second
  factor Google enforces is invisible to the relying party.

## Building and re-seeding

The artboards are generated from `_style.css` + `parts/*.html`, the same way
`docs/design/first-run-setup` is built:

```bash
cd docs/design/auth-flow
NODE_OPTIONS= node build.mjs     # parts/*.html + _style.css → *.dc.html
```

Then re-seed and republish to the same artifact URL with the design skill's
helper, listing every artboard and `canvas.json`. The seeded
`opensesame-authentication-flow.html` is gitignored (it is ~2 MB of editor
code, regenerated from the artboards above). Edit `parts/*.html`, never the
generated `.dc.html`, unless reconciling an edit made in the canvas editor.

## Decisions this canvas records

- **Two ledgers, one screen.** The account row sits above both tabs because
  the account is a fact about the device, not the vault.
- **Tabs are what was enrolled.** The header on disk is plaintext and already
  says which challenges exist; drawing all three protected nothing.
- **Step 2 is announced before step 1.** An authenticator code is part of the
  ceremony, not an ambush after it.
- **A code can only guard a key.** MFA is withheld beside a guest and written
  only once a code matches.
- **Sign out ends both halves of "who"** and locks; Lock alone keeps the
  account. Switch is sign out plus `prompt=login` on OIDC issuers — and an
  honest sentence about shoo.dev, which ignores the flag.
- **Every exit lands on the Sign in tab**, the one surface offering every
  configured way in (ADR 0078's allowlist), so there is no second sign-in
  surface to keep in step.

## Open questions

- Whether "Add an account" deserves an in-app sign-in sheet so it need not
  lock the vault on its way to the Sign in tab (drawn as the lock road).
- Whether to request `pii=true` from shoo.dev by default so the account row
  can show a name; drawn with PII off, naming the provider instead.
