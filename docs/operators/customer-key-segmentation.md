# Customer vaults and envelope encryption

One deployment can serve several customers. Give each customer its own
organization and vault; initialize each vault independently. Creating two
vaults with the same operator password still creates different random vault
keys. Sharing a root key or copying a vault header is sharing key custody.

## Which keys protect which secrets

| Storage boundary | Data encryption | Key wrapping and segmentation |
|---|---|---|
| Human vault and sealed store | Random 256-bit vault key; file objects have separately keyed data | Password, passkey, recovery or recipient protectors wrap the vault key. Each independently initialized vault has its own root. |
| Host connections and project configuration | Fresh random 256-bit data key per sealed value | The operator root derives a wrapping key bound to organization, purpose and record. Project config also binds project, config, field and version. |
| Host certificate and signer custody | Same envelope path as connection secrets | Purpose separates CA, managed leaf, delivery, signer, enrollment and connector material; organization and record are authenticated. |
| Host events and receipts | Fresh data key per field | Organization and authoritative row identity are bound where the record is tenant-owned. Deployment events retain deployment scope. |
| Identity SSO and LDAP | Fresh data key per secret field | Organization-scoped wrapping keys; database lookups transparently open the secret. |
| Identity webhook, push, account and session credentials | Fresh data key per secret field | Principal or account-owner scope, with record/provider identity and field bound. Session lookup stores a keyed digest; the recoverable bearer is sealed to its owner and digest. |
| Identity OIDC authorization codes, refresh tokens and grants | Fresh data key per payload | Account and client scope; model and token digest are authenticated. Bearer identifiers and secondary lookup fields use keyed digests. |
| Identity TOTP, MFA and provisional-session security state | Fresh data key per internal record | Owner context where available, plus namespace and indexed record identity. Credential lookup keys are keyed digests; single-use consumption stays atomic across replicas. |
| Identity BYO upstream registry | Fresh data key per client secret | Deployment scope and upstream record. This registry has no customer ownership field. |
| Native Android/iOS wallet payloads | Fresh AES-GCM data key per record | Independent platform wrapping keys bind the backend, Multipaz table, document partition and record. All document, provisioning, provider and RPC consumers use the wrapper; SecureArea signing keys alone do not encrypt bearer credentials. |
| Managed daemon tailnet credentials | Fresh data key per credential envelope | Local bootstrap root and authenticated admin-directory, tailnet and OAuth/API credential context; cached tokens also bind the credential snapshot. |
| Rust and TypeScript sealed logs | Fresh data key per line in `osl2` | Independent private local key files, known canonical key-path scope and log purpose; legacy `osl1` reads and migration remain supported. |
| Client CLI human-authentication cache | Random-DEK envelopes with issuer/client-bound HKDF wrapping keys | Owner-only local root file (`0600`); legacy plaintext migrates on load. Issuer matching prevents reuse or refresh against another issuer. No OS-keyring integration. |

Vault item definitions do not select an encryption algorithm. Passwords, API
tokens, authenticator seeds, private keys, notes, custom item fields and file
manifests are carried inside the encrypted vault body. Adding an item type
does not create a plaintext storage path. File data keys are held inside that
sealed body or derived from the owning sealed-store key.

## Operator configuration

Keep `OPENSESAME_CONNECTION_KEY` stable and secret on the Host. The Identity
plane uses `OPENSESAME_EVENT_KEY`, or its configured claim pepper. A persistent
installation must retain these roots across restarts and recovery. Customer
context is selected from stored organization or owner identity, rather than
from an unverified ciphertext header.

Identity credentials owned by a person use that person's scope. A person can
belong to several organizations; those records are not assigned to whichever
organization happens to be active in their browser. A session lookup digest
cannot be submitted in place of the original bearer: lookup hashes every
presented token before querying the index.

These authority wrapping keys are cryptographically separated derivatives of
one deployment root. They provide customer and record isolation against
ciphertext substitution; possession of the deployment root permits opening
every authority envelope. Independent customer KMS custody, root destruction
and customer-specific authority-root rotation require a customer-key provider
and are not configuration options supplied by this change. Human vault roots
already have independent custody through their own protectors.

The daemon's managed tailnet credential uses an envelope in `tailnet-admin.secret`
under a separate private `tailnet-admin.key` bootstrap root. It belongs to the
deployment, and is bound to its validated directory and tailnet configuration.
Pairing stores retain digests rather than recoverable codes. TLS key files,
environment-provided provider credentials and service signing roots remain
bootstrap or external runtime custody inputs. Assigning one to a customer
requires an owned secret record rather than copying it into deployment configuration.

The Client CLI's `identity-session.json` is separate from its encrypted vault
records. Its access and refresh tokens use a random data key wrapped by an issuer/client-bound
key derived from `identity-session.key`. Both files are owner-only (`0600`).
A process or backup with access to both files can recover the tokens; the local
root is not held in an OS keyring. Customer vault initialization does not change
this local authentication cache's root custody.

## Upgrade and recovery

New Host credential writes use a versioned authority envelope inside the
existing ciphertext column. Event writes use `osev2`. Normal Host startup requires
current event envelopes, and normal Identity and worker startup requires current
event and secret envelopes; each refuses legacy ciphertext or plaintext there. To upgrade a
trusted pre-envelope backup, stop traffic, retain the original customer and row
context, and temporarily set `OPENSESAME_ALLOW_LEGACY_SECRET_MIGRATION=true`.
This explicitly authorizes legacy event and secret import, OIDC payload sealing
and atomic conversion of bearer indexes to keyed digests before readiness.
Remove the setting immediately after the upgrade; leaving it enabled permits
legacy data to be imported again on a later restart. Existing direct Host credential
seals remain readable and become envelopes on their next normal rewrite.

Once new envelopes are written, older binaries cannot open them. Keep the
deployment roots with the ciphertext backup and restore using an envelope-aware
build. Retain a pre-upgrade backup if a binary rollback is required. Protector
rotation for a human vault rewraps its key without changing customer ownership.

Tests cover same-password independent vaults, cross-customer and cross-record
substitution, malformed wraps, altered data, legacy reads and startup migration.
These checks establish the implemented storage boundaries; they do not remove
the authority an operator holding the deployment root has over Host secrets.

Native mobile legacy records have no authenticated backend owner and are refused
by default. Re-provision an old wallet or authorize migration only with its
trusted original namespace. The iOS app and provider require their shared
Keychain entitlement; Android binds an installation to its configured backend.
Completed partition migration receipts prevent later plaintext downgrades.
Physical Keystore/Keychain behavior must be validated on deployment devices.

Managed tailnet v1 plaintext migrates only with the known, validated private
configuration; v2 credentials and sealed logs never mint a replacement root
when existing ciphertext lacks its key. Back up the separate local roots with
the corresponding ciphertext, and restore to the trusted original key-path
namespace. Relocating path-bound stores requires explicit rewrapping. Older
binaries cannot read v2 managed credentials or `osl2` log lines.
