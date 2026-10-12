# Operator guide — vault key protection and recovery

## What protects a vault

Settings → **Security → Vault key protection** lists enrolled methods for the
active vault. In the browser, **Add** enrolls a recovery key, a passkey, an age
recipient, an age passkey, AWS KMS or Google Cloud KMS
([ADR 0152](../adr/0152-browser-key-protector-enrollment.md)); each is opened
again before it is saved, and **Test** proves it later:

| Method | Test asks for |
| --- | --- |
| Recovery key | the secret shown once at enrollment |
| age recipient | the age identity (`AGE-SECRET-KEY-1…`); a recipient enrolled without one stays *Untested* until then |
| age passkey | the passkey |
| AWS KMS, Google Cloud KMS | nothing typed — the connection saved on this device |

An age identity made in the browser is saved to a file once (`age-keygen`
format, so `age -d -i <file>` reads it) and never stored; keep it outside the
vault. AWS and Google credentials are saved sealed in the vault and used only
for the call; a cloud protector whose credential is in the vault it protects is
a path for someone holding that credential elsewhere, not a way into this vault
from this browser.

What opens the vault at the unlock screen, and when:

| Method | Unlock tab | Needs |
| --- | --- | --- |
| Password, PIN, passkey wraps (**Unlock methods**) | Password, PIN, Passkey | what each always needed; their rows are removed under Unlock methods |
| Recovery key (verified) | Recovery key | the secret shown once at enrollment, typed |
| age recipient (verified) | Age key | the age identity, typed |
| age passkey (verified) | Age passkey | the passkey |
| Passkey capsule enrolled here (verified) | Passkey | the passkey |
| AWS KMS, Google Cloud KMS | never | — a credential sealed in the vault cannot open that vault |

A tab appears only for a protector that is enrolled and **Verified**: an age
recipient that is still *Untested* has to be tested with its identity first. The
tabs are the same on a locked screen as in Settings, so a protector you remove
here is gone from the unlock screen. A key typed at unlock counts toward the same
lockout as a password, an enrolled authenticator code is still asked for
afterwards, and a duress code typed in the key field opens the decoy. **Preferred**
chooses which tab the screen opens on, among everything that opens the vault. A
recovery key, age key or age passkey can open the vault but never stands in for
the last password, PIN or passkey wrap, which Unlock methods keeps.

What authenticates a record before the vault is open differs by kind. A recovery
key and a passkey capsule are AES-GCM under a key only your material derives, so
nobody without it can make one. An age recipient and an age passkey are public-key
encryption with a public context, so anyone who can write the header can seal a
capsule around a root of their choosing; what refuses it is the root itself,
which must verify the manifest's MAC and then open the vault's own body. What
protects the header from someone with write access to the device's storage is the
at-rest seal (ADR 0149). The worst such a person can do to the unlock screen is
deny a way in, never open the vault.

With a two-input duress trigger that includes a passkey's PRF output (`prf_and_code`)
armed, the roads that cannot carry that output are not offered: the Age passkey
tab is absent, and the Passkey tab offers only the credential the trigger is bound
to. Password, PIN and a typed recovery or age key are unaffected.

YubiKey PIV, Azure Key Vault Keys and a device-local key are **not** enrolled in
the browser (ADR 0152); the native client keeps them.

**Rotate compromised vault key** (the alert key on the panel) mints a new root
and keeps one key's wrap: the PIN, passkeys (other than the new one), recovery
key, age and cloud protectors, the second steps (authenticator, email, text) and
the recovery codes were wrapped or sealed under the old root and go with it.
Unlike `pass protect root-rotate`, which refuses until a recovery key is removed
or reissued, the browser does not refuse: its sheet names exactly the enrolled
ones that will be removed before the key is pressed, and the notice after repeats
them. Add each back afterwards. Every sealed file of the vault (settings, files,
the index) is re-sealed under the new root with the body; one that cannot be
read stops the rotation with the vault as it was.

Which key it ends on depends on the vault ([ADR 0180](../adr/0180-vaults-are-sealed-by-passkey-not-password.md)).
A vault that holds a master password asks for it, and the store proves it
against the vault's password wrap before any key changes (a wrong one is
refused, and nothing is rewritten); it is the same password, wrapped anew. Any
other vault is never given a password: its sheet makes a **new passkey** (the
browser asks, nothing is typed; a refused prompt changes nothing), or asks for a
**new PIN** where the browser cannot make a passkey.

Settings → **Connections** stores the AWS and Google credentials the Add sheet
uses. A connection is **not** enrollment, and it cannot be removed while a
protector on its key is enrolled.

An operator who narrows `connect-src` must allow the regional
`kms.<region>.amazonaws.com`, `cloudkms.googleapis.com` and
`oauth2.googleapis.com` for cloud enrollment.

CLI (native sealed store):

```bash
opensesame pass protect list [--path DIR] [--tomb NAME]
opensesame pass protect test
opensesame pass protect recovery add --yes [--reveal]
opensesame pass protect recovery test          # key from a hidden prompt or stdin, never argv
opensesame pass protect add age --recipient age1... --yes
opensesame pass protect remove PROTECTOR_ID --yes [--no-rotate]
opensesame pass protect rewrap --yes [--no-rotate]
opensesame pass protect root-rotate --yes [--reissue-recovery --reveal]
opensesame pass protect piv-discover   # non-destructive
```

On the native store only a password protector unlocks; a recovery key or an
age capsule is tested, never used to open the store. So the last password
protector cannot be removed, whatever else is enrolled.

`remove` and `rewrap` rotate the root key by default (below). With
`--no-rotate` they only edit `.opensesame-key`, and say so: the previous key
file is still in git history and any pushed remote, and its wrap still opens
the unchanged root.

`OPENSESAME_STORE_PASSWORD` answers only the *current* passphrase prompt.
`rewrap` always reads the new passphrase and its confirmation from the
terminal (or stdin when piped), and refuses an empty one or one equal to the
current passphrase — otherwise the variable would answer every prompt and the
store would be "rewrapped" to the passphrase it already had.

## Offline recovery

1. Prefer a verified local method you still control.
2. An age identity or recovery key used for **root** recovery must be kept
   outside the sealed tomb. Vault-sealed age identities are for post-unlock
   file encryption only — they cannot unlock that same vault.
3. Cloud: a principal who can Decrypt/Unwrap the recorded key plus the stored
   envelope can recover the root. Treat that as an independent unlock path.

## Lost authenticator / changed domain

PRF credentials are bound to RP ID / origin. A domain change does not migrate
browser storage or RP-bound credentials. Enroll a replacement method before
losing the last verified path — the last-verified-path guard refuses removal
of the sole verified method.

## Compromised root

`pass protect root-rotate` (and `remove` / `rewrap` unless `--no-rotate`)
mints a new root key and re-encrypts every `.osseal` entry and every
attachment — manifest and chunks — under it, dot-named ones (`Dev/.npmrc`)
included: the rotation walks the whole tree itself rather than the `ls`
listing, re-walks it before the key swap, and rolls back if any root-sealed
file was left behind. Chunk objects no new manifest references (old
ciphertext and orphans) are removed from the pool after the swap. The password protector is
rewrapped, age capsules are resealed to their recorded recipients, and a
recovery key, whose secret is never stored, cannot follow: the rotation
refuses until you remove it or pass `--reissue-recovery --reveal`, which
prints a new recovery key once. A second password protector refuses the same
way, since its passphrase is not the one supplied.

Nothing is destroyed on failure. New ciphertext is staged in
`.opensesame-rotation/` and swapped in only once every item re-encrypted; the
new `.opensesame-key` is renamed into place last. Any error before that
rename restores the previous files and leaves the key file untouched. If the
process dies mid-swap, `.opensesame-rotation/` keeps `key.next` (the new key
file), `old/` (the previous ciphertext) and `plan.json` (which path each
numbered file belongs to), and the next rotation refuses until it is resolved.

The rotation holds `.opensesame-lock` exclusively from start to finish. Every
write (`insert`, edit, `rm`, `attach add|rm|gc`, `protect add|remove|rewrap`)
holds it shared, so a write refuses while a rotation runs — and a rotation
refuses while a write runs — rather than either one waiting. Writes also
refuse while `.opensesame-rotation/` exists, and refuse to create anything
under the reserved top-level names `.git`, `.attachments`,
`.opensesame-rotation` and `.opensesame-lock`.

`.gpg` and `.age` entries are not sealed under the root and are left as they
are. Rotation is not retroactive secrecy: ciphertext and key files already in
git history still open with the old root, and `pass history` / `pass restore`
cannot open pre-rotation versions with the new one. A long-running process
holding the old key in memory (a password-manager bridge, the connector host)
must be restarted after a rotation: every sealing write first checks its key
against the current key file's manifest MAC, so its writes are refused until
it unlocks again.

## SOPS

The Pages app encrypts and decrypts SOPS YAML and JSON with local age
identities in the browser. That path does not use a Host, a daemon, or a
`sops` binary. Threshold key-groups stay groups. A native CLI may still call
an absolute `sops` path for operator jobs outside the PWA; that setting is
not part of the browser workflow.

## Evidence

`pnpm verify:key-protection` writes
`docs/evidence/2026-09-20-vault-key-protection/verify-key-protection.json`
with `passed | failed | blocked` (live cloud/PIV blocked without test env).
