# Configure secret backends in Pages

Pages can use its open vault, a picked export, browser password credentials, or
an explicitly configured remote secret store. Open **Settings → Integrations**
and choose **BYO Secret Backend** or a password-manager partner. Partner pages
use the same configuration, item workspace and backup controls as BYO.

These connections support explicit item operations and encrypted vault backup
and restore where advertised. They do not schedule synchronization or replace
the existing Git backup configuration. Existing Host and CLI integrations remain
available independently.

## Choose a connection method

| Method | Partners and required configuration | Available operations |
|---|---|---|
| Local vault (`local`) | Local vault or BYO; unlock the destination vault. | List, read, create, update and delete supported local notes, logins and secrets. |
| Export file (`file-import`) | BYO, 1Password, Bitwarden, Vaultwarden or Proton Pass; choose a supported format and file. | Preview and read a volatile snapshot, then explicitly import into the open vault. The source file is unchanged. |
| Browser credentials (`credential-management`) | Browser credentials or BYO; a secure context with password Credential Management support. | Request a browser-selected password for this origin, read it, and request creation/update. No vault listing or deletion. |
| 1Password Connect (`onepassword-connect`) | Connect API base URL, Connect access token and vault ID. | Scoped item list/read/create/update/delete, including secure notes for backups. |
| Vault Management API (`bitwarden-api`) | Bitwarden or Vaultwarden; URL of an existing, unlocked Vault Management API service. | Item list/read/create/update/delete, including secure notes for backups. |
| Secrets Manager (`bitwarden-secrets`) | Bitwarden or Bitwarden Secrets Manager; API URL, identity URL, complete machine-account token, organization UUID and optional project UUID. | SDK-authenticated, locally decrypted secret list/read/create/update/delete. |
| Infisical (`infisical`) | API base URL, project ID, environment slug and absolute secret path; access token or Universal Auth client ID and secret. | Shared v4 secret list/read/create/update/delete in that scope. |
| Passwordstate (`passwordstate`) | Site base URL, numeric password-list ID and API key. | Login-record list/read/create/update/delete in that list. Deletion uses the recycle bin. |

BYO exposes all eight methods. Partner presets constrain the method and file
format choices; they do not introduce separate storage or authentication code.
Item controls follow the adapter's declared capabilities and supported fields.
An ambiguous item name requires its ID instead.

## Save, test and connect

1. Unlock a real vault and enter the connection settings. Give the connection a
   name that contains no credentials.
2. Use **Test secret backend** to attempt the configured authentication/read
   probe. Testing does not save settings or leave an authenticated session open.
3. Use **Save secret backend**, then **Connect saved secret backend**. Listing,
   revealing, editing and deleting items are separate actions in the workspace.
4. Reconnect after locking, switching vaults, editing the saved target, or
   disabling external connectors. A prior session cannot borrow a later
   activation's network access.

Access tokens and client secrets are write-only in saved settings. Leaving them
blank retains the saved credential only when the provider, protocol, endpoint
and scope are unchanged. Changing those targets requires new credentials.
Picked file contents and file passwords are transient and are not saved with
the connection.

Access tokens and client secrets are ordinary Token credential items in the
owning vault, encrypted with its content key and included in sealed vault
backups. Their names identify the connection and credential field. The
device-sealed connection ledger contains configuration and credential-item
references; public Settings projections omit the secret values. Connecting
requires that owning vault to remain unlocked. Guest sessions cannot save
secret-backend credentials.

Saving stages new credential items before atomically publishing their exact
references. A failed publication retains the previous configuration. Cleanup
removes only unchanged items from the original vault; cancellation, a vault
switch or an intervening edit can leave an unreferenced credential item for
the owner to inspect. Editing, trashing or deleting a referenced credential
invalidates the connection; explicitly entering and saving new credentials
repairs it. After restoring a backup onto another device, its credential items
are available in the vault; configure that device's connection separately.

## Prepare an HTTP endpoint

Enable the external-connectors capability and permit the destination in the
deployment's network policy. For self-hosted services, enter the complete base
URL, including any mount path, such as `https://secrets.example/team/`.
The adapter appends its own API paths below that base. Use HTTPS; loopback HTTP
is accepted by URL validation but also needs deployment permission to contact
local authority and the browser's applicable local-network permission. URLs
cannot contain embedded credentials, query strings or fragments.

The service or its operator-managed reverse proxy must allow the Pages origin
through CORS. An origin is scheme, host and port, without the application's
path: for GitHub Pages it might be `https://example.github.io`, even when Pages
is served from `/OpenSesame/`. Allow preflight `OPTIONS`, the actual methods
needed (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`), and the headers used:

| Backend | Request headers to allow |
|---|---|
| Connect, Infisical, protected Vault Management API | `Authorization`, `Content-Type` |
| Bitwarden Secrets Manager | `Content-Type`, `Authorization`, and any SDK headers named by the identity/API preflight |
| Passwordstate | `APIKey`, `Content-Type` |

Return `Access-Control-Allow-Origin` for the chosen Pages origin and an
appropriate `Vary: Origin` when responses vary by origin. Configure CORS only
for the service origins you intend to trust. HTTP adapters omit browser cookies,
refuse redirects and keep credentials within the configured origin and base
path. Configure the final URL directly rather than relying on a login or
canonical-host redirect. Requests have bounded time and response sizes; the
shared HTTP response limit is 4 MiB. SDK worker requests and responses also have
a 4 MiB bound.

Pages calls these services directly through its approved egress port. It starts
no local process and supplies no implicit backend relay. An existing operator
service, including one provided by a CLI, is a valid configured endpoint when
its protocol, access controls and CORS match. A network error can mean TLS,
reachability, browser permissions or CORS; inspect the browser's Network panel.
HTTP 401/403 means the credential or its permissions were refused.

## Provider details

### 1Password

Use a token issued for your [Connect server](https://www.1password.dev/connect/api-reference)
and a vault it can access. A 1Password service-account token for the separate
SDK is not a Connect token. The inspected `@1password/sdk` JavaScript package
targets Node.js; Pages does not substitute it for Connect.

The separate **Save in 1Password** panel loads the official
[`@1password/save-button`](https://www.1password.dev/web/add-1password-button-website).
Choose an eligible local login for the current browser origin and explicitly
prepare the button. An installed, available 1Password extension enables the
handoff and asks the person to save it. Preparing or clicking the button proves
neither a completed vault save nor a verified backup. It grants no list, read
or restore access. 1PUX and CSV imports remain available without Connect.

### Bitwarden and Vaultwarden

For password-manager vault items, configure the
[Vault Management API](https://bitwarden.com/help/vault-management-api/), normally
an existing `bw serve` service signed into the intended Bitwarden or Vaultwarden
account. It must report an unlocked vault. The upstream vault website URL and
the organization's Public API are different protocols; neither is a decrypted
Vault Management API endpoint. Protect the exposed service and allow only the
intended Pages origin. Pages does not run or unlock `bw` for you. Export import
is another supported path.

[Secrets Manager](https://bitwarden.com/help/secrets-manager-sdk/) instead uses
the official browser WebAssembly SDK. Each connection owns a dedicated worker
and WASM instance. The SDK performs its actual token authentication and secret
encryption/decryption; worker HTTP requests pass through the main application's
captured capability transport. API and identity origins/base paths are pinned,
and disconnect, failure or capability cancellation terminates the worker.
The main page's global `fetch` is unchanged.

Enter US, EU or self-hosted endpoints explicitly. A blank identity URL can be
derived for `api.bitwarden.com` or `api.bitwarden.eu`; self-hosted APIs require
their identity URL. Organization ID is required, and project ID narrows item
access. Both endpoints must satisfy CORS and network policy. The complete
machine token includes client authentication material and an encryption key;
keep the whole value private.

### Infisical and Passwordstate

[Infisical](https://infisical.com/docs/api-reference/overview/introduction) uses
Universal Auth at `/api/v1/auth/universal-auth/login` when a client ID/secret is
provided, otherwise the supplied access token. Secrets use `/api/v4/secrets`
under the configured base, with project, environment and folder scope. Reads
keep references literal and do not recursively import other scopes.

[Passwordstate](https://www.clickstudios.com.au/passwordstate/application-programming-interface)
uses its standard `APIKey` header and `/api/passwords` endpoints under the site
base. The configured password list is checked before record access. Notes and
URL remain record fields, and provider password policy still applies. Queued
password-reset responses are not treated as completed writes.

### Proton Pass

Choose an **unencrypted JSON or ZIP export** from Proton Pass, then preview and
import it locally. The ZIP must contain exactly one JSON candidate. Encrypted
PGP exports must first be decrypted locally as described in
[Proton's export guide](https://proton.me/support/pass-export). This integration
does not implement Proton PGP decryption. Attachments can be skipped with a
warning; keep the original export if they are needed.

Proton has documented [access tokens](https://proton.me/support/pass-access-tokens),
a CLI and [browser-capable SDK source](https://github.com/protonpass/pass-cli/blob/7ae51e52818bca8df905988e4b149d43d31d4c83/pass/Cargo.toml). On
2026-10-14, an unauthenticated preflight to
`https://pass-api.proton.me/account/v4/personal-access-token/session` from
`https://opensesame-labs.github.io` returned HTTP 200 with no CORS allow-origin,
allow-methods or allow-headers. The same request with Proton's own
`https://pass.proton.me` origin returned those headers. This establishes a
hosted cross-origin limitation for that measured endpoint/origin, not a claim
that Proton has no API or cannot support future browser integration. No hosted
account login or item CRUD was established by that measurement. The current
Pages partner preset therefore provides the working offline import path.

### Browser credentials and offline files

Password Credential Management support varies by browser. It requests the
browser's origin-scoped credential; it cannot choose 1Password, Proton or
another vendor, enumerate their vaults, store arbitrary notes or delete items.
Use a supported secure context and allow the browser's credential prompt.

BYO's file formats include Bitwarden JSON/CSV, 1Password 1PUX/CSV, Proton
JSON/ZIP, KeePass KDBX, KeePassXC CSV, environment files and generic CSV.
KDBX accepts a transient export password. Parsing and preview stay on the
device; **Import backend items into local vault** explicitly merges the export into
the open vault, with duplicate/skipped-item counts and warnings. This creates
local items rather than an ongoing remote connection.

For cold offline use, install the PWA and wait for offline readiness while
online. Enable the item types you intend to read, such as **Secure note**,
before disconnecting so their verified definitions are saved on this device.
Disabled item packs are not downloaded merely by enabling Connections.

## Back up and restore an encrypted vault

Use the backup controls only on a connection that advertises vault-backup
support. Pages flushes the source vault, exports its sealed ciphertext envelope,
and creates a destination note or secret. It reads that item back and compares
the complete ciphertext before displaying **Encrypted vault backup saved and
verified** and its ID. Retain that ID and the source vault's supported unlock
material separately. No vault unlock password or PIN is uploaded.

Connect, Vault Management API and local storage use note fields; Infisical and
Secrets Manager use secret values. Passwordstate stores ciphertext in notes
with an unrelated random record password. Destination field limits still
apply: Secrets Manager backups are limited to 25,000 bytes, and a provider may
impose other record limits. A failed or truncated readback is not success.
If a write completes but its readback is interrupted, the destination may
retain an unverified ciphertext item; inspect it before retrying.
This is an explicit snapshot; deleting a provider item does not remove other
copies or a provider's history/recycle bin.

To restore, unlock the destination real vault, connect the backend, enter the
backup item's name or ID and the source backup's password/PIN, and choose
**Restore encrypted vault backup**. Decryption and import happen locally. The
restore merges through the existing vault importer, preserving the destination
vault's identity and existing items. Browser credentials, picked-export
snapshots and the 1Password save handoff do not provide verified backup writes.

See [ADR 0202](../adr/0202-pwa-secret-backends-compose-local-and-http-adapters.md)
for the shared contract and [vault key protection](vault-key-protection.md) for
unlock and recovery arrangements.
