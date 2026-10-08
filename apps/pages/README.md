# @opensesame/pages

The OpenSesame app — an installable PWA. One build, one deployment shape: GitHub
Pages serves the static app; Vercel serves the same build plus its relay
functions (`api/`, from `server/`) on the same origin ([`vercel.json`](vercel.json),
[relay README](server/README.md)). Both hosts write the deployment's endpoints
with the same script, `scripts/write-runtime-config.mjs`.

GitHub Pages cannot host the Host or Identity APIs, and the app is complete
without them ([ADR 0090](../../docs/adr/0090-static-frontend-complete-without-backend.md));
it no longer speaks Host, bar the bounded exceptions that amend
[ADR 0128](../../docs/adr/0128-pages-without-host.md).
It is a sealed **Vault** for human items plus the sections below, most of them optional.
Agents never call `getSecret()`.

The vault key for items on this device can be unwrapped with a **passkey** (WebAuthn
PRF) or a **PIN** (a vault made before ADR 0180 may still hold a **master password**,
which Settings can only remove), with optional authenticator MFA after primary unlock. Credentials are not stored. A reload or a cold link asks again.

## Rails

| Section | What it does |
| --- | --- |
| **Vault** | Core. Accounts and their login methods, passkeys, cards, notes. Generator, TOTP, folders, import and export. Not a service. |
| **Connections** | Optional (`connectors.external`). Connectors by reference: the embedded catalogue, Vercel Connect authorizations, a GitHub App registered from this browser, and keys or configurations sealed on this device. |
| **Access** | Optional (`access.authority`). Grants, Requests, Sessions, Connectors, Resources and Policies. |
| **Identity** | Optional (`identity.local-iam`). This device as an identity host: Applications and Devices, plus the tabs other capabilities add (People, Agents, Providers, Organizations). |
| **Wallet** | Optional (`wallet.spending`). Budgets, payment methods and spending passes. |
| **Activity** | Always on (`activity.log`). The sealed trail of consequential events. |
| **Settings** | Core. General, Keybindings, Security (unlock methods), Vaults, Capabilities (the switches, connector tiles and the Endpoints panel) and Danger. |

Static-site sign-in is `@opensesame/static-auth`, not a section. Pages serves
its immutable, SRI-pinned artifacts from `public/static-auth/<version>/`
(`opensesame-auth.min.js` with a `.sha384` sidecar and `manifest.json`);
the root `public/auth.js` is the deprecated loopback-only alias, and the
`identity.site-broker` module serves the `/broker/authorize` popup for approved
relying sites. A relying party pins a profile in its own configuration and
calls `OpenSesame.signIn`; listen for `opensesame:signed_in`. The profiles,
the `hosted_identity` configuration and the distribution rules are in the
[`@opensesame/static-auth` README](../../packages/static-auth/README.md) and
[Pages origin](../../docs/operators/pages-origin.md); a runnable example is
[`examples/static-rp`](../../examples/static-rp).

## Cryptography

- Primary unlock peers: master password → PBKDF2-SHA256 (600,000 iterations, OWASP
  2023 floor) → AES-GCM wrap of the vault key; PIN → the same derivation at
  1,200,000 iterations with its own salt; or WebAuthn PRF → HKDF → AES-GCM wrap.
- Optional TOTP MFA runs after any primary unwrap; the authenticator seed is sealed under
  the vault key.
- Removing a master password drops its wrap; items are never re-encrypted. Passkey and
  PIN wraps stay enrolled.
- The item collection is sealed with AES-256-GCM under the vault key and written to OPFS as
  ciphertext. A fresh 96-bit nonce per write; the GCM tag detects tampering and doubles as the
  credential check.
- The vault key is held in memory for the unlocked session as a non-extractable
  `CryptoKey`; enrolling extra wraps uses a private raw copy that is wiped on lock.
  Locking drops it. The sealed body lives in OPFS, and any value the app keeps in
  `localStorage` or `sessionStorage` is sealed under the device key
  ([ADR 0149](../../docs/adr/0149-nothing-stored-in-the-clear.md)).
- TOTP codes are computed in-page from the stored seed (RFC 6238, verified against the
  specification's own test vectors).
- The password health report runs entirely locally. Breach checks are a separate,
  optional capability (`vault.security-checks`): on a press of its key, five hex
  characters of each password's SHA-1 go to Have I Been Pwned's range API.

Another way in is a key the person keeps — a shown-once recovery key, an age
identity or a passkey capsule, enrolled as a protector. Without one, a lost
passkey or PIN strands the vault, and no server can open it.

## Connections are the exception to everything above

Every other section is about a store this device can open and a server cannot. A
connection made through Vercel Connect inverts that, deliberately.

It is a third-party authorization — a GitHub or Slack or Google grant — held by
Vercel Connect rather than by the vault. It has to be: renewing an access token
has to happen while the browser is closed. So the Connections section is a
control surface over state it does not hold. Pages reaches Connect through the
app's own relay (`/api/connect/*`, [relay README](server/README.md)) or the
Connect API with a session token sealed in the vault; a key or a configuration
for a provider with no Connect road is sealed on this device instead (a device
connector, [ADR 0151](../../docs/adr/0151-connector-pages-act-on-the-roads-a-device-has.md)).
A form whose road is closed is not drawn.

What holds regardless: no relay route reads a token back to the browser. Connector
rows are reduced to the fields the catalogue maps (names, service, timestamps,
granted scope names), `authorize` passes on Connect's authorization reply, and
`token-check` answers a fingerprint, expiry and scopes, never the token. The flow is:
pick a provider → approve on the provider's own consent screen in a popup → the
connection goes `active` → bind it to a person or agent with a share grant
(Access › Connectors). The embedded catalogue stays browsable with no backend.

The Host plane's broker contract is in `docs/architecture/connection-broker.md` and
its reasoning in ADR 0032; what Pages does on each road is ADR 0151.

## Importing from another password manager

The **Import** key in the vault's path strip (beside **+** New item) opens the file picker,
and the file chosen opens an import sheet beside the list that reads it and merges it into
the sealed body. The file is parsed in the tab with the File API; nothing is uploaded, and no
parsed value reaches plaintext storage on the way in. The key and the sheet belong to the
always-on `vault.interop-formats` capability (`src/modules/vault.interop-formats/`).

| Product | Formats | Notes |
| --- | --- | --- |
| Bitwarden | `.json`, `.csv` | JSON keeps folders, item types, per-URI match rules, and the hidden flag on custom fields. Identities become notes, since there is no identity type here. |
| 1Password | `.1pux`, `.csv` | The archive is unzipped in-page with `DecompressionStream`. Vaults become folders; typed section fields, TOTP, and cards are reassembled. |
| Chrome, Edge, Brave, Opera | `.csv` | One schema across every Chromium browser. |
| Safari / Apple Passwords | `.csv` | Includes `OTPAuth`. |
| Firefox | `.csv` | No titles in the format, so items are named after the host. |
| LastPass | `.csv` | The `http://sn` sentinel becomes a note; typed secure notes unpack into fields. |
| KeePassXC, KeePass 2.x | `.csv` | Two different schemas from one product. |
| Dashlane | `.csv` | Exports one file per item type; import each in turn. |
| NordPass | `.csv` | Logins, cards, and notes share one file. |
| Enpass | `.json` | Trashed items are skipped; attachments, which the JSON carries inline, are left behind with a warning. |
| Proton Pass | `.json` | Vaults become folders; aliases become notes. |
| KeePass / KeePassXC | `.kdbx` | Decrypted in the tab with the master password, which is used for that one read and never kept. |
| FIDO CXF | `.json` | Credential Exchange Format, including passkeys. |
| OpenSesame | `.json` | An encrypted backup from the Export key, restored with the unlock it names (master password, passkey or PIN); items this vault already holds are left alone. |
| Any `.env` | `.env` | `KEY=value` lines become secrets, gathered in one folder. |
| Anything else | `.csv` | Columns matched by meaning, with unclaimed ones kept as fields. |

Detection is structural, by header set or JSON shape, and can be overridden by hand. Before
anything is written the preview states what was found, what the format cannot carry, which
items the vault already has, and where each item will land.

## Exporting

The **Export** key beside Import opens the encrypted-backup sheet: one
`opensesame-offline-backup-<date>.json` (a project vault's name also carries the
first eight characters of its tomb id) holding the vault's sealed body and its
key-wrapping header — ciphertext only, never a plaintext dump. The unlock enrolled
on the vault opens it: the master password, the passkey or the PIN.
`opensesame-id vault verify <file>` lists a password backup's items by name and
path, and Import restores it on another device. A vault with no unlock enrolled,
and a guest vault, are not exported.

## Running it

```bash
pnpm --filter @opensesame/pages dev:web    # Pages on :5180, no backend (also `pnpm dev:pwa`)
pnpm --filter @opensesame/pages dev        # Pages :5180 + Host :18787 + Identity :18788 + mock IdPs
pnpm --filter @opensesame/pages test       # vitest, then the relay's node --test suites
pnpm --filter @opensesame/pages relay      # the relay alone on :8789
pnpm --filter @opensesame/pages typecheck
pnpm --filter @opensesame/pages build
```

The local `dev` command starts the Host, the Identity API and the mock upstream
IdPs with the PWA (`scripts/dev/pages-dev.sh`). Static hosting cannot run the
Identity plane, so a static deployment names any Identity service in the setup
sign-in step or the Identity section's **Sign-in service** field, and the
connections service and local agent under **Settings › Capabilities › Endpoints**;
with none configured, a section works on what the device holds and draws nothing
for a service that is not there ([ADR 0090](../../docs/adr/0090-static-frontend-complete-without-backend.md)).

## Git sealed store

Backups to git remotes (`backup.git-remote`, always on) run in the browser:
**Settings › Capabilities** draws the git providers under Backups, and a GitHub
App is registered from this browser through the relay's `/api/github-app/*`
routes ([relay README](server/README.md)). The repository picker (on the GitHub
connector page, present when the optional Connections section is on) lists or
creates repositories through that App and defaults to a private
`opensesame-passwords` repository.

The sealed store itself is the Host CLI's `opensesame pass`.
`opensesame pass seal manifest.json --shred` encrypts a path manifest (a JSON array
of `{ path, secret, trailer }`, checked against
`spec/conformance/store-manifest.json`) into the store and deletes the plaintext, then
`opensesame pass backup` pushes ciphertext to the store's git remote. Importing a
manifest through the vault's Import key merges by store path (re-imports are
idempotent). The app has no key that writes a manifest. Agents never see the
manifest — they use ConnectionRefs only (ADR 0005 / 0037 / 0038).
