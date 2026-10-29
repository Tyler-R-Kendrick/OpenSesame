# Design rules that gate merges — full text

Full prose moved from `AGENTS.md` §5. `AGENTS.md` §5 keeps the one-line invariants and ADR links; this page preserves the rationale, history, and exact gate triggers. Where this page and a cited ADR disagree, the ADR governs.

## 5. Design rules that gate merges

- **A user-visible change ships with before/after evidence on the pull
  request.** A reviewer must never have to clone the branch, install, build and
  walk the app to find out whether a change helped, and "I ran it and it looks
  good" is a claim about a screen nobody else saw. Any diff a person could
  notice — CSS, a component, a screen, layout, chrome, on-screen copy, an icon,
  an empty or error state, a focus ring — carries images captured from **two
  real builds**: the base branch's and this one's, walked the same way, at
  phone and desktop width. Every pair carries a measurement taken from the
  browser (`statusline 99px, wrapped → 49px, one row`), never an impression.
  Keep before/after captures, comparison sheets, raw recordings and review
  drafts in ignored `work/evidence/` or the system temp directory. Persist only
  approved evidence of the current implementation in the stable slot
  `docs/evidence/<feature>/<project>/<platform>/`, using lowercase kebab-case
  names (for example `docs/evidence/unlock/pages/web/`). A branch replaces the
  impacted slot's approved files and removes superseded assets; it never adds
  a dated, branch-named or numbered history folder. Keep unrelated slots intact.
  Record the source revision, capture method, checks and approval provenance
  beside the approved artifacts; a rename or a passing capture is not approval.
  The default branch carries the latest approved state only. Git history and
  commit-SHA links preserve earlier evidence; never restore historical media
  into the current workspace merely to compare it. Put comparison measurements
  and review artifact links in the PR under `## Visual evidence`, and link the
  approved current-state gallery by commit SHA. Read the PR back to check its
  markup. The canonical persistence contract is `docs/evidence/README.md`.
  Never stage a screenshot or crop away the thing you changed, and where a visible change genuinely cannot be captured, say so in
  the PR and name what you verified instead — silence reads as "nothing to
  see". Procedure and tooling: `skills/visual-evidence/SKILL.md`,
  `apps/pages/scripts/capture-evidence.mjs`.
- **Local app runs are attached HMR debug sessions.** "Run it locally",
  "start the app", or "let me test" means: keep the Vite (or other) dev
  server as a long-lived attached process, open that origin in a
  browser/debug session, and watch console errors, page errors, and failed
  requests with full stacks. Fix against the hot-reloaded session; do not
  kill it to run a production `dist/` or a headless `verify:*` harness
  unless that gate was the request. Pages UI without a backend is
  `pnpm dev:pwa` on `:5180`. Procedure:
  `skills/local-debug-session/SKILL.md`.
- **Keyboard access is a core product contract, not optional polish.** Every
  arrival (cold load, reload, guest/unlock, deep link, route change and modal
  close) must leave visible, useful focus. Never steal focus from an active
  user. Native links/buttons retain Enter/Space behavior; form controls,
  tabs and menus retain their own keys. Global shortcuts must not swallow
  native activation. Tab/Shift-Tab must reach and leave both trees and every
  visible enabled control; only an active modal may contain focus. F6 is the
  listing-switch shortcut, never a replacement for native Tab navigation.
  Escape leaves a text field for its parent pane before closing a closable
  pane. Preserve vim/tree arrows, counts, section chords and guest access.
  Changes to boot, routing, shell, controls or focus require
  `pnpm --filter @opensesame/pages verify:keyboard` against a fresh Pages
  build, at desktop and mobile widths. This keyboard-only browser journey
  must start at page load without clicks, injected focus, synthetic keydown
  events or mocked keymap registrations. Handler spies and snapshots alone
  are not regression proof. Include saved-vault reload/unlock and immediate
  movement from empty and populated vaults; guest entry alone is insufficient.
  It also Tabs onto a settings file's textarea and asserts the stage's focus
  cue shows (`apps/pages/scripts/lib/settings-file-keyboard-contract.mjs`). Keep this gate in the mandatory prerelease browser
  suite; demonstrate failure before fixing a regression and success afterward.
- **A phone is not a narrow desktop, and the touch rules are gated on width as
  well as pointer.** The 44px floor, the 16px field floor that keeps iOS from
  zooming a focused field and never zooming back, the single-row statusline,
  the safe-area insets and the landscape arrangement are all measured by
  `pnpm --filter @opensesame/pages verify:mobile` against a fresh Pages build,
  at 320, 390, 430 and landscape, with a settings file open at each. Changes to
  the shell, the chrome, any shared control, or any block under
  `(pointer: coarse)` require it. A screenshot is
  not evidence: the gate measures computed geometry in a real touch context
  and fails closed if that context is lost. Keep it in the mandatory prerelease browser
  suite. Never satisfy it by clipping a control, hiding a road, or
  lowering a floor — DESIGN.md § Touch is the contract it enforces.
- **Browser-local IAM must prove an actual application sign-in.** Changes to
  local identity sessions, application grants, popup transport or consent
  require `pnpm --filter @opensesame/pages verify:local-iam` against a fresh
  Pages build, alongside the focused IAM tests. This mandatory prerelease
  check uses separate browser origins, real encrypted storage and virtual
  WebAuthn, with keyboard-only explicit consent, session check, revocation
  and denial at desktop/mobile widths. A registration form or mocked success
  is not authentication evidence. Keep exact-origin/source binding, PKCE,
  human-only consent and scoped opener headers; never widen model authority
  to make the flow pass. Browser-local identity is not a hosted OIDC service.
- **Web Push is proved against a real Identity API.** Changes to push
  enrolment, the push worker or its controller, the Identity API's push routes,
  the Web Push adapters or the Host's delivery require
  `pnpm --filter @opensesame/pages verify:push-worker` and `verify:push`
  against fresh builds (`build:push-verify` for the second). `verify:push` is
  its own mandatory prerelease job, and runs
  for the server code it exercises as well as for Pages. A push worker that is
  only ever shown to a mocked enrolment, or a walk that nudges the browser, is
  not evidence.
- `@opensesame/os-domain` **must not** import Better Auth, oidc-provider,
  Hono, Drizzle, or React (see CONTRIBUTING.md).
- Prefer mature libraries over NIH protocol code —
  [ADR 0008](../adr/0008-better-auth-oidc-provider.md).
- Do not add Clerk/Marketplace auth as core —
  [ADR 0004](../adr/0004-no-vercel-marketplace-for-core.md) (Vercel
  Marketplace *hosting* for previews is fine; auth is not).
- Identity API and Host API stay separate — no BFF merge —
  [ADR 0017](../adr/0017-host-client-product-topology.md).
- Record consequential decisions as ADRs under `docs/adr/`, numbered in order;
  `docs/adr/README.md` is the generated index of what exists.
- **The static front end is complete without a backend**
  ([ADR 0090](../adr/0090-static-frontend-complete-without-backend.md)).
  `apps/pages` is a broker, and nothing — no operator ceremony, no Identity
  API, no Host, no daemon, no localhost — may be placed in front of its first
  screen. On a device with no vault and no setup record that screen is the
  **front door** (`screens/FrontDoor.tsx`,
  [ADR 0115](../adr/0115-front-door-and-connector-directory.md),
  [ADR 0150](../adr/0150-live-sessions-browser-to-browser.md) §1): the
  wordmark at hero scale and three roads made large — **Set up your
  own**, **Join a session** and **Import a file**
  ([ADR 0188](../adr/0188-a-vault-can-begin-from-a-file.md): a backup or a
  `.env` file is held, unread, in `lib/vault/pending-import.ts` while the vault
  is sealed, and the Import key opens its sheet on it) — with the guest road
  as the card's corner **Skip**. The door asks no sign-in question: a device
  with no vault has nothing to sign in to. Join is on every deployment, the shared GitHub
  Pages origin included: it opens a live session browser to browser over
  WebRTC, paired automatically through a sealed-code ntfy.sh carrier by
  default, with the manual request/reply codes as the fallback when no carrier
  is ready (`sharing.live`, `lib/live/`, consent first); an owner may replace
  the carrier in Settings › Live sessions › Routes and may name a tunnel
  address, STUN/TURN, relay only, or a Nostr/MQTT/NATS/ntfy carrier, and the
  joiner sees every host before any is contacted. An open session admits at
  once; invite sessions still wait for the owner's compare —
  and a Host invite link still opens the Host ceremony
  ([ADR 0136](../adr/0136-join-a-session-restored.md));
  a shared link opens join by itself. Once setup is answered or skipped the
  sign-in screen — the compiled-in Google-via-Shoo road and the local-only
  seal ("Use without an account") — is the first screen, and setup lives behind unlock
  (Settings), not as quiet foot links. The one thing a gate may draw beside
  its own chrome is a **help key** (`tutorial/gate-seat.tsx`,
  [ADR 0166](../adr/0166-gate-help-launcher.md)): a single icon key in the
  screen's chrome row, never in front of its content, its roads or the guest
  Skip, offline, opening the same Support sheet with only the tutorials written
  for that screen. No `setupRequired` gate on the setup record exists
  (`setup.test.ts` pins it) and none may come back. No
  default may point at a local host: `packages/app-core/src/lib/settings.ts` defaults are empty on
  every origin, and `127.0.0.1` addresses are suggestions a loopback tab may
  offer, never something the app assumes. With no Identity API configured a
  guest or federated sign-in is complete, not pending — no notice may name a
  service that is not there. A screen is gated on what it actually needs, one
  panel at a time (`useIdentityServes`, `useIdentityConfigured`; `useHostConfigured`
  in `apps/pages/src/lib/use-configured.ts` is a shim that always returns false,
  ADR 0128), never on "a backend":
  Access › Resources is Identity-plane and local-only, Sessions' receipts are
  Identity-plane, and gating those on a Host hid features that need none. A
  deployment that asks nothing may never report that something failed.
- **Nothing the client stores rests in the clear**
  ([ADR 0149](../adr/0149-nothing-stored-in-the-clear.md)). Every value
  written through the ports' `local`/`session` stores, `kv.ts` (OPFS),
  travel storage or `history-backup-idb.ts` is sealed under the host's
  at-rest key (`packages/app-core/src/lib/at-rest/`; a non-extractable
  IndexedDB key in a browser, a 0600 `at-rest.key` for the CLI) and bound
  to its store and name. Never write a browser global (`localStorage`,
  `indexedDB`, `navigator.storage`, `document.cookie`) directly, and never
  hand a third-party library a persistent browser store: MSAL runs on
  `memoryStorage` and runs no redirect or popup flow. With no durable key
  nothing reaches disk; do not add a plaintext fallback. Outside Pages — the
  extension, `client-core`'s sync store, `sdk-browser` and `static-auth` on a
  relying party's origin — values seal through `@opensesame/browser-at-rest`.
  `verify:static` reads the origin raw and fails on any app-owned value that
  is not `osr1.`.
- **A database that holds identifiers hides its shape too**
  ([ADR 0175](../adr/0175-searchable-encryption-over-indexeddb.md)). A
  readable index field, store name or record id is a name, whatever is sealed
  beside it. A new IndexedDB store of ids, names or principals is an encrypted
  database (`packages/app-core/src/lib/encrypted-db/`): one store `r`, one
  multi-entry index `x`, rows sealed under keys derived from the device key,
  searchable only through the layers its schema declares and built on the first
  query that needs them. Never add a store or index whose name says what it
  keeps, never index a digest or a secret-derived value (a shared entry shows
  reuse), and add the logical name to `EDB_LOGICAL_NAMES` so Reset derives it.
  The two existing stores answer through `HistoryRowStore` and
  `PasswordDigestStore`, which the optional `storage.encrypted-search`
  capability points at encrypted databases; the capability's module is the
  only importer of the library.
- **Logs and events carry no secrets, by key or by shape**
  ([ADR 0157](../adr/0157-logs-and-events-carry-no-secrets.md)). Redaction
  by key name alone misses a bearer in an error message, a `#token=` in a URL,
  a JWT in a stack trace and a DSN with a password in it, so every log line,
  event, audit row, activity entry and persisted failure passes the shared
  scrubber (`spec/log-scrub/log-scrub.json`, run by `@opensesame/log-scrub` and
  `crates/redaction` against the same vectors). Add a shape by adding a rule
  and a vector to the spec, never to one target. Log through `createLogger`
  (TypeScript) or a subscriber whose writer is `ScrubMakeWriter` (Rust); never
  `console.*`, a hand-built `pino(...)` or a bare `tracing_subscriber::fmt()`.
  `pnpm quality:log-hygiene` counts those and the ledger only falls. A struct
  holding a secret never derives `Debug`: write `impl fmt::Debug` and print
  `[REDACTED]` for it; `scripts/lib/secret-debug.test.mjs` (in `pnpm quality`) fails on a
  derived `Debug` over a field named like a credential. Log an id, never the secret.
- **Logs and events rest sealed** (ADR 0157 items 7–9). A log file a process
  writes goes through `crates/sealed-log` / `packages/observability`'s sealed
  destination (`OPENSESAME_LOG_FILE`); a new event or audit column the Host
  writes is sealed through `opensesame-event-seal` and read back through it (add
  it to `SEALED_COLUMNS` in `crates/storage/src/sealed.rs` so the legacy sweep
  reaches it); a new Identity event payload goes through `withSealedEvents`.
  Never write an event or a log line to disk in the clear, and never add a
  plaintext fallback: a configured sealed sink that cannot open refuses to
  start. The event keys derive from secrets the deployment already holds
  (`docs/operators/log-and-event-sealing.md`).
- **An authorization check is a proof the compiler can see**
  ([ADR 0178](../adr/0178-authorization-checks-are-proofs-the-compiler-can-see.md)).
  In the TypeScript plane, a function that needs "this actor owns this
  organization / holds this project role / is a verified principal / may write
  these shares" takes a `@gdp-ts/core` proof about the exact `Named` values it
  touches, minted only by a module under `proofs/` (`defineProof` is private to
  it and never exported). The checker returns a *verdict* (`proof | refusal`) so
  the route keeps its own status and message and the wire does not change. Do not
  write another `requireOwner`/`assertVerified`/`roleFor` that returns a boolean
  or a bare id; do not forge a proof with `as` (the Oxlint preset in
  `oxlint.config.ts` fails it); do not add a flag such as `bypassAccessCheck`
  where a `SystemShareWrite`-style typed choice belongs. Each proof gets a
  `*.mistakes.ts` of `@ts-expect-error` lines proving misuse does not compile,
  and tests obtain proofs from the real prover, never a cast. Where call sites
  disagree, name each behavior as an option and pin it; do not unify silently.
- Never expose raw secrets, private proof keys, or a public `getSecret()`
  affordance. Agent-facing APIs use ConnectionRef + Intent
  ([ADR 0005](../adr/0005-authority-handle-connectionref.md)).
- **Never remove or hide the guest/anonymous access flow** from the Pages
  sign-in and unlock screens — the one exception is the operator's own
  "Allow guests" switch in Settings › Features
  (`packages/app-core/src/lib/guest-access.ts`, default on, fails toward on,
  turned off only by the device's operator, back on by anyone signed in but
  a guest; ADR 0135). Every placement reads it through
  `apps/pages/src/screens/unlock/GuestRoad.tsx`, `openGuestVault` refuses a
  guest session while it is off, and the last-vault pointer and vault list
  stop offering the guest tomb. It lives in two places and both are
  required: the front door's corner "Skip" (`screens/FrontDoor.tsx`, the
  door's one guest road, where a `/guest` link lands) and "Skip to the guest
  vault" in the unlock form's footer in
  `apps/pages/src/screens/unlock/UnlockFoot.tsx`, beside a sealed vault, including
  a guest tomb that enrolled a key. It is not drawn on the sign-in panel, and
  not beside a keyless guest tomb, where Unlock resumes that tomb and a second
  guest control would duplicate it. The sign-in panel
  (`screens/unlock/SignInPanel.tsx`) carries no guest road of its own: its
  single no-account road is "Use without an account", the local-only seal
  offered on first run (a full-size "Continue as guest" button, a corner guest
  Skip on that panel, and the unlock footer's old "Continue as guest" label
  were removed as duplication, 2026-10). The Identity sheet does not repeat
  that label: signed out, its no-account door is "Use this device"
  (`components/IdentityCeremony.tsx`), which connects this device and does not
  open the guest tomb. This flow has
  been removed by accident repeatedly — by gating it on Identity API
  availability, and by withholding it beside an existing vault. Neither is
  legitimate. `continueAsGuest` (`packages/app-core/src/lib/guest-auth.ts`) seals a
  local vault and works with no Identity service at all; the registered-auth
  claim degrades to a bell notice (ADR 0033). Beside a sealed vault the store
  runs the guest in the isolated `GUEST_TOMB` (`packages/app-core/src/lib/vault/store.ts`
  `createGuest`), so the existing vault is never read, written, or deleted,
  and `lock()` keeps the unlock screen on guest when that was the last
  authorized account — isolation is the answer to "a guest would
  clobber the vault", suppression is not. Do not gate guest on
  `hasIdentityService`, `noWayIn`, the provider catalog, first-run setup
  allowlists, or vault status. The only road that is legitimately withheld
  beside an existing vault is "Use without an account" (a local-only seal in
  place). Any change that drops a guest entry is a regression, not a cleanup —
  the tests in `FrontDoor.test.tsx`,
  `UnlockScreen.test.tsx`, and `store.test.ts` asserting guest exists and
  stays isolated are load-bearing
  and must not be deleted or inverted.
- **A new vault is sealed with a passkey, never a master password**
  ([ADR 0180](../adr/0180-vaults-are-sealed-by-passkey-not-password.md)).
  First-run sealing offers a passkey, or a PIN where WebAuthn cannot run;
  Settings › Security has no way to add or change a master password. A vault
  that already holds a password wrap keeps its Password tab (a header with no
  recovery is never stranded) and its Password row offers Remove only. Do not
  add a password field, strength meter or reminder to the seal form, and do
  not offer "Use a password instead" in a key sheet.
- A device knows two things and the unlock screen states both: **who** is
  signed in (the Identity session plus the upstream assertion federation saved)
  and **which key** opens the vault (the passkey/PIN/password wraps in the
  plaintext header, plus the manifest's verified recovery key, age key, age
  passkey and passkey capsule — never a cloud KMS record, whose credential is
  sealed in the vault, ADR 0152 — then the authenticator gate if enrolled). The
  unlock tabs are exactly the enrolled methods, never a uniform three; an enrolled
  authenticator code is announced as step 2 before step 1 is taken. Sign out
  is one operation in `packages/app-core/src/lib/session-exit.ts` (forget the
  assertion, revoke Identity, lock, note it for the sign-in panel); "switch
  account" is that plus `prompt=login` on the next OIDC leg, and never on
  Shoo's dialect, which ignores it. A second step (authenticator, email or
  text code) may be enrolled only once a primary method exists and only after
  a code from it matches — a guest can never write a gate with no key behind
  it, and a guest who asks for one is walked through the key first, in the
  same sheet. Settings › Security is a read-only list — one row per method,
  one action, never an input — and one sheet
  (`apps/pages/src/sections/settings/security/`) built from `CeremonyShell`
  and `FieldShell`; do not draw a form under a row, and do not draw a second
  PIN form anywhere. Email and text codes are fallbacks the
  Identity API sends (`/v1/mfa/code/send|verify`), offered only where one is
  configured, with NIST 800-63B's notice before the address is asked for;
  recovery codes are the vault's, sealed whole under its key, and stand in
  for any second step once each
  ([ADR 0091](../adr/0091-account-exits-and-unlock-ceremony.md)).
- A device holds several vaults (the personal tomb, one per project, the
  guest tomb), and there is exactly one list of them: `listDeviceVaults()` in
  `packages/app-core/src/lib/vaults.ts`, rendered by `components/VaultList.tsx` on the
  front door (`screens/VaultsScreen.tsx`), the `@tomb` prompt, and Settings →
  Vaults. Do not add a second switcher. A project's name is sealed inside its
  tomb, so nothing may show it before unlock (`vaultLabel` says
  `project · 4f2a`); a vault opens without a prompt only when
  `VaultStore.sharesKeyWith` proves it shares the session's wrap material
  ([ADR 0089](../adr/0089-device-vault-switching.md)).
- Anything with a deadline (certificate, CA, signer, brokered credential,
  rotation policy) is detected by the lifecycle scanner and published on the
  `lifecycle.*` hook feed — never by a subsystem's own private due-check.
  `OpenSesame`'s own rotation subscribes to that feed, so a break in it breaks
  our rotations too ([ADR 0074](../adr/0074-expiry-lifecycle-hooks.md)).
- Every security fact — an expiry, a breached password, a provider disclosure —
  becomes a `SecurityNotice` and publishes through `security::dispatch`. A
  detector never gets its own notification path: it converts into the shared
  envelope and inherits the subscriptions, the delivery ledger, the built-in
  notifier and alerter, and every industry-standard sink
  ([ADR 0080](../adr/0080-security-event-hooks.md)).
- Breach checks disclose nothing about a tenant: passwords go through the Pwned
  Passwords range API's k-anonymity (five hex characters of a SHA-1 leave the
  host), and provider checks fetch the public catalogue whole and match
  locally. The breached-account API is deliberately unused — it would mean
  disclosing addresses held on somebody else's behalf (ADR 0080 §5).
- A certificate is renewed unattended only when the host holds its key
  (`managed_certificate_keys`); one whose key went to its requester reports
  `not_in_custody` rather than minting a key with no recipient. Custody is opt-in
  (`managed: true`), never agent-reachable, and its renewal lead is clamped to
  half the lifetime so renewal terminates
  ([ADR 0075](../adr/0075-host-certificate-key-custody.md)).
- **mTLS is optional, per hop, and never a fallback**
  ([ADR 0132](../adr/0132-optional-mtls-and-workload-identity.md)). The
  static core is untouched: `apps/pages` needs no certificate, no environment
  and no backend, and a browser cannot attach a vault key to `fetch`'s TLS —
  `browser_vault_key_injection` is always `unsupported`. Authentication is not
  authorization: a verified peer (`VerifiedPeer`, never deserialized from a
  header or body) must resolve to exactly one operator-written service
  binding — exact `spiffe_id` / `dns_name` / `uri_san` / thumbprint, no CN,
  email, IP or wildcard, no fleet role — and then pass the ordinary PEP,
  grant and ConnectionRef checks. Custody is stated truthfully: PEM files are
  file-readable, a managed certificate is Host-sealed and exportable to the
  Host, a Workload API SVID is delivered to the process; nothing is called
  hardware-bound. A configured `mtls_required` hop with missing or invalid
  material refuses to start; it does not downgrade to bearer, plaintext, the
  memory bus or a shared certificate. Revocation is bounded per layer (next
  handshake, next protected request, NATS server-side expiry, the token's own
  TTL) and erases nothing from a browser. The daemon keeps its serde + std
  budget; browser packages get no `node:tls`. Operator reference:
  `docs/operators/mtls.md`.
- Where a person is notified and what it takes for them to approve are separate
  mechanisms. A preference may reorder and narrow the destinations policy
  allows; it can never admit a channel policy refused, and never lowers an
  assurance requirement. Channel capability is a closed record in
  `packages/os-domain/src/notifications.ts` — no adapter declares its own, and
  no channel but the in-app ceremony may claim phishing resistance. Direct
  external settlement is default-deny and needs an explicit per-channel policy
  opt-in *and* the assurance gate; a provider-signed callback proves provenance,
  never authorization ([ADR 0084](../adr/0084-external-authorization-notifications.md)).
- A sensitive approval is bound to its transaction: the WebAuthn activation
  commits to the request digest, the decision verb, and the effective policy
  digest, and is spent by a durable compare-and-set. An activation minted for
  one request, one verb, or one policy can never settle another (ADR 0084).
- **Every key is a person's, and a few keep the road open**
  ([ADR 0156](../adr/0156-keybindings-and-macros.md)). The shell's handler
  resolves every press through the effective keymap (the catalogue in
  `packages/app-core/src/lib/keymap/commands.ts`, overlaid by the person's
  sparse bindings), so a new key is a catalogue row, never a second
  hard-coded table. Tab, Enter, Escape, F6, Shift-F10/Shift-Enter and the
  count digits stay fixed. A command that asks before it acts (trash, share)
  never gains a key and never runs from a macro, and an event trigger
  (`on: unlock`, `on: enter:<section>`) runs navigation only. A key may be
  scoped to a closed set of contexts (`vault`, `rail`, read from
  `listingOf(event)`), never an expression, and every guardrail holds in each.
- **A Settings row acts, or it is not drawn**
  ([ADR 0158](../adr/0158-settings-rows-act-or-are-absent.md)). No disabled
  key, no lock glyph standing for "not yet", no link to a page that does not
  configure the thing, no static status a person cannot change. A control
  whose precondition is unmet is absent; the row that needs a setting opens the
  sheet that sets it. A setting is not removable while something depends on it.
- **Settings is files, and a page is how a file is seen**
  ([ADR 0134](../adr/0134-item-type-marketplaces-and-settings-files.md)).
  Configuration a Settings panel edits lives in a virtual file; a directory's
  `config.yaml` and the capability documents are those files, and **opening one
  draws the designed page that writes it, never its text** — the same as every
  other page. Never draw YAML as a view, never add a Form/Visual/Source toggle
  or a paste box, and when a key has no designed row, add the row (Features and
  Integrations add the designed row on the page that owns the key; Host/Identity/daemon
  are not Pages backends and have no Endpoints panel). Only a file
  a provider keeps for authoring (an item type's JSON, `marketplaces.json`, a
  routing file) opens in the file viewer, painted in the same colours, from a
  row's key. An item-type marketplace is a git repository read through its
  forge's anonymous raw-file route; it confers no trust — every definition it
  offers meets ADR 0087's parser and registry — and it is read only when a
  person opens it.
- **Built-in item types beyond the core are packs, switched on to download**
  ([ADR 0165](../adr/0165-item-type-packs-on-demand.md)). Only `secret`,
  `file`, `passkey`, `certificate` and `drop` are embedded in the bundle; the
  other 23 are `packages/vault-item-types/src/packs/<id>.generated.ts`, each its
  own chunk behind a dynamic `import()`, indexed by `PACK_INDEX` (metadata and a
  SHA-256, nothing else). Settings › Vaults › Item types is a list of switches —
  the whole row is the switch, `role="switch"`, for a thumb. Switching on queues
  `enablePack` (`packages/app-core/src/lib/type-packs/`): download, digest,
  parse, sealed copy for offline, register — downloads a few ahead, installs one
  at a time, the main thread handed back between steps, no reload, state told on the row, in a live region
  and in the bell tray. Never import `*.generated.js` under `src/packs/`
  statically, and never read a pack's text from the entry; a type the open
  vault holds items of is installed for the document and has no switch. After
  editing `marketplace/item-types/builtin/*.json`, re-run
  `pnpm --filter @opensesame/vault-item-types generate`. A suite that assumes
  the whole corpus loads every pack in its setup.
- **A password is produced by one facade, and a pepper is never asked for or
  stored** ([ADR 0174](../adr/0174-the-pepper-is-the-persons-and-passwords-are-produced-by-one-facade.md)).
  Copy, fill, the terminal, the daemon, health and export all call
  `producePassword` (`@opensesame/vault-core`; `produce_entry` in
  `crates/sealed-store`) and none knows how a password is made; `produce-facade.test.ts`
  fails on any other reader of an algorithm or a pepper position. *Include
  pepper* means the produced password has a slot for a secret of the person's
  own, at a Python-style `pepperAt`; the product holds no pepper, no envelope under
  one and no verifier for one. A file holds the parameters an algorithm computes
  from (generator, rules, counter, root) and an empty line one, never the generated
  password. A generator's label names a kind (*Algorithmic*), never a technique.
- A vault item type is a manifest, never a code path. Adding one is a JSON
  file in `marketplace/item-types/builtin/` (embedded by both planes),
  and a user can install one at runtime with no build. Fields name types from
  the closed catalogue; a concealed field may never reach `subtitle`, `search`,
  or a VFS filename; only a platform-published definition may name a ceremony
  handler ([ADR 0087](../adr/0087-vault-item-type-plugins.md)).
- **One definition, every target**
  ([ADR 0139](../adr/0139-one-definition-every-target.md)). Anything more
  than one target needs — an integration, a capability, a config key, a
  behaviour's test vectors — is written once under `spec/` and consumed by
  every target (embedded, or generated with a freshness test), with a drift
  test in each consumer. Never add a provider id, list or rule to one target:
  add the row to `spec/connectors/catalog.json` (aliases for other names),
  regenerate the view (`UPDATE_CATALOG_VIEW=1 cargo +1.88.0 test -p
  opensesame-connection-broker --test catalog_view`) and the client module
  (`pnpm --filter @opensesame/app-core generate:catalog`). A target shows a
  subset only as an ordered selection of catalog ids.
- **A surrogate selects a credential; it never becomes one**
  ([ADR 0150](../adr/0150-surrogate-credentials-at-the-last-hop.md)).
  An unmodified client may hold `osr_…` instead of a token, and the broker
  *recognizes* it, *strips* its header and *re-places* the credential into
  the provider's own site through invoke-through — never a find-and-replace
  of the text. A surrogate anywhere but its one declared site, at another
  host, from another caller, or outside its method/path scope is refused
  and is a `surrogate.*` tripwire; the client learns only one message.
  Surrogates carry no provider prefix. Every brokered response is scrubbed
  of the credential it carried. No extension or PWA does network
  substitution (ADR 0150 §6.4–6.5). The proxy, login-form substitution and
  autofill are **optional runtime plugins** (ADR 0150 §7,
  `spec/plugins/catalog.json`, `crates/plugin-settings`): never in the
  default `opensesame` binary, the daemon's dependency tree, the Pages
  bootstrap or `apps/browser-extension`; installed from a terminal with a
  sha256 pin re-verified at every launch; recorded off until switched on in
  Settings or `opensesame plugins enable`; `OPENSESAME_PLUGIN_<ID>=off` can
  only turn one off. A gate fails if `opensesame-cli` or the daemon reaches
  the plugin crate.
- A connector arrives by reference, never by credential. The connectors tab
  of setup and the Connections page's *Import connectors* read a
  Nango-compatible directory's two listing routes and nothing else; `GET /connection/{id}` — the route that
  returns tokens — is never called, no Nango package is depended on, and the
  directory's key is sealed in the tomb or held in memory, never written in
  the clear. Binding a connector to a person or agent is a local share grant
  of kind `connection` — the one ledger Identity shares use — not a second
  authority model ([ADR 0115](../adr/0115-front-door-and-connector-directory.md)).
  Access › Connectors lists access — connectors someone holds a grant on —
  and adds a grant by choosing a connector Connections configured or
  imported; it never asks for an endpoint, a key or a sync (ADR 0115,
  amended 2026-09-28).
- Every new user-facing capability (gateway route, CLI verb, PWA action) must
  get a `packages/capability-registry` entry that maps it onto the MCP/WebMCP
  surfaces or excludes it with an ADR citation — parity tests in mcp-host,
  mcp-client, pages, and both CLIs enforce this
  ([ADR 0065](../adr/0065-agent-surface-parity.md)).
- A cross-device handoff is an `Interaction` and nothing else. Every surface —
  QR, Google Wallet, the PWA, a CLI link, a future wallet provider — is a
  presentation adapter over the one envelope, and every proof mechanism is an
  adapter over `ApprovalProof`. Do not add a second authority model beside it:
  a reference authorizes nothing, and an approval counts only when
  `proof.boundDigest` equals the interaction's `requestDigest`
  ([ADR 0086](../adr/0086-wallet-native-interaction-layer.md)).
- Payment *authorization* is in scope; payment *credentials* never are.
  `assertNoPaymentCredentials` refuses card data by field name and by
  Luhn-checking values, and OpenSesame issues no cards, provisions no DPANs and
  stores no PAN/CVV (ADR 0086 §6).
- In-product support guides by *pointing*, never by acting. A model may emit
  GuideLang and nothing else, and GuideLang has no directive for a click, a
  keystroke, a submit, a fetch, a tool call, a selector or a URL — an id it
  names is resolved through the target registry in
  `packages/app-core/src/tutorial/registry`, or the program is discarded whole. Model
  text reaches the document as a React text node on the tutorial card, which parses
  no markup. Page context is assembled from authored
  registries only, never from the DOM, so no secret, item name or folder name
  has a path into a prompt. A new control worth asking about gets a catalog
  entry with checked-in prose; a new authored guide is compiled by the same
  parser and validator model output goes through
  ([ADR 0088](../adr/0088-ai-native-contextual-support.md)).
- **Every feature has a replayable tutorial, and every tutorial is walked in a
  real browser** ([ADR 0163](../adr/0163-tutorial-mode.md)). A new section of
  Settings › Features gets a `feature.<id>` target and a tour in
  `feature-goals.ts`, and a new section of Settings › Integrations an
  `integration.<id>` target and a tour in `integration-goals.ts`; a new goal gets a home in `registry/areas.ts` (the test
  fails without one) and a step is a `say`, a pointing directive with the
  `wait` after it, or the closing `success` — every step must be reachable by
  Next alone, and must point only at controls that are drawn where the tutorial
  is offered (an authored tour may name up to 40 instructions; a model's stays
  at 8). A tutorial that points at a section or a signed-in-only row says so
  (`focus "feature.<id>"` or `focus "integration.<id>"`, `requires`) and the library hides it where it
  cannot work. A control a guide can point at, and every key the keymap binds,
  is taught by a tutorial or named in `coverage-ledger.ts` with a reason
  (`coverage.test.ts`; the ledger only falls). A gate (the front door, unlock,
  setup, the broker popup, the federation return) draws a help key and starts
  tutorials scoped to its own route (`gate-goals.ts`, `useSupportRoute`'s
  `/unlock/door`, `/setup/identity` and the rest; ADR 0166), and is offered
  none of the shell's. Changes to a tutorial, the Support sheet, the tutorial card or
  the target registry require `pnpm --filter @opensesame/pages verify:tutorials`
  against a fresh Pages build (every tutorial, desktop and phone, Next and
  Back and Replay and Done, keyboard and mouse, focus handed back), and keep it
  in the mandatory prerelease suite.
- **Every new user-facing feature is a capability, and an optional one never
  loads before consent**
  ([ADR 0130](../adr/0130-operator-controlled-capability-composition.md)).
  Most functions are **always-on** (`alwaysOn` in
  `catalog-always-on.ts` and `catalog-always-on-local.ts`, ADR 0135/0142):
  core tier, never a switch, code still loaded as a module after boot.
  The site broker and git backup are always on, not an opt-in the page
  reports as "deselected". Connections, Access and Identity are optional
  extensions, absent until their Settings switch is on, and the minimal
  vault creates only the base secret (ADR 0153). An operator's verified policy
  may still withdraw an always-on capability that owns a module (ADR 0142). Settings splits what a
  feature *is* from what it *connects to* ([ADR 0189](../adr/0189-settings-features-and-integrations.md)).
  **Settings › Features** is the feature flags: **one list of sections**
  (`FEATURES` in `packages/app-core/src/lib/capabilities/features.ts`), every
  one a `conn-group` subheader with its switch on it (no card row, no
  collapsible, no second per-capability list), reviewed and consented like any
  switch; every optional capability has exactly one section. **Settings ›
  Integrations** is the third-party connections that extend a feature or
  replace what it does on its own (`INTEGRATIONS` in `…/integrations.ts`, one
  section per feature-binding connector family): configured by reference,
  never a feature flag (no reviewed plan, no consent receipt), drawn whether or not the feature is on, and every
  connector family has exactly one section. The two lists share no field, so a
  section is one or the other. A retired `/settings/capabilities` address is
  redirected, with its anchor and file, by `retiredSettingsAddress`
  (`packages/app-core/src/lib/settings-retired.ts`).
  Adding a feature is five things beside ADR 0065's registry entry: a
  descriptor in `packages/app-core/src/lib/capabilities/catalog-*.ts`, a module entry
  `apps/pages/src/modules/<capability-id>/runtime.ts` exporting
  `capabilityRuntime`, an ownership rule in `apps/pages/src/lib/capabilities/ownership.ts`
  plus a source-classification rule, an operation mapping in
  `packages/capability-registry/src/capability-map.ts`, and a profile fixture
  that proves its **absence** (`minimal-local` resolves to zero optional
  capabilities). A capability owns operations; it is not one, and nothing in
  the registry is renamed to make it fit. Optional code reaches the page only
  through `loadApprovedModule` under a current lease, after the plan approved
  it and a `ConsentReceipt` covered its exposure digest — a configured
  endpoint, a skipped setup tab, a remembered provider or a cached chunk is
  none of them consent. **The bootstrap may not statically import an optional
  module**: `main.tsx` resolves the plan and then `import()`s `app-root.js`,
  modules have no top-level side effects, and the build fails on reachability
  of an excluded module from any entry. Scopes only narrow — distribution,
  instance, workspace, installation, vault session — so a smaller permitted
  set can never enlarge the approved one. Changes to the bootstrap, a module,
  a worker or the build run `pnpm --filter @opensesame/pages build:profile`
  and `verify:capability-graph`; a contract with no landed test is recorded
  `pending` in the maintained uncovered-contract list in
  `docs/validation/capability-composition.md`
  rather than left to read as covered. Operator guide:
  `docs/operators/capability-composition.md`; verification method:
  `docs/validation/capability-composition.md`.
- **A source file stays under 400 lines and the debt ledger only falls**
  ([ADR 0093](../adr/0093-structural-quality-gates.md)). `pnpm quality`
  measures module size and TypeScript complexity against thresholds that mirror
  `clippy.toml`, and scores every pnpm package and Cargo crate against Robert
  C. Martin's component principles. A dependency cycle (ADP) and an import of
  an undeclared workspace package are hard failures. Everything else ratchets
  against `tools/quality/quality-baseline.json` and `tools/quality/package-metrics-baseline.json`: a file
  may not exceed its recorded number, **and a file that improves must have its
  baseline tightened in the same commit** (`pnpm quality:gate --update`). Never
  raise a recorded number to make the gate pass — split the file. New files get
  a recorded number of zero, so new code meets the budget outright.
  `docs/validation/code-quality-gates.md` is the working guide.
- Pages, PWA, and ceremony UI follow [`DESIGN.md`](../../DESIGN.md) and
  [`docs/design/controls.md`](../design/controls.md).
  The visual tooling is three tools with three roles
  (`docs/design/tooling.md`): Storybook (`apps/pages/stories/`) *defines* the
  system and every delivered component gets a story on the app's own CSS;
  Figma *sets the look* a story must match through its Design tab; Stitch
  *prototypes* alternatives from `.stitch/DESIGN.md`. A story never restyles a
  component, and nothing moves from Stitch into `apps/pages` without a frame
  and a component first. An action that
  executes is an icon key (`icon-btn`, or `.go` for the action that ends the
  screen) with `aria-label` and `title`. Do not paint a verb on a button.
  Text on a control is only a choice object (a provider, a mode, a navigation
  target, the guest road). A status is a `StatusMark` glyph, never a text
  pill. **A failure is never drawn in the page**: no red box (`note--err`,
  a dynamic `note--${tone}`, `conn-error`, `conn-flash`, `broker__card--err`,
  any `*__error`/`*__err` paragraph), no visible `role="alert"`, no error
  wash on a block. It is a `StatusMark` on the row, field or receipt that
  failed *and* a notice in the tray (the bell): mount
  `<FailureNotice id title message />` (`apps/pages/src/components/FailureNotice.tsx`),
  call `useFailureNotice` (`apps/pages/src/components/use-failure-notice.ts`), or
  use `StatusNote`, which now trays every error and warning and draws only a
  quiet success. A screen with no shell (unlock, front door, federated return,
  an unframed popup) gets the corner bell, `NoticeCorner`, mounted by `AppRoot`
  ([ADR 0163](../adr/0163-failures-live-in-the-tray.md)). Do not add explainer or caption prose. Pages copy never
  names a Host, and a browser-local connector action never asks the person to
  pair one. `pnpm lint:design` (`scripts/quality/design-lint.mjs`) rejects word-verb
  buttons, status pills, explainer captions, and any in-page failure
  (`no-in-page-error`, `no-error-box-css`; no ledger, the count is zero); `impeccable detect`
  enforces the same design file when the optional skill is installed. Both run in `.githooks/pre-commit` (impeccable skips when absent). The
  word-verb ledger is `tools/quality/design-button-baseline.json` and only falls.
  **Three shape rules gate every control, and each has a lint rule whose
  count is zero** (the corners ledger, `tools/quality/design-radius-baseline.json`,
  is empty and stays empty). *Corners are square* (`no-round-corners`): `--radius` is 0, and no
  `border-radius` past 0 — no 2px, no pill, no circle, no percentage — appears on
  anything; dots, knobs and spinners are squares. *A control is never red*
  (`no-danger-control`, `no-control-error-ink`): the error ink belongs to a
  status (`StatusMark`, the tray card, an `aria-invalid` border), so there is no
  `btn--danger`, `go--danger`, `icon-btn--danger`, no red armed key, no red
  menu entry; the one irreversible act is the ordinary `.go` square with the bin
  glyph, and `tone: "danger"` only picks that glyph and keeps the ask plain.
  *A sheet has one way out* (`one-way-out`): its close key in the head (with
  Escape and the scrim) is the only dismiss, so a `CeremonyShell` `secondary`
  that only says "Keep it", "Not now" or "Cancel" is a second X and fails;
  focus lands on the close key.
- No `sudo` (`.cursor/rules/no-sudo.mdc`).
- Configuration follows the `.env.schema` env-spec pattern (`@type`,
  `@required`, `@sensitive`, `@public` annotations). Never commit live
  secrets; dev signing keys and claim peppers are generated outside git.
