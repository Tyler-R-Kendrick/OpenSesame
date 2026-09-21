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
opensesame pass protect add-recovery --yes
opensesame pass protect add-age --recipient age1... --yes
opensesame pass protect remove --id PROTECTOR_ID --yes
opensesame pass protect rewrap --yes
opensesame pass protect recovery-test --key-file ./recovery.key
opensesame pass protect root-rotate --yes
opensesame pass protect piv-discover   # non-destructive
```

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

Use rotate compromised vault key / `pass protect root-rotate`. Current content
is rewritten under a new root where the store uses the root as the content key.
Historical ciphertext and removed wrappers may still reveal an unchanged old
root — rotation is not retroactive secrecy.

## SOPS

Optional. Set `OPENSESAME_SOPS_BIN` to a pinned `sops` absolute path. Core vault
workflows do not require SOPS. Threshold key-groups are preserved or refused.

## Evidence

`pnpm verify:key-protection` writes
`docs/evidence/2026-09-20-vault-key-protection/verify-key-protection.json`
with `passed | failed | blocked` (live cloud/PIV blocked without test env).
