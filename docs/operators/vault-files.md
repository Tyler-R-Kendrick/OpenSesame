# Vault files: every secret is a file

The client CLI (`opensesame-id`) keeps your vault as a directory of real files,
and the same layer will serve a PWA hosted for privately held storage. This is
the guide to what is on disk, how to work with it, and what to expect when it is
shared, backed up or raced. The decision is
[ADR 0182](../adr/0182-secrets-are-files-one-vfs-contract-on-effect.md); the
file format is [`spec/secret-files/`](../../spec/secret-files/README.md).

## Where it is

```
$OPENSESAME_STATE_DIR/vault/            default: ~/.local/state/opensesame/vault/
  tombs.json
  personal/
    header.json                         how the vault is unlocked (no secret in it)
    vault.json                          the manifest: which secret is in which file
    secrets/
      work/aws/prod-deploy.account.json
      wifi.secret.json
      read-me.note.json
```

Folders are directories, a secret is `<name>.<kind>.json`, and every file is
owner-only (`0600`, directories `0700`). A name that repeats takes the start of
the secret's id (`wifi~7f3a9c.secret.json`). A vault an earlier CLI kept in
`vault-kv.json` is moved onto files the first time it is opened and the old file
stays as `vault-kv.json.migrated`.

## What a file holds

```json
{
  "format": "opensesame.secret",
  "version": 1,
  "kind": "secret",
  "sealed": { "ivB64": "…", "ctB64": "…" }
}
```

The value, every field, notes and the manifest are sealed under the vault's key;
nothing in a file lets you read them without it. **The folder, the name, the
kind, the size and the modification time are visible**, as in `pass` — that is
what makes the files manageable, and it is the trade this layout makes (ADR 0182).
A secret whose name is sensitive needs a name that is not.

## Working with the files

- **Back up** one secret or the tree with `cp`, `rsync`, `restic`, git. Only
  ciphertext is in it. Restore the whole vault directory together: a secret file
  put back alone at an older revision is refused when the vault opens, because
  the manifest says which revision each should be.
- **Rename** a file by hand if you like; the manifest, not the name, says what it
  holds, and the next save names it again.
- **Inspect** with `ls -R`, `git diff --stat`, `find -newer`. A file that is not in
  the manifest (a stray copy, an editor backup) is ignored and never read.
- **Lock down** one folder with the file system's own permissions or mount it
  read-only into one container; the other folders' files are separate files.
- **Do not edit a secret file.** The seal authenticates it; an edited, swapped or
  copied-in file is refused with a corruption error rather than opened.

## Two writers

Saving takes a lock and checks the manifest it read. Of two commands saving at
once, one wins and the other fails with "was changed by someone else since it was
read" and changes nothing; run it again. A crash between a save's secret files
and its manifest leaves the vault readable: the manifest lists what to open, and
the next save settles the rest.

## A privately hosted store

The same four operations are served over HTTP by `makeFilesHandler`
(`@opensesame/app-core/lib/secret-fs/http-handler.js`), a `Request`→`Response`
function over any store, and reached by `makeHttpSecretFiles` wrapped in
`resilient`: a time limit per attempt, bounded retries with jittered backoff for
an unreachable server only, and a circuit breaker so a dead server is not hit on
every keystroke. The server requires a bearer token of at least 16 characters and
allows one page origin to call it. Wiring it into the Pages app is not part of
this change; see ADR 0182, *Not in this change*.
