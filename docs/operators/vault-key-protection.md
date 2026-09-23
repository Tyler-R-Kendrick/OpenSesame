# Operator guide — vault key protection and recovery

## What protects a vault

Settings → **Security → Vault key protection** lists enrolled methods for the
active vault (Password, PIN, Passkey/PRF, age recipient, recovery key, cloud
KMS, …). Each enrolled method can unlock the vault **alone** (any-of).

Settings → **Connections** only stores how this runtime authenticates to a
provider. A connection preference is **not** enrollment.

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
under the reserved top-level names `.git`, `.attachments` and
`.opensesame-rotation`.

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
