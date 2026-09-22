# Android as a native surface — platform research and gap analysis

Research input for a future ADR (next free number: 0133). This document
records what Android and Chrome for Android let a third-party password
manager and identity product do as of 2026-09-22, grounds each capability in
what OpenSesame ships today, and proposes how to bridge the gaps. It is
research, not a decision record: where this document and an accepted ADR
disagree, the ADR wins.

The question under study: on an Android phone, OpenSesame should feel like
part of the platform. The installed PWA should open already knowing who the
person is. When Chrome (or any browser) offers to fill a password, suggest a
new one or sign in with a passkey, OpenSesame should be one of the things it
can offer, the way 1Password or Bitwarden are.

Platform facts carry a source link. Version numbers were read from Chrome
Platform Status, the Android developer docs and the Chrome developer blog on
the date above; items marked **(unverified)** rest on inference or secondary
sources.

## 1. What OpenSesame already has

**The installed PWA.** `apps/pages` is the installable GitHub Pages PWA
served at `https://tyler-r-kendrick.github.io/OpenSesame/`.

- Manifest: inline in `apps/pages/vite.config.ts:174-205`. It has `name`,
  `display: standalone`, `start_url`/`scope` `./`, and one SVG icon with
  `purpose: "any maskable"`. It has no `id`, no PNG icons, no `screenshots`,
  no `shortcuts` and no `share_target`.
- Service worker: `apps/pages/src/sw.ts`. It precaches, serves navigations
  network-first, and has handlers for Web Push and `notificationclick`.
- Install offer: `lib/install.ts`, per ADR 0085. It captures
  `beforeinstallprompt` and calls `navigator.storage.persist()` once the app
  is installed (`install.ts:331-373`).
- Web Push: `lib/push.ts` subscribes against the Identity API's VAPID key.
  **Nothing in the UI calls it**; the only importer is `sw.ts`.

**Who is signed in** is restored silently on launch.
- `saveSession` writes the upstream assertion to localStorage
  (`lib/federation-session-store.ts`, `lib/federation.ts:848-882`).
  `useAmbientAuthBoot` (`lib/ambient-auth/boot.ts:26-51`) re-verifies it
  against JWKS at boot.
- Ambient SSO acquisition (ADR 0125) is off by default. Silent acquisition
  works only for Entra (MSAL `ssoSilent`); it is unsupported for Shoo, the
  compiled-in Google broker (ADR 0125 §8).

**Which key opens the vault** is asked on every launch, and that is the
design.
- The vault key lives only in memory (`lib/vault/store.ts:391`).
- DESIGN.md says to "treat a reload re-locking the vault as correct
  behavior". It also forbids "a remembered device" shortcut around the master
  password.
- ADR 0125 §6: ambient admission never opens a locked vault.

**Passkeys.**
- The vault can be wrapped by a WebAuthn PRF passkey
  (`lib/vault/protection/adapters/webauthn-prf-ceremony.ts`). Its `rpId` is
  `location.hostname` (`lib/vault/unlock-methods.ts:448-503`). The ceremony
  is started by a button; it is never started automatically, never conditional,
  and there is no `autocomplete="webauthn"` anywhere.
- Browser-local IAM passkeys live in `lib/local-passkeys.ts` (ADRs
  0102–0112).
- `packages/sdk-browser` supports `mediation: "conditional"`
  (`authentication-service.ts:86-89`), but no app uses that client.
- There is no Signal API use and no `/.well-known/webauthn`.

**Vault data model.**
- The `login` type (`packages/vault-item-types/definitions/login.json`) has
  `uris`, `username`, `password` and `totp`. URIs carry a Bitwarden-style
  match mode (`lib/vault/website-pattern.ts`).
- No `androidapp://` URI form exists.
- The `passkey` type records `rpId`, the credential id and the public key
  only. There is no private key, so today the vault cannot *act* as a
  passkey; it can only record where one lives.
- The tomb format (AES-GCM blob in OPFS; ADR 0063) is implemented in
  TypeScript (`lib/vault/crypto.ts`, `store.ts`). `apps/pages` does not use
  the Rust `crates/client-core` / `crates/human-vault`.

**Native Android.**
- `apps/authenticator-native` exists: Kotlin/Compose on Multipaz 0.100.0,
  minSdk 29, targetSdk 36. It has App Links on `/invoke/`, OID4VP/OID4VCI
  schemes, and a `DigitalCredentialsActivity` that is a Credential Manager
  holder.
- Its README and ADR 0058 exclude "password, OTP, and passkey provider
  behavior".
- There is no `AutofillService`, no `CredentialProviderService`, no TWA, and
  no `assetlinks.json` anywhere in the repo.
- ADR 0129 already models a `device-local` protector ("platform keystore"),
  marked `requires-native-client`
  (`lib/vault/protection/adapters/device-local.ts`). Nothing implements its
  native side.

**Identity plane.**
- `apps/control-plane` reads `OPENSESAME_FEDCM_ENABLED` into
  `config-protocol-features.ts:35`, and nothing consumes it. There are no
  FedCM endpoints.
- `packages/openid4vp` builds Digital Credentials API requests for the
  control plane; Pages does not use it.

**Desktop precedent for "human plane only".**
- `apps/browser-extension` has no content scripts and no autofill, and it
  targets desktop Chrome and Firefox only.
- The pm-bridges (ADR 0052/0053) are desktop native-messaging and UDS
  bridges, default off.
- ADR 0052 sets the rule this document reuses: password-manager ecosystem
  surfaces are human/device plane only and never agent-facing.

## 2. What Android offers

| Capability | Platform floor | PWA alone? | Source |
|---|---|---|---|
| `AutofillService` (fill + save in apps and browsers) | Android 8 (API 26) | No: APK | [autofill-services](https://developer.android.com/guide/topics/text/autofill-services) |
| Inline suggestions in the keyboard | Android 11 (API 30) | No | same |
| Chrome delegates form fill to the Android autofill service ("Autofill using another service") | Chrome 135 stable, 2025-04-01; accessibility compatibility mode removed July 2025 | Chrome setting, APK provides the service | [Android Dev blog](https://android-developers.googleblog.com/2025/02/chrome-3p-autofill-services-update.html), [Chrome help](https://support.google.com/chrome/answer/142893?co=GENIE.Platform%3DAndroid) |
| Detect/deep-link Chrome's 3P mode (`AutofillThirdPartyModeContentProvider`, `ACTION_APPLICATION_PREFERENCES` on `com.android.chrome`) | Chrome 135+ | No | [autofill-services](https://developer.android.com/guide/topics/text/autofill-services) |
| `CredentialProviderService` — appear in the system passkey/password sheet | Android 14 (API 34) | No: APK | [credential-provider](https://developer.android.com/identity/sign-in/credential-provider) |
| Browsers as privileged callers (origin + `clientDataHash`, allowlist at gstatic) | Android 14 | No | [privileged-apps](https://developer.android.com/identity/sign-in/privileged-apps) |
| Single-tap biometric create/sign-in from a provider | Android 15 | No | [single-tap](https://developer.android.com/identity/sign-in/single-tap-biometric) |
| Passkey autofill in the web (conditional UI) | Chrome 108 | **Yes** (as RP) | [chromestatus](https://chromestatus.com/feature/5144633101778944) |
| Conditional create (silent passkey upgrade after password sign-in) | Chrome 142 Android | **Yes** | [chromestatus](https://chromestatus.com/feature/5135710007590912) |
| WebAuthn Signal API | Chrome 144 Android; reaches 3P providers on Android 14+ | **Yes** | [Chrome blog](https://developer.chrome.com/blog/signal-api-android) |
| `getClientCapabilities()` | Chrome 133 Android | **Yes** | [chromestatus](https://chromestatus.com/feature/5128205875544064) |
| Related Origin Requests (`/.well-known/webauthn`) | Chrome 128+ | Yes, but file at the RP ID's root | [web.dev](https://web.dev/articles/webauthn-related-origin-requests) |
| FedCM (as RP) incl. auto-reauthn, button mode | Chrome 108; button mode 132 Android | **Yes** | [chromestatus](https://chromestatus.com/feature/6438627087220736), [FedCM 132](https://privacysandbox.google.com/blog/fedcm-chrome-132-updates) |
| FedCM (as IdP) | same | Needs dynamic, cookie-bearing endpoints and `/.well-known/web-identity` at eTLD+1 root | [IdP guide](https://developer.chrome.com/docs/identity/fedcm/implement/identity-provider) |
| Digital Credentials API, verifier side | Chrome 141 | **Yes** | [Chrome blog](https://developer.chrome.com/blog/digital-credentials-api-shipped) |
| Digital Credentials holder | Android 6+ with Play services | No: APK (we have one) | [holder guide](https://developer.android.com/identity/digital-credentials/credential-holder) |
| WebAPK: scope URL capture, share target, shortcuts, notification actions | Chrome 71/76/84/48 | **Yes** | [web.dev WebAPKs](https://web.dev/articles/webapks) |
| Badging, `launch_handler`, `protocol_handlers`, `file_handlers` | desktop only | Not on Android | [badging](https://chromestatus.com/feature/6068482055602176), [launch_handler](https://chromestatus.com/feature/5722383233056768) |
| Trusted Web Activity + TWA↔native `postMessage` | Chrome 72; postMessage Chrome 115 | APK | [TWA](https://developer.chrome.com/docs/android/trusted-web-activity/), [post-message-twa](https://developer.chrome.com/docs/android/post-message-twa) |
| Quick Settings tile, home-screen widget, Keystore/StrongBox, `BiometricPrompt` + `CryptoObject` | various | No | [QS tiles](https://developer.android.com/develop/ui/views/quicksettings-tiles) |

Peers:
- Bitwarden, 1Password, Dashlane, Proton Pass and KeePassDX all ship a
  native `AutofillService`.
- All but Proton (unverified) also ship a `CredentialProviderService` for
  passkeys.
- KeePassDX refuses the accessibility-service fallback. Play policy now
  names password managers as ineligible for `isAccessibilityTool`
  ([policy](https://support.google.com/googleplay/android-developer/answer/10964491)).
- No PWA-first password manager was found shipping a TWA with an autofill
  service (**unverified**: absence of evidence).

The shape of the answer follows from the table. Everything OpenSesame does
as a relying party works from the PWA today. Everything that makes it look
like part of the platform — the fill chip over a login form, the system
passkey sheet, a biometric prompt, a Quick Settings tile — needs an APK.

## 3. Ambient identity: what "already authorized" can honestly mean

The unlock screen already separates two facts (ADR 0091): **who** is signed
in, and **which key** opens the vault. They have different answers on
Android.

**Who: close, but not native-feeling.**
- The account is already restored from localStorage on launch.
- What is missing is the Android moment where Chrome shows "Continue as
  <your Google account>" with no redirect. OpenSesame cannot get that from
  Shoo: it is a broker, not a FedCM IdP, and ADR 0125 explicitly rejects
  "treating Shoo as Google / FedCM".

The bridge is **Google as a direct issuer through Google Identity Services
in FedCM mode**.
- It needs Chrome 128+ on Android
  ([SIWG browsers](https://developers.google.com/identity/siwg/supported-browsers)).
- It works from a static site. The client id is public, and the `id_token`
  is verified in the browser against Google's JWKS, as `restoration.ts`
  already does for restored tokens.
- FedCM auto-reauthentication then signs a returning person in with no
  prompt at all.
- This is a new issuer on the ADR 0033 allowlist beside Shoo, not a change
  to Shoo's dialect, so it needs its own decision.
- A related cheap step: on a device with one known account, the front door
  should offer that account's sign-in road first, instead of the full panel.

**Which key: stays a gesture, but can become one touch.**
- A WebAPK is an ordinary Chrome task, and Android reclaims background tasks
  aggressively. So "reload re-locks the vault" (DESIGN.md) happens far more
  often on a phone than on a desktop, and that is most of what "not native"
  feels like.
- Keeping the vault key across process death would be exactly the
  "remembered device" DESIGN.md forbids. This research does not propose it.

What can be done instead, cheapest first:

1. **Put the passkey on the keyboard.**
   - Add `autocomplete="username webauthn"` to the identifier field.
   - When `PublicKeyCredential.isConditionalMediationAvailable()` is true,
     issue a conditional PRF `get`.
   - The enrolled passkey then appears in the Android keyboard suggestion
     strip as soon as the unlock screen has focus. One tap and a fingerprint
     unlock the vault, with no tab or button to find.
   - PRF under conditional mediation works with Google Password Manager
     passkeys; third-party providers vary
     ([PRF support survey](https://www.corbado.com/blog/passkeys-prf-webauthn),
     secondary).
   - The PRF ceremony already exists; only the mediation mode and the
     field's token are new.
2. **Default the unlock screen to the passkey key** when it is the enrolled
   method, and focus it. ADR 0091 already says the tabs are exactly the
   enrolled methods.
3. **Native device-local protector (ADR 0129).**
   - In the APK proposed in §5, wrap the vault key with an Android Keystore
     key: `setUserAuthenticationRequired`, StrongBox where present, and
     invalidated on biometric enrolment change.
   - Unwrap it through `BiometricPrompt` with a `CryptoObject`.
   - This is still an alternate wrap entered every time, so it satisfies
     DESIGN.md.
   - It is the protector the autofill service in §4 needs in any case.
   - Android 16's Identity Check forces biometric-only outside trusted
     places, which suits it
     ([report](https://idtechwire.com/google-extends-android-identity-check-to-enforce-biometric-only-app-access-outside-trusted-locations/),
     trade press).

**Auto-lock.** `vault/prefs.ts` defaults auto-lock to off. Once process death
stops being the de-facto timeout, an explicit idle lock becomes the real
policy and should be surfaced.

## 4. Autofill and password suggestions in Android browsers

**What it takes.** For Chrome, Firefox, Edge, Brave and native apps to offer
OpenSesame logins, Android needs an `AutofillService`. For the passkey and
password sheet (Android 14+), it needs a `CredentialProviderService`. Both
live only in an APK. On Chrome 135+ the person must also switch Chrome to
"Autofill using another service". The app can read that state and deep-link
to the toggle (§2). Samsung Internet reportedly no longer delegates to
third-party services (**unverified**: forum sources only).

**Nothing in the repo does this today.** `apps/authenticator-native` is the
natural home: one signing identity, one `assetlinks.json`, one Play listing.
But ADR 0058 scoped provider behavior out, so extending it is an amendment.

The design problems, in the order they bite:

1. **Headless vault access.**
   - The autofill and credential-provider services run with no UI and no
     browser tab. The vault lives in the PWA's OPFS inside Chrome, which the
     APK cannot read, even under a TWA.
   - The services therefore need their own ciphertext replica and their own
     key path:
     - **Replica.** Only while the PWA is open under the TWA, it pushes the
       sealed tomb to the APK over the TWA `postMessage` channel. That needs
       the `delegate_permission/common.use_as_origin` asset link, Chrome
       115+ and androidx.browser 1.6+. Only ciphertext crosses, the same
       invariant as ADR 0063's backups.
     - **Reader.** A Rust implementation of the tomb format, exported over
       UniFFI the way `crates/authenticator-core` already is. The format is
       TypeScript-only today, so it needs a written spec and shared test
       vectors that both implementations must decrypt. A second, divergent
       reader would be the classic way to lose a vault.
     - **Key.** The device-local protector from §3. A locked vault answers
       `FillResponse.setAuthentication` / Credential Manager
       `AuthenticationAction` with a `BiometricPrompt` activity. The service
       never stores a plaintext key.
2. **Write-back.**
   - Saving a new login from Chrome (`onSaveRequest`) or creating a passkey
     (`onBeginCreateCredentialRequest`) produces a change the PWA must
     adopt.
   - The low-risk shape is a sealed "pending captures" queue that Pages
     merges on next unlock, keyed by item path. This reuses the idempotent
     merge-by-path rule the manifest import already follows.
   - The native side never rewrites the tomb.
3. **Matching.**
   - Add an `androidapp://<package>` URI form to `login.uris`, beside the
     existing match modes.
   - Association rules: accept a web URI for an app only when the app's
     Digital Asset Links verify it. Fill a browser request only against the
     `origin` returned by `CallingAppInfo.getOrigin(allowlist)`, using
     Google's privileged-browser allowlist, and never against the page's
     self-reported domain.
   - Bitwarden warns that Edge, Opera and Samsung Internet can fill into a
     hidden iframe
     ([Bitwarden](https://bitwarden.com/help/auto-fill-android/)); the
     matcher should treat those as untrusted callers until verified.
4. **Being a passkey provider.**
   - The `passkey` item type would need a private key: a concealed field and
     a ceremony handler, which only a platform-published definition may name
     (ADR 0087). It would also need `hmac-secret`/PRF evaluation.
   - One circularity must be refused: a passkey whose PRF output unwraps
     this vault cannot be served from this vault. The flag on the item
     (`unlocksVault`) already exists to tell the two apart.
5. **Posture.**
   - The services are human/device plane, like ADR 0052's bridges, and never
     agent-facing.
   - No accessibility-service fallback: it is ineligible under Play policy,
     and the KeePassDX precedent points the same way.
   - No payment card autofill: ADR 0086 §6 keeps PAN/CVV out of scope.

**Interim, without an APK.** A WebAPK can register a `share_target`. Then
"Share → OpenSesame" from any Chrome page opens Pages filtered to that URL's
matching logins, with copy-to-clipboard. That is not autofill, but it is the
native Android gesture a PWA *can* own, and it needs only a manifest entry
and a route.

## 5. Packaging and the domain problem

**WebAPK or TWA.**
- A WebAPK (what "Install" produces today) gets launcher presence, scope
  URL capture, share target, shortcuts and push.
- A TWA wraps the same Pages build in the APK. It gains the native services
  in §3–§4 and the `postMessage` channel, and it keeps a single source of UI.
- The recommendation is a TWA inside `apps/authenticator-native`, with
  Bubblewrap-generated scaffolding checked in, not a second native UI.

**Every native road starts at the domain root.**
- `assetlinks.json` (TWA verification, App Links, `get_login_creds`,
  `use_as_origin`), `/.well-known/webauthn` and `/.well-known/web-identity`
  must all be served from the origin root.
- `github.io` is on the Public Suffix List, so the root of
  `tyler-r-kendrick.github.io` belongs to the user-site repository
  `tyler-r-kendrick/tyler-r-kendrick.github.io`, not to this project site.
- `https://tyler-r-kendrick.github.io/.well-known/assetlinks.json` returned
  404 when checked on 2026-09-22.
- Jekyll drops dot-directories unless `.nojekyll` is present.

**A related finding, independent of Android.** Every GitHub Pages project
site on the same account is served from the same origin as OpenSesame.
- Script on any of them can read the federation `id_token` in localStorage
  and the sealed tomb in OPFS.
- It can also request WebAuthn assertions for the vault's `rpId`, which is
  `location.hostname`.
- The tomb stays sealed, but the origin is not OpenSesame's alone. No ADR
  records this.

Two ways out:

- **(A) Serve `.well-known` from the user-site repo.** It is cheap. It
  bakes the shared-origin exposure into every native trust statement.
- **(B) Move Pages to a custom domain (recommended).** It gives a dedicated
  origin and a root OpenSesame controls. It has a migration cost:
  - Existing PRF passkeys are bound to `rpId = tyler-r-kendrick.github.io`.
    They stay usable from the new origin through Related Origin Requests,
    but that file is served at the *old* root, so (A) is needed once anyway,
    as a bridge.
  - OPFS does not move between origins. The existing export/import
    (`lib/vault/export`, `import`) is the migration road.

**Distribution.** Play requires target API 36 for updates after 2026-08-31,
which `authenticator-native` already meets. Android developer verification
applies to sideloaded installs on certified devices from 2026-09-30 in the
first regions
([blog](https://android-developers.googleblog.com/2026/03/android-developer-verification-rolling-out-to-all-developers.html)).

## 6. PWA-only improvements (no APK, no domain move)

Each of these stands on its own.

| Change | Where | Why on Android |
|---|---|---|
| Manifest `id`, PNG 192/512 icons (maskable + any), `description`, `screenshots` | `apps/pages/vite.config.ts:174-205` | Stable WebAPK identity across `start_url` changes; Chrome's richer install sheet uses screenshots. Whether the WebAPK minting server accepts an SVG-only manifest was not verified. |
| `shortcuts`: Lock, Search, Generate password, Scan code | same | Long-press launcher menu, Chrome 84+ |
| `share_target` + a filtered-logins route | manifest, `sw.ts`, router | §4 interim. Also accepts shared files as vault attachments (Level 2) |
| Conditional-mediation passkey unlock | `UnlockScreen.tsx`, `IdentifierField.tsx`, `webauthn-prf-ceremony.ts` | §3.1: unlock from the keyboard strip |
| Signal API on removing a passkey wrap or renaming the account | `lib/vault/unlock-methods.ts` | Keeps Google Password Manager and third-party providers from offering a dead passkey (Chrome 144+) |
| Turn on the dormant Web Push UI | `lib/push.ts` (no caller today) | Notification action buttons for ADR 0084 approvals. An action must open a window, because WebAuthn cannot run inside `notificationclick` (inference) |
| Default the unlock tab to the passkey when enrolled | `UnlockScreen.tsx:225-251` | One tap instead of two |
| Don't build: badging, `launch_handler`, `protocol_handlers`, `file_handlers` | — | Not implemented on Android |

Each row touching boot, unlock or chrome is covered by `verify:keyboard`,
`verify:mobile` and `verify:auth` (AGENTS.md §5). The conditional-mediation
change must keep the explicit passkey key and the guest road exactly where
they are.

## 7. OpenSesame as the ambient identity for other sites

The inverse of §3: other sites on the phone signing in *with* OpenSesame.

- **FedCM IdP.** The control plane is the only plane that can host one:
  dynamic `accounts` and `id_assertion` endpoints with cookies, plus
  `/.well-known/web-identity` at its eTLD+1 root. A static origin cannot, and
  ADR 0034 notes Pages holds no honest signing key.
  - The `fedcm` flag already exists and is unread
    (`config-protocol-features.ts:35`).
  - Implementing it would give relying parties Chrome's native "Continue as"
    sheet on Android for OpenSesame accounts.
- **Browser-local IAM** (ADRs 0102–0112) stays popup and `MessagePort`
  based. It is complete for SDK-integrated sites, but it cannot surface in
  any Android system UI.
- **Digital Credentials.** The holder side is already native
  (`DigitalCredentialsActivity`). Wiring `packages/openid4vp` into Pages
  would let the PWA act as a *verifier* through `navigator.credentials.get({digital})`
  (Chrome 141+), for example to accept an OpenSesame credential from the
  native wallet during a cross-device approval (ADR 0086).

## 8. Gap summary

| Want | Today | Gap | Bridge | Needs |
|---|---|---|---|---|
| PWA opens knowing who I am | Assertion restored from localStorage | No native "Continue as"; Shoo cannot do FedCM | GIS/FedCM Google issuer (§3) | ADR (issuer allowlist) |
| PWA opens unlocked | Re-locks by design; unlock is a button | Frequent re-lock after process death | Conditional passkey (§3.1), device-local protector (§3.3) | PWA change; APK |
| Chrome fills my logins | Nothing | No `AutofillService` | Service in `authenticator-native`, replica + Rust tomb reader + pending-capture queue (§4) | ADR 0058 amendment, tomb format spec |
| System passkey sheet lists OpenSesame | Nothing | No `CredentialProviderService`; passkey type holds no private key | Provider service + passkey item private key (§4.4) | ADR 0087 ceremony handler |
| Suggest a strong password in Chrome | Generator exists in-vault only | Chrome only asks its autofill provider | `AutofillService` save/generate path | APK |
| Native links, TWA, `use_as_origin` | No `.well-known` anywhere; root 404 | Project-site origin | Custom domain + one-time ROR bridge (§5) | Domain decision |
| Install feels native | SVG-only manifest, no shortcuts or share target, push dormant | Manifest and UI | §6 | PWA change |
| Sites sign in with OpenSesame on Android | Popup IAM; FedCM flag unread | No IdP endpoints | FedCM in control plane (§7) | ADR |

## 9. Proposed sequence

Each phase ships on its own and is useful without the next.

1. **PWA polish (§6).**
   - Manifest identity, icons, shortcuts, share target, and a conditional
     passkey unlock.
   - Signal API and the Web Push UI.
   - No ADR is needed except a line in ADR 0085 for the manifest.
2. **Origin decision (§5).**
   - Pick (A) or (B).
   - Record the shared-origin finding under `docs/security/`.
   - Serve `/.well-known/{assetlinks.json,webauthn}`.
3. **Ambient Google (§3).** A GIS/FedCM issuer beside Shoo, with its own
   ADR against ADR 0033/0125.
4. **Native shell.**
   - Amend ADR 0058.
   - Add the TWA launcher to `authenticator-native`.
   - Add the device-local Keystore protector (ADR 0129), the `postMessage`
     replica, and a tomb-format spec with a UniFFI Rust reader and shared
     vectors.
5. **Autofill (passwords, TOTP).**
   - `AutofillService` with inline suggestions, Chrome 3P-mode detection and
     deep link.
   - `androidapp://` URIs and the pending-capture queue.
6. **Credential provider (passwords, then passkeys).** A
   `CredentialProviderService` with the privileged-browser allowlist and
   single-tap biometric; passkey private keys in the vault.
7. **OpenSesame as FedCM IdP (§7).**

## 10. Decisions this research leaves open

- **Custom domain or user-site repo** for `.well-known`, and what to do
  about the shared github.io origin in either case.
- **One native app or two.** Folding autofill and provider into
  `authenticator-native` keeps one signing identity. It also makes the
  wallet app a password manager, which ADR 0058 deliberately avoided.
- **Google as a first-class issuer** beside Shoo, given ADR 0033's
  production allowlist.
- **Where passkey private keys may live.** The vault, sealed like any
  concealed field, versus a native-only store the PWA never sees.
- **Idle lock default** once process death stops being the effective
  timeout.
