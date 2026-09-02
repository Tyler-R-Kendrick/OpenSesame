# Authentication flow — design canvas

Design record for [ADR 0091](../../adr/0091-account-exits-and-unlock-ceremony.md):
the Pages vault's unlock screen redrawn to state both things a device knows —
**who** is signed in and **which key** opens the vault — with the roads out of
an account that the app never had (sign out, switch account, attach another),
and an authenticator-code enrollment that can no longer brick a vault.

Published canvas:
<https://claude.ai/code/artifact/c1b6217c-62d1-4ba9-8d0d-af5d83ed2b66>

## Artboards

Three pages. The first is the second draft of the configuration surface: the
first draft drew a form under every method row and a second PIN form under the
MFA row, and was thrown out for it.

| File | Page | What it shows |
|------|------|---------------|
| `Security.dc.html` | Security settings | **Live.** Settings › Security on a 390 phone: three panels — Unlock methods, Second step, Recovery — each a list of `.sw` rows (the row the Settings page already uses for its switches) with a state chip and exactly one action. No row holds an input. Tweaks: keyed or guest vault, authenticator on or off, an Identity API present or not. |
| `AddKey.dc.html` | Security settings | **Live.** The one sheet, opened for a key. The `CeremonyShell` card (what is being added, its facts, the fields, the one action inside the card) with the other two keys as alternatives under the rule; picking one swaps the card. Tweaks: which key, a raw-IP host (the passkey card turns attentive), the Change view (new PIN or password, with Remove and the other keys as alternatives) and the Remove view — a confirmation in the same card, withheld on the last key with the other keys offered right there. |
| `AddAuthenticator.dc.html` | Security settings | **Live.** The same sheet for the authenticator: key (only for a keyless vault — the same card `AddKey` shows, not a second form) → scan → confirm → recovery codes shown once. Type `000 000` to see a refused code. Tweak: keyed, on (opened from an enrolled row's Remove: the confirmation card, naming what stops and which recovery codes go with it). |
| `AddCode.dc.html` | Security settings | **Live.** The same sheet for an email or text code: the NIST notice first, the address offered from the account as a field fill, send, confirm with the first code. Tweak: channel. |
| `Recovery.dc.html` | Security settings | Recovery codes from the Recovery row: used ones struck through, copy, download, regenerate as an alternative. |
| `Desktop.dc.html` | Security settings | The list and the sheet side by side at 1180: the sheet slides in beside the list, which stays readable and dimmed. |
| `Main.dc.html` | Unlock and account | **Live.** Unlock on a phone: the account row above both tabs, the step rail an enrolled second step earns, tabs for exactly the enrolled keys. |
| `UnlockSecond.dc.html` | Unlock and account | **Live.** Step 2: tabs for exactly the enrolled second steps (authenticator, email, text) in the same vocabulary step 1 uses for keys, and a recovery code as the way out. Tweaks: which fallbacks are enrolled. |
| `SignIn.dc.html` | Unlock and account | The Sign in tab beside a sealed vault with an account already signed in. |
| `AccountMenu.dc.html` | Unlock and account | Inside the app: the `who@vault:/` prompt with its menu open — the account named at the top, org profiles, and the three exits. |
| `Flow.dc.html` | Flow | The whole flow on one page: the *who* lane and the *key* lane, each with its own exit. |
| `Today.dc.html` | Flow | Today's unlock screen beside the redraw. |
| `canvas.json` | | Three pages, layout, sticky notes, launch view. |

## What the second draft reuses, and the one thing it adds

Nothing on the Security page is new vocabulary:

- **Rows** are `.sw` / `.sw__name` / `.sw__sub` (`styles.css`), the Settings
  switch row, with a `.chip` for state and one `.btn.btn--sm` for the action.
- **The sheet** is `.sheet-layer` / `.scrim` / `.sheet` / `.sheet__head` /
  `.sheet__mark` / `.sheet__grow` / `.sheet__body` / `.sheet__foot` — the
  side sheet `ConnectivityBar` opens for a connection ceremony.
- **The card** is `CeremonyShell` (`.found`, `.found__top`, `.found__name`,
  `dl`, `.found__do`) with `.or` and `.alt` for the alternatives, which
  expand or swap in place and never navigate.
- **Fields** are `FieldShell` (`.f`, `.f__labelrow`, `.f__label`, `.f__shell`,
  `.f__lead`, `.f__input`, `.f__tail`, `.f__fills`, `.fill`) with the status
  chip beside the label, never inside it.
- **The rail** is `.steps`, the same one the unlock screen draws.
- **Icons** are the app's own (`icons.json` is lifted from
  `components/Icons.tsx`; `build.mjs` stamps `@icon(name, size)`).

The one addition is `.codes`, a two-column list for ten recovery codes, which
had no incumbent shape.

## What the reference products settle

Bitwarden, 1Password, Google, GitHub, Microsoft and Apple were read for the
anatomy of their two-step pages (vendor docs and, for Bitwarden and GitHub,
their source). What they agree on, and this canvas follows:

- The list is read-only state: icon, name, one line, a state, one action.
  The form lives only inside the ceremony the action opens, one at a time,
  and every method wears the same shell.
- Verify before commit: a method is never on because it was captured; a live
  code from it (or a key touch) turns it on, and a change to an existing method
  takes effect only after a code from the new one.
- Recovery codes are their own single-instance section, shown once at the first
  second step (GitHub makes saving them a step; so does this), viewable and
  regenerable later, and regeneration invalidates the old set.
- Fallbacks are last and labelled. NIST SP 800-63B calls PSTN (SMS, voice)
  codes *restricted* and rules email out for out-of-band authentication; the
  products that keep them put them at the bottom with a notice before binding.
  Here they are offered only when an Identity API exists to send them, with the
  notice in the sheet before the address is asked for, and the authenticator
  stays the first choice at unlock.
- A re-authentication gate precedes a change. For a local vault the unlock is
  that gate: Settings is reachable only unlocked, and the key is in memory.
- The last key cannot be removed (Apple refuses the last trusted number; so
  does this).

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
- **Tabs are what was enrolled**, at step 1 (keys) and at step 2 (second
  steps) alike. The header on disk already says which.
- **Step 2 is announced before step 1.** A second step is part of the
  ceremony, not an ambush after it.
- **A code can only guard a key.** A keyless vault asking for a second step is
  walked through the key first, in the same sheet, with the same card
  `Add a PIN` shows — never a second form.
- **Nothing turns on until a code from the new method matches**, and the seed
  or address is written only then.
- **Sign out ends both halves of "who"** and locks; Lock alone keeps the
  account. Switch is sign out plus `prompt=login` on OIDC issuers — and an
  honest sentence about shoo.dev, which ignores the flag.

## Verified in a browser

`pnpm --filter @opensesame/pages verify:auth` drives the built bundle in
headless Chromium through both roads on the canvas — guest → key → code and
password → code — including lock, reload, a wrong code, and the unlock
screen's tabs and step rail. Screenshots land in `artifacts/auth-flow/`.

## Open questions

- Whether "Add an account" deserves an in-app sign-in sheet so it need not
  lock the vault on its way to the Sign in tab (drawn as the lock road).
- Whether to request `pii=true` from shoo.dev by default so the account row
  can show a name; drawn with PII off, naming the provider instead.
