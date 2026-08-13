# @opensesame/pages

The OpenSesame authority console — an installable PWA served from GitHub Pages.

GitHub Pages cannot host the Host or Identity APIs. This page is the console: Connections,
Agents, Authority, Sites, plus a sealed **This device** store for human items. Agents never
call `getSecret()`. Host connectors never appear here as plaintext.

The master password unwraps the key for items stored on this device. It is not stored. A
reload or a cold link asks for it again.

## Rails

| Section | Who | What it does |
| --- | --- | --- |
| **Connections** | operators | Authorize a service on the Host. Bind who can use it. Identity graph of Host + this-device doors. |
| **Agents** | agents | Authorize → invoke → receipt. Grants bounded by a ceiling. Never plaintext. |
| **Authority** | operators | Principal session, device/CLI authorization, ownership claims, protocol honesty. |
| **Sites** | websites | Origin-derived public clients: register, rotate, revoke, integration snippet. |
| **This device** | humans | Logins, passkeys, cards, notes. Generator, TOTP, folders, import. Not the Host. |
| **Settings** | operators | Planes (Host/Identity URLs), seed data, export. |

## Cryptography

- Master password → PBKDF2-SHA256, 600,000 iterations (OWASP 2023 floor) → master key.
- Master key wraps a random 256-bit vault key with AES-GCM. Changing the master password
  re-wraps that key; items are never re-encrypted.
- The item collection is sealed with AES-256-GCM under the vault key and written to OPFS as
  ciphertext. A fresh 96-bit nonce per write; the GCM tag detects tampering and doubles as the
  password check.
- Keys are non-extractable `CryptoKey` handles held in memory for the unlocked session only.
  Locking drops them. Nothing vault-related touches `localStorage` or `sessionStorage`.
- TOTP codes are computed in-page from the stored seed (RFC 6238, verified against the
  specification's own test vectors).
- The password health report runs entirely locally and never contacts a breach service.

There is no recovery path. That is a property, not an omission.

## Connections are the exception to everything above

Every other section is about a store this device can open and a server cannot. Connections
invert that, deliberately.

A connection is a third-party authorization — a GitHub or Slack or Google grant — held by the
authority plane rather than by the vault. It has to be: renewing an access token has to happen
while the browser is closed, and attaching a credential to an outbound request happens at the
gateway's egress, not here. So the Connections section is a control surface over state it does
not hold, and the copy on it says so rather than implying otherwise.

What holds regardless: no view in this app, and no agent, ever receives an access token, a
refresh token, or a client secret. The API has no endpoint that returns one. What you see is
status, granted scopes, expiry, the egress allowlist the credential is pinned to, and which
identities are bound to it.

The flow is: pick a provider → approve on the provider's own consent screen in a popup →
the connection goes `active` → bind it to a project or agent. Renewal is automatic where the
provider issues a refresh token; where it does not, the section says so instead of implying
it lasts forever. A provider with no OAuth client registered on the deployment is still
listed, showing the exact environment variables that are missing.

The contract is in `docs/architecture/connection-broker.md`; the reasoning is ADR 0032.

## Importing from another password manager

**Settings → Import from another password manager** reads an export and merges it into the
sealed body. The file is parsed in the tab with the File API; nothing is uploaded, and no
parsed value reaches plaintext storage on the way in.

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
| Proton Pass | `.json` | Vaults become folders; aliases become notes. |
| Anything else | `.csv` | Columns matched by meaning, with unclaimed ones kept as fields. |

Detection is structural, by header set or JSON shape, and can be overridden by hand. Before
anything is written the preview states what was found, what the format cannot carry, which
items the vault already has, and where each item will land.

## Running it

```bash
pnpm --filter @opensesame/pages dev        # Pages :5180 + built-in Host :18787
pnpm --filter @opensesame/pages test       # crypto, TOTP, generator, health, importers
pnpm --filter @opensesame/pages typecheck
pnpm --filter @opensesame/pages build
```

The local `dev` command starts Identity and Host with the PWA. A static deployment
configures remote Identity and Host addresses in **Settings** because static hosting cannot
run either plane. Every section degrades to an honest disconnected state rather than pretending.

Sample data is opt-in from Settings, badged in the UI, and removable in one action.
## Browser database

The connector catalog opens `opensesame-connectors.db` directly in the PWA
with Turso WASM and OPFS. It works locally without a database service. An admin
may set a Turso sync URL under Settings and paste its auth token for the current
tab; the token is never persisted. The Host remains the credential authority
and never returns connector secrets to this database.
