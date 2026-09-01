# ADR 0091 — Two ledgers on one screen: the account, the key, and the roads out

- Status: Accepted
- Date: 2026-09-01
- Supplements: [ADR 0033](0033-federated-identity-admission.md) (identity before
  sealing; federation never decrypts the vault), [ADR 0034](0034-origin-brokered-static-site-signin.md)
  and [ADR 0052](0052-federated-first-sign-in-surfaces.md) (the shoo.dev leg),
  [ADR 0078](0078-external-idp-as-identity-service.md) (setup's allowlist is the
  sign-in screen), [ADR 0089](0089-device-vault-switching.md) (several vaults on
  one device)

## Context

A device knows two separate things, and the app kept them in two separate
places without ever saying so on one screen:

1. **Who is signed in** — the Identity session (bearer plus an HttpOnly cookie)
   and the upstream assertion federation saves in web storage: a Google account
   through shoo.dev, an operator's IdP, an org's SSO, a guest principal.
2. **Which key opens the vault** — the passkey, PIN or password wraps in the
   plaintext header on disk, and, when enrolled, an authenticator (TOTP) gate
   sealed under the vault key.

Three things were broken in the flow, none of them in the crypto:

- **The configured unlock methods were not the unlock screen.** A returning
  vault always drew three tabs — Passkey, PIN, Password — on the theory that
  which challenges exist is the person's own knowledge. But the header is
  plaintext in OPFS and already says which; hiding it protected nothing and
  cost the person their own configuration. Worse, the authenticator code they
  enrolled appeared nowhere until it was sprung after the key.
- **An authenticator code could be enrolled with nothing to guard.** A guest
  session — the road every federated first sign-in takes (ADR 0033 §4) — has no
  key wrapped to disk. "Enroll MFA" wrote `unlocks.totp` alone to the header,
  which produced a vault with a gate and no wrap: three tabs that all fail, and
  no step ever asks for the code. The gate was also written before anyone had
  proved the QR scan worked.
- **There was no sign-out, and no way to be somebody else.** Inside the app the
  only exit was Lock, which by design keeps the account. The one "Sign out"
  link lived on the unlock screen's Sign in tab, ended the Identity session,
  and left the shoo.dev assertion in `localStorage` — so the device still
  counted as signed in on the next load. The `who@vault:/` prompt switched org
  profiles and nothing else.

shoo.dev's own shape constrains the answer ([research summary in
`docs/design/auth-flow/README.md`](../design/auth-flow/README.md)): sign-out is
local only (`clearIdentity`; there is no `end_session_endpoint`, no revocation
endpoint), the broker keeps its own Google session and ends it only at
`shoo.dev/me`, and `/authorize` ignores `prompt`, `login_hint` and `max_age`.
Every OIDC issuer, by contrast, must honour `prompt=login` (Core §3.1.2.1).

## Decision

1. **The unlock screen states both ledgers.** Above both tabs, an account row
   (`screens/unlock/AccountRow.tsx`, model in `lib/account.ts`) names who is
   signed in — a name or address when the person consented to PII, otherwise
   the provider's account ("Google account"), the broker ("via shoo.dev") and
   the principal's last four characters, never a raw subject — with **Switch**
   and **Sign out** beside it. It is absent when nobody is signed in. The same
   row heads the account menu inside the app.

2. **The unlock tabs are exactly the enrolled methods**, read from the header
   the way Settings already reads them (`listAvailableUnlockMethods`). When an
   authenticator code is enrolled, a two-segment step rail — *1 · Key*,
   *2 · Authenticator code* — is drawn before the first step is taken, and the
   code field is step 2 of the same ceremony. A vault whose header carries a
   gate but no primary wrap is said out loud ("nothing here can unlock it;
   delete it and seal again, or continue as a guest") rather than drawn as
   tabs that fail. The store's rule that an unenrolled challenge fails like a
   wrong one, lockout included, is unchanged.

3. **Enrolling an authenticator code needs a key first and a code second —
   and asks for both in one ceremony.** `beginTotpEnrollment` refuses a
   guest session or a header with no primary method; `confirmTotpEnrollment`
   writes the gate only once a code from the app matches;
   `cancelTotpEnrollment` and `lock` discard the offered seed. In Settings,
   "Enroll MFA" is never withheld: on a keyless vault (a guest, or a
   federated first sign-in) it opens step 1 — *set a key*, with a PIN,
   password or passkey form right there — and step 2, *scan and confirm*,
   begins on its own the moment the key exists. A person who came for a
   second factor is walked into the first, not sent to find it. The whole
   road — guest → key → code → lock → key → code → open — is driven in a real
   browser by `pnpm --filter @opensesame/pages verify:auth`.

4. **Sign out is one operation** (`lib/session-exit.ts`): forget the upstream
   assertion, drop any link waiting on an unlock, revoke the Identity session,
   lock the vault, and leave a one-shot note that opens the unlock screen on
   its Sign in tab and says "Signed out of this device." Lock keeps the
   account, as before; "Sign out of Identity too" stays the strict preference.

5. **Switch account is sign-out with the next sign-in armed.** The note says
   "choose the account to sign in with", and whichever way in is taken next
   carries `prompt=login` on every OIDC issuer — the operator's IdP, org SSO,
   the Identity API's hosted page. On Shoo's dialect the flag is **not sent**
   (it would be ignored, and the dialect stays exactly what `shoo.js` sends):
   shoo.dev answers with the Google account it remembers, and a different one
   means signing out at shoo.dev/me first. The screen says so.

6. **Add an account is the old "sign in beside a session", named for what it
   does**: the session stays, the vault locks, the Sign in tab opens, and the
   returning leg links the new identity to the principal that is still signed
   in (`adoptFederatedIdentity`). Whether a returning identity resumes its own
   principal or is refused as already bound follows the existing admission
   rules (ADR 0033, ADR 0052, ADR 0055) unchanged.

7. **The account menu carries the exits.** The `who@` segment's menu names the
   account at the top, keeps the org profiles in the middle, and ends with
   *Add an account…*, *Switch account…* and *Sign out* (a guest gets *Sign
   in…* and *Sign out*). Every exit lands on the same Sign in tab, which is the
   one surface offering every configured way in.

## Consequences

- Capabilities `identity.signout` and `identity.switch_account` are registered
  on the PWA (and the CLI's `opensesame-id logout` for the first), excluded
  from every agent surface as authentication ceremonies (ADR 0023). Tutorial
  goals `identity.sign-out` and `identity.switch-account` point at the new
  `shell.account` target; `unlock.account` names the row on the unlock screen.
- The shoo.dev leg is byte-for-byte what it was: the five authorize parameters
  plus `pii`, the `localStorage` records with their ten-minute PKCE ceiling,
  `POST /session/check` after the exchange. `prompt` is added only on the OIDC
  branch of `beginSignIn`, and a test pins the Shoo query to exactly its five
  keys.
- The unlock screen now reads the plaintext header to draw its tabs. This
  discloses to someone holding the device which challenges exist — which the
  file on disk already disclosed to anyone who opened DevTools. What it no
  longer discloses is nothing; what it gains is the configuration the person
  set up, shown back to them.
- A vault bricked by the old enrollment path is not repaired (there is no
  wrap to repair it with); it is named, and the roads that still work — guest,
  delete and seal again — stay beside it.
- The guest road is untouched on every surface (AGENTS.md §5): it is a peer on
  the Sign in tab, the front door and the Unlock tab's foot, and a guest's
  menu keeps *Sign out*, which ends the provisional session and locks.

## Design record

The canvas at [`docs/design/auth-flow/`](../design/auth-flow/README.md) draws
the unlock screen with both ledgers, the account menu, the enrollment
ceremony, the flow map, and today's screen beside the redraw.
