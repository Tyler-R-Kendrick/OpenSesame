# secret-files

How a vault is kept as files ([ADR 0182](../../docs/adr/0182-secrets-are-files-one-vfs-contract-on-effect.md)).
The TypeScript plane implements it in `packages/app-core/src/lib/secret-fs/`;
any other plane that reads or writes a vault directory follows this.

## The tree

```
<root>/
  tombs.json                                    plaintext registry of vault names
  <tomb>/
    header.json                                 KDF parameters and key wraps (plaintext, as in vault format v1)
    vault.json                                  the manifest: the commit point
    secrets/<folder>/<name>.<kind>.json         one sealed document per secret
    secrets/<folder>/folder.dir.json            one sealed document per folder: its directory, empty or not
    config/…, index.json, …                     every other vault file, one file each
```

`<root>` is a directory, a path on a privately hosted store, or the browser's
emulation; the tree is the same on all three. A path is `/`-separated, never
absolute, never `.` or `..`, and each segment is `[A-Za-z0-9][A-Za-z0-9._~+=@-]*`
at most 200 characters, not ending in `.` or `.part`, and not a Windows device
name (`files.ts`: `checkPath`). A store refuses any other path.

## Documents

Both are JSON, pretty-printed with a trailing newline. The schemas are
[`secret-file.schema.json`](secret-file.schema.json) and
[`folder-file.schema.json`](folder-file.schema.json) and
[`vault-manifest.schema.json`](vault-manifest.schema.json), generated from the
TypeScript reader and held to it by a drift test.

A secret file is `{ "format": "opensesame.secret", "version": 1, "kind": …,
"sealed": { "ivB64", "ctB64" } }`. The seal is the vault's AES-GCM
(vault format v1) with associated data `vaultSealBinding(tomb, "secret/<id>")`,
over `{ "v": 1, "rev": <body revision it was written at>, "item": <the item> }`.

A folder file is `{ "format": "opensesame.folder", "version": 1, "sealed": … }`,
bound as `vaultSealBinding(tomb, "folder/<id>")`, over `{ "v": 1, "rev", "folder" }`.
Its directory is the folder's name, a `/` in the name making nested directories,
so an empty folder is a directory you can see.

The manifest is `{ "format": "opensesame.vault", "version": 1, "sealed": … }`,
bound as `vaultSealBinding(tomb, "manifest")`, over the vault body without its
items — `rev`, `folders`, `itemTypes`, `tombstones`, `deviceIdentityKey`,
`masterWrap` — plus `items` and `folders`, each `[{ "id", "file", "rev" }]` in order. A manifest
that holds `folders` whole (written before folders were files) is still read.

The **file name is a label, never an identity**: the manifest says which file
holds which id. Where a file goes is fixed by `secretFilePath`, whose cases are
[`../conformance/secret-file-layout-vectors.json`](../conformance/secret-file-layout-vectors.json).

## Reading and writing

- A write puts the changed secret files first and the manifest last; the
  manifest is what commits. Files no longer listed are removed afterwards.
- A read opens the manifest, then every listed file. A listed file that is
  missing, that does not open under this vault's key and this id, or whose
  `rev` is below the manifest's, is corruption. A file whose `rev` is above the
  manifest's by at most one is a write that died before its manifest, and is
  accepted. A file the manifest does not list is ignored.
- A flat `body.json` (the vault body as one sealed blob, from before this
  layout, or from a writer without the vault key) is read when it is further on
  than the manifest, and removed by the next write that has the key.

## The HTTP store

A privately hosted store serves the same four operations. The credential is a
bearer token; the server's `ETag` is the file's SHA-256 (hex, quoted).

| Operation | Request | Answer |
|---|---|---|
| read | `GET /v1/files/<path>` | `200` bytes + `ETag`; `404` |
| write | `PUT /v1/files/<path>` + `If-Match: "<rev>"` or `If-None-Match: *` (optional) | `200` + `ETag`; `412` + current `ETag` (none if absent) |
| remove | `DELETE /v1/files/<path>` | `204`, also when already absent |
| list | `GET /v1/files?prefix=<dir>` | `200` `{ "paths": [...] }` sorted |

`401` without a valid token, `403` for a refused credential, `400` for a path
no store holds, `413` over 4 MiB, `429`/`5xx` are retried by the client's
resilience layer. A page on another origin is served only if the server is
configured with that exact origin (`Access-Control-Allow-Origin`), preflights
are answered, and `ETag` is exposed.
