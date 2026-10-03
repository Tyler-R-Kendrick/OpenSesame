# ADR 0152 — Which key protectors the static browser client enrolls

- Status: Accepted
- Date: 2026-09-28
- Builds on: [ADR 0129](0129-vault-key-protection-manifest.md) (the manifest of
  protectors), [ADR 0158](0158-settings-rows-act-or-are-absent.md) (a row acts,
  or it is not drawn), [ADR 0090](0090-static-frontend-complete-without-backend.md)
  (the static front end needs no backend),
  [ADR 0149](0149-nothing-stored-in-the-clear.md) (nothing rests in the clear),
  [ADR 0005](0005-authority-handle-connectionref.md) (no raw secret on an agent
  surface),
  [ADR 0065](0065-agent-surface-parity.md) (every PWA action is mapped or
  excluded), [ADR 0052](0052-password-manager-ecosystem-bridging.md) (key
  ecosystems are human/device plane)
- Amends: ADR 0129 §8 and the second consequence bullet of ADR 0158
- Amended 2026-10-03: a protector that can open the vault is a way in at the
  unlock screen ("Opening the vault from a protector", below); the sentence that
  said only the header's own wraps do is replaced
- Amended 2026-10-03 (security review): what authenticates a record before unlock
  is stated per kind — age capsules are not self-authenticating, so every opened
  root must verify the manifest MAC; and a `prf_and_code` duress trigger fails
  closed for roads that cannot carry its PRF output

## Context

Settings › Security › Vault key protection lists the protectors enrolled on an
unlocked personal vault. Its Add sheet could enroll three kinds — a recovery
key, a passkey, an age passkey — while the model carried six more kinds with
adapters: `age-recipient`, `yubikey-piv-age`, `aws-kms`, `azure-key-vault-keys`,
`gcp-kms` and `device-local`. ADR 0158 removed the "setup intent" row that stood for
the missing ones and left the sentence "it returns with its enrollment". A
protector kind that a person can be told about but not enroll is a gap, and a
Capabilities › Encryption tile, a Connections page and a key-vault ceremony in
the status bar all still said otherwise: they saved a YubiKey recipient, an
Azure service principal, an AWS key and credentials, and a "setup preference"
that nothing read. The preference changed no protector; its only effects were a
status glyph and, for a cloud choice, a Host authorization a static deployment
cannot complete.

This ADR decides each kind once: enrolled end to end in the browser, or refused
with reasons that can be checked. Nothing is deferred.

## Decision

### Enrolled: age recipient, AWS KMS, Google Cloud KMS

Each goes through the one candidate → proof → commit path the other kinds use:
guest and ephemeral sessions are refused, the manifest is authenticated before
it is read, the mutation carries an expected revision and a session generation
that a lock or cancel invalidates (also checked after the provider answers), and
the record reaches the manifest only through `commitEnrollment`.

| Kind | What is stored | Proof before commit | Test once enrolled |
| --- | --- | --- | --- |
| age recipient | the public recipients and the root capsule encrypted to them | the capsule is opened again with the identity, and must return the session root | the person types the identity; it is compared with the root |
| AWS KMS | key ARN, region, the KMS-encrypted 32-byte wrapping secret, the locally sealed root capsule | decrypt through KMS, open the capsule, compare with the root (`cloud-live` evidence) | the same, through the saved connection |
| Google Cloud KMS | key name and version, the same envelope | the same | the same |

- **Age.** The person pastes a recipient, or asks for a new key pair. A pasted
  recipient with no identity is published `untested`, which never satisfies the
  last-verified-path guard (KP-27), and a Test with its identity makes it
  verified. A new pair is made in the browser; its identity is handed over as an
  `age-keygen` file before the record commits, so an identity that could not be
  delivered never becomes a way back in, and it is never stored. An identity
  that Age keys seals inside this same vault is refused (`bootstrap_cycle`,
  KP-26): a key only reachable after unlock is not a recovery path. A recipient
  is one the library can encrypt to; a YubiKey's `age1yubikey1…` plugin
  recipient is refused (below).
- **Cloud.** The root never leaves the browser and KMS only ever sees the
  32-byte wrapping secret (ADR 0129 §5). The credential is the one the person
  saved under Connections — AWS access key and secret, or a Google service
  account — sealed in the vault (ADR 0149), and the Add sheet saves it in the
  same step. It is read into memory for one call. For Google, the service
  account's key signs an RFC 7523 assertion with WebCrypto and the resulting
  access token is held in memory for the call; the token endpoint is a
  constant, because the JSON carries its own `token_uri` and honouring it would
  send a signed assertion wherever a pasted file says. No credential, token or
  wrapping secret is written to a record, the journal or a log; a record keeps
  the key's identity and the connection's config version. Hosts are the
  allowlisted provider hosts only (`assertAllowedCloudEndpoint`, KP-36).
- **Why these are feasible here.** The browser must be able to read the
  provider's answer. Probed from the build sandbox on 2026-09-28:
  `kms.us-east-1.amazonaws.com` answers a preflight with
  `Access-Control-Allow-Origin: *` and allows the SigV4 headers, and the real
  POST's 400 was readable by a page on `localhost:5192`;
  `oauth2.googleapis.com/token` and `cloudkms.googleapis.com` reflect the
  requesting origin. An operator who narrows `connect-src`
  (`apps/pages/scripts/security-headers.mjs`) must list those hosts: the
  regional `kms.<region>.amazonaws.com`, `cloudkms.googleapis.com` and
  `oauth2.googleapis.com`.
- **Independence, said truthfully.** A cloud protector whose credential is
  sealed in the vault it protects cannot be the way into that vault from this
  browser (KP-37) — it is a path for a principal who holds the cloud credential
  elsewhere, which is what ADR 0129 §5 already disclosed. The record is
  `verified` because the round trip was proved, not because it is independent of
  the vault's own tomb. For the same reason the unlock screen never offers it
  (below).
- **Proof and independence are two facts.** `proofStatus` answers "did the
  capsule open to the session root"; `dependsOnVault(record)` in
  `lifecycle.ts` answers "does opening it need something sealed in this vault".
  The last-verified-path guard (`assertCanRemoveProtector`, KP-11) counts a
  record only when it is `verified` **and** does not depend on the vault.
  Per kind: password, PIN, passkey wraps, passkey capsules, the recovery key,
  PIV and device-local open from what the person presents — independent; an age
  recipient reaches `verified` only through an identity held outside the vault
  (a vault-sealed one is refused above) — independent, and an `untested` one
  counts for nothing; AWS KMS, Google Cloud KMS and Azure Key Vault Keys read
  their provider credential from Connections, sealed in this vault — **not**
  independent, however often they are tested. This guard is a
  manifest-level backstop, and it binds where nothing else does: the header's own
  wraps (password, PIN, passkey) are removed under Unlock methods, which keeps
  one primary unlock through `assertKeepsPrimaryUnlock` and never reaches the
  manifest, and `removeProtector` already refuses a row the header wraps. The
  legacy wrap records are always `verified` and independent, so while the header
  has any wrap the manifest holds an independent record and a cloud key can never
  be what keeps it from firing. What the guard does decide is a manifest whose
  only remaining independent records are being removed: with a verified cloud key
  and nothing else independent, removing the last independent record is refused;
  add a verified recovery key (or an age recipient proved with an identity held
  elsewhere) and it is allowed.
  The answer is a function of the kind and adds no field to a record, so a
  manifest an earlier build wrote keeps its bytes and its authentication tag and
  gets the stricter answer on its next removal. A future enroller that holds a
  cloud credential outside the vault (an ambient role on a native client) must
  record that in an authenticated record field before `dependsOnVault` may say
  otherwise. Settings › Security draws a second, idle mark on a verified row
  that depends on the vault, so "Verified" is not read as "a way back in".

### Not enrolled: YubiKey PIV through age

`age-plugin-yubikey` is a native binary that speaks the age plugin protocol to
the PIV applet of the key. Neither half exists in a page:

1. The browser age library encrypts to native recipients only. A well-formed
   `age1yubikey1…` recipient (valid bech32 checksum) is refused as an invalid
   recipient (`protector-enrollment.test.ts`), so the browser cannot even seal
   a capsule to it.
2. PIV is a smart-card applet on the CCID interface. WebUSB refuses the
   protected interface classes, smart card among them (WICG WebUSB, protected
   interface classes); WebAuthn exposes FIDO2, not PIV.

A YubiKey is fully usable in the browser as a FIDO2 credential: the passkey and
age-passkey protectors are that road. The native client keeps PIV
(`opensesame pass protect piv-discover`).

### Not enrolled: Azure Key Vault Keys

1. Microsoft states that the Key Vault Keys client "cannot be used in the
   browser due to Azure Key Vault service limitations" (azure-sdk-for-js,
   `sdk/keyvault/keyvault-keys/README.md`, with its CORS sample). This is the
   vendor's documentation; no vault was reachable from the build sandbox to
   probe the data plane.
2. A bearer token cannot be had within this repository's rules. A service
   principal's client secret is a confidential client, and a cross-origin
   `client_credentials` POST to `login.microsoftonline.com` returned no
   `Access-Control-Allow-Origin` (probed 2026-09-28), so a page cannot read the
   answer. The alternative is a redirect or popup flow with MSAL, which
   AGENTS.md rules out (`memoryStorage`, no redirect or popup flow).
3. What remains is a proxy that would hold the credential or the wrapping
   secret, which ADR 0129 §5–6 forbids ("no clear wrapping-secret proxy").

The native client and the Host catalog row keep Azure.

### Not enrolled: device-local

A device-local protector wraps the root under a key the platform keeps. In a
browser the nearest thing is a non-extractable WebCrypto key in IndexedDB, and
that already exists: it is the at-rest key of ADR 0149. Wrapping the root under
it would let any code running in the origin unwrap it with no user presence and
no secret, which turns "protect the vault" into "the device's storage opens
it", and it is lost with the browser profile that holds the vault. A platform
keystore with user presence is reachable from a page only through WebAuthn,
which is the passkey kinds.

### Opening the vault from a protector

Enrolling a protector that can never open the vault is a row that acts only on
its own manifest. The unlock screen's tabs are exactly the enrolled methods
(AGENTS.md); the manifest's records are part of what is enrolled, so a protector
that **can** open the vault is a tab. Each kind is decided once, from what its
capsule needs at the moment the vault is still locked:

| Kind | At the unlock screen | Why |
| --- | --- | --- |
| Recovery key | **Recovery key** tab — the shown-once secret, typed | HKDF of the secret opens an AES-GCM capsule; nothing else is needed |
| age recipient | **Age key** tab — an age identity, typed | the capsule is an age payload; the identity is the person's, held outside the vault |
| age passkey | **Age passkey** tab — a WebAuthn tap | the record names its own credential; the ceremony needs no secret from the vault |
| Passkey capsule (manifest `webauthn-prf`, not the header's own wrap) | the existing **Passkey** tab | a PRF output opens the wrap; it joins the header passkey's ceremony, so one prompt offers every credential |
| AWS KMS, Google Cloud KMS | **never** | the credential is sealed in the vault it protects (KP-37); presenting it needs the vault already open |
| YubiKey PIV through age | never | no browser road exists (above) |
| Azure Key Vault Keys, device-local | never | not enrolled by the browser (above); no opener exists for them, so a header edited to carry one offers no road |

The cloud decision is final: the unlock screen never draws a cloud tab, and
`unlock-protector-methods.ts` never lists a record of those kinds, whatever the
manifest holds. A cloud protector remains a recovery path for a principal who
holds the credential somewhere else, tested from Settings.

**The manifest is readable before unlock; its MAC is not.** `header.protection`
is plaintext, so the records and their capsules are there to read; only the
manifest's MAC (`authB64`) needs the root. The screen therefore lists tabs from
the unauthenticated records, and what authenticates a record depends on its kind,
stated here as it is:

- **AES-GCM kinds** (recovery key, passkey capsule) are bound to their context —
  vault id, root key id, root epoch, protector id, purpose — as additional
  authenticated data under a key only the person's material derives. A record
  edited, moved or forged does not open: whoever lacks the secret cannot make
  one.
- **Age kinds** (age recipient, age passkey) are **not** authenticated by the
  capsule. Age encryption to a public recipient needs no secret, and the context
  inside the payload is public, so anyone who can write the header can seal a
  capsule around a root of their choosing, to the vault's own recipient, with a
  context that matches. The capsule proves only that the holder of the identity
  opened *a* root.
- **What stands behind both is the root.** After any capsule opens — every kind
  on this road — the root must verify the manifest's root-derived MAC
  (`authB64`), or it is treated as the next capsule not opening: a wrong key, one
  counted miss, nothing stashed or held. A capsule swapped into an authenticated
  manifest fails there. A forger who rewrites the whole manifest under a root of
  their own verifies it, and is stopped by the last check: that root does not
  open the vault's own body, and activation refuses it.
- **What protects the header is the at-rest seal** ([ADR 0149](0149-nothing-stored-in-the-clear.md)),
  not these records. An attacker with write access to the device's storage can
  still delete or corrupt a header, hide a tab, or draw one that fails — a
  denial, never an entry. The passkey road keeps its own check (an AES-GCM wrap
  under a PRF-derived key, then the body) and is not made to depend on the
  manifest's MAC, because the header's own passkey wrap predates the manifest and
  a lockout of the daily way in must not hang on housekeeping data.

**A protector is offered only while its proof is current.** A record is a tab
when its `proofStatus` is `verified`. A recipient pasted with no identity is
`untested` — never opened with its identity — and drawing it would invite
attempts that can only count against the lockout; its Test makes it a road in. A
`stale` record is withdrawn the same way.

**Same guards as a password.** `unlockWithProtector` is the store's counterpart
of `unlock`:

- the lockout is read first and every miss counts (`recordFailedUnlock`) — a
  wrong key, text that is not a key, a protector kind with no record, a capsule
  that opens another vault — all as one `WrongPasswordError`, so the screen
  cannot enumerate what is enrolled. A dismissed passkey prompt or a tab left
  mid-ceremony is not a miss;
- the opened root is stashed and handed to `afterPrimaryUnwrap`, which parks it
  for an enrolled authenticator, email or text step exactly as for a password:
  a recovery key is not a way around the second step, and the step's own misses
  count;
- a typed key is routed through the complete-code duress gate before anything is
  unwrapped (`unlockWithProtectorAfterDuressGate`), so a duress code entered in
  the key field opens the decoy and never the vault. An age-passkey tap carries
  nothing typed: when a two-input trigger is armed it only opens the root and
  *holds* it (zeroed on every clear), and the complete code that follows decides
  between decoy and vault through the passkey road's own `completePasskeyDuressCode`.
  **A `prf_and_code` trigger fails closed.** It is bound to one passkey's PRF
  output, and an age-passkey tap has none: a typed duress code could never be
  tried against it, "no match" would read as an ordinary code, and the real
  vault would open past it. So while such a trigger is armed the **Age passkey**
  tab is absent and the gate refuses it before any ceremony runs; the **Passkey**
  tab offers only the credential the trigger is bound to (and is absent when the
  vault holds none), and the credential that actually answered — not the header's
  first — is what the evidence names; and a complete code whose evidence cannot
  satisfy every armed `prf_and_code` trigger opens nothing (the held root and PRF
  output are zeroed). The cost is stated plainly: with such a trigger armed, the
  roads that cannot carry it are not available, and the password, PIN and typed
  keys are unaffected (`unlock-prf-trigger.ts`);
- the secret is a function argument and a React state value cleared on submit,
  failure and tab change. It is never logged, never written to a store, never
  given to the browser's autofill (`autocomplete="off"`), and the capsule's
  plaintext root is zeroed after the session key is imported (ADR 0149).

**Preferred unlock** chooses the default tab among everything that opens the
vault, so a verified recovery key, age recipient, age passkey or passkey capsule
may be preferred, and a cloud record or an untested one may not
(`protectorUnlocksVault`). Removing a header wrap is still done under Unlock
methods (`protectorIsHeaderWrap`); removing any manifest capsule is done on its
row, and takes a preference with it.

**Recovery is not a primary method.** `primaryUnlockCount` and the rule that
keeps one password, PIN or passkey wrap are about the header's own wraps and are
unchanged. A recovery key, age key or age passkey can open the vault but does
not count as the daily way in a second step is enrolled behind, and it cannot
stand in for the last header wrap.

### What the Vault key protection panel draws

The panel draws each key only where the service accepts it:

- **Test** for recovery key, age recipient, age passkey, AWS KMS, Google Cloud
  KMS (`protectorCanBeTested`). The service refuses every other kind rather than
  re-marking it verified, as it did.
- **Preferred** for password, PIN and passkey wraps and for a verified recovery
  key, age recipient, age passkey or passkey capsule — everything that opens the
  vault at the unlock screen. It is refused for the rest.
- **Remove** for every protector that is not a header wrap. A wrap's row is
  removed under Unlock methods; removing the row alone left the wrap that still
  opens the vault.

The manifest's copy of the header's wraps is reconciled whenever the header
changes, because Unlock methods writes the header and nothing else.

### Protector management is human-plane only on every agent surface

Enrolling, testing, preferring, removing and rotating are two registry
operations (`vault.protectors.manage`, `vault.protectors.rotate`,
`packages/capability-registry/src/vault-protection.ts`), owned by the core
`vault.local-unlock` capability and mapped onto the Pages action
(`enroll-external.ts:provenExternalRecord`, `browser-lifecycle-ops.ts:rotateCompromisedRoot`).
They are **excluded** from MCP host, MCP client and WebMCP, citing this ADR
under ADR 0065's rule that every PWA action is mapped or excluded: the ceremonies
take an age identity, a recovery secret or a cloud credential, none of which may
transit agent context (ADR 0005), and an agent that could enroll a protector
could add a way into the vault that it holds the other half of, while one that
could remove or rotate could lock the owner out. Key-ecosystem bridging is
human/device plane only for the same reason (ADR 0052). The CLIs are excluded
because they hold no handle on the browser's tomb: the sealed store's own
protectors are `opensesame pass protect`, a different object. The Android and
extension targets are recorded in `surface-gaps.json`, as for the other
vault ceremonies; nothing in this ADR builds them.

### The setup preference is retired

`capabilityConnectors.encryption` is no longer written or read by any screen.
The key-vault ceremony in the status bar is the Add sheet; the AWS and Google
connection pages drop Prefer and their preference marks and offer no Remove
while a protector on that key is enrolled (ADR 0158 §3); the YubiKey and Azure
tiles, pages and sealed files are gone from Pages (the files are removed at
unlock); the setup-intent model is deleted. A preference an earlier version
saved is ignored, so it cannot turn the glyph amber over an authorization
nothing consumes.

## Consequences

- Add offers: recovery key, passkey, age recipient, age passkey, AWS KMS,
  Google Cloud KMS. Nothing on Security, Connections, Capabilities or the
  status bar names a protector the browser cannot enroll.
- A recovery key, an age key, an age passkey and a passkey capsule open the
  vault at the unlock screen, behind the same lockout, duress gate and second
  step as a password. A cloud capsule needs its provider and a credential that is
  not in the locked vault, so it is proved from Settings and never offered at
  unlock. Test proves a capsule opens the session root — the same open the unlock
  performs.
- Someone who narrows `connect-src` gives up cloud enrollment until they list
  the three hosts; this is an operator decision, not a default.
- The static core is unchanged: no certificate, no Host, no daemon. Cloud
  enrollment makes a request only when a person presses the key, to a provider
  host they named.
- ADR 0158's consequence that cloud, YubiKey and age-recipient enrollment "return
  with their enrollment" is superseded: age recipient and the two clouds have
  returned, YubiKey PIV, Azure Key Vault Keys and device-local do not, for the
  reasons above.

## Verification

- Service: `protector-enrollment.test.ts`, `protector-proof.test.ts`,
  `legacy-sync.test.ts`, `browser-service.test.ts`; the model, over the real
  SigV4 and Google transports with a faked network, in
  `vault-protector-enrollment-model.test.ts`; the token minting in
  `gcp-oauth.test.ts`.
- Guard: `lifecycle-guard.test.ts` (password plus verified AWS or Google KMS
  refused, recovery key or externally proved age recipient allowed, an
  old-shape manifest read byte-for-byte and held to the same guard);
  `VaultKeyProtectionPanel.test.tsx` for the row mark.
- Unlock from a protector, on the real vault code: `store-protector-unlock.test.ts`
  (create, enroll through the service, lock, unlock with the key, wrong key refused
  and counted, lockout, second step still required, removed protector, header
  moved to another vault), `store-protector-unlock-tap.test.ts` (age passkey and
  passkey capsule through a stand-in authenticator: counted miss, dismissed prompt
  not counted, the two phases), `unlock-protector-methods.test.ts` (which records
  are tabs; cloud never), `unlock-protector-duress.test.ts` (typed key through the
  duress gate; tap held for a two-input code), `unlock-preference.test.ts`.
- The unlock screen: `UnlockScreen.protector.test.tsx` (tabs are exactly the
  enrolled methods, focus on arrival, Enter submits, wrong key cleared with the
  caret back, no tab for cloud or untested records, guest road intact), and the
  `verify:auth` browser journey, which locks a real vault and opens it with an
  enrolled recovery key, refuses a wrong one, and still asks for the authenticator
  code.
- Panel and sheets: `VaultKeyProtectionExternalCeremonies.test.tsx`,
  `VaultKeyProtectionPanel.test.tsx`, `useVaultKeyProtectionActions.test.tsx`.
- Live, in an attached Vite session: an age key pair made, its identity file
  saved, the protector proved with it; a pasted recipient published untested;
  AWS KMS and Google token requests sent from the page to the real provider
  hosts with placeholder credentials, whose refusals (400) were readable and
  reported. A success against a real key needs a cloud account this work did
  not have; the round trip is proved against a faithful fake of each provider's
  API, including SigV4 signing and the RFC 7523 assertion.
