# File System API

Status: implemented for internal storage and user-selected file transfer.

The PWA uses two related browser APIs:

- the **Origin Private File System (OPFS)** for app-private data;
- the **File System Access API** for a person's chosen save/open location.

They are not interchangeable. OPFS is invisible to the person and belongs to
the origin. The File System Access API grants a handle to a file the person
chose, after a picker and a user gesture.

## OPFS coverage

| Data | Where | Notes |
|---|---|---|
| Sealed vault body | `app-core/lib/kv.ts` | ciphertext only; memory when OPFS is absent |
| Plaintext vault records | `app-core/lib/kv.ts` | names, header, route metadata; sealed when the device key exists |
| Encrypted file parts | `app-core/lib/file-parts-store.ts` | one OPFS directory, `opensesame-pages-file-parts` |
| Travel bundles' source files | `app-core/lib/travel/storage.ts` | list/read/write/remove through `getDirectory` |
| Device reset and duress wipe | `browser-reset-areas.ts`, `duress/wipe` | list owned names, then remove recursively |
| Sealed evidence | `at-rest/origin-files.ts` | opened with the device's at-rest key |

The app never puts plaintext secrets in OPFS. A vault body is sealed under the
vault key; file parts are sealed under a per-file key carried in the manifest;
at-rest origin files are sealed under the device key.

OPFS is optional. `kv.ts` keeps an in-memory copy and reports
`kvDurability() !== "persistent"` when the API is missing or refuses. Travel
mode refuses to depart without durable storage. File attachments show an error
rather than silently doing nothing.

## User-selected files

`apps/pages/src/lib/file-system.ts` wraps:

- `showSaveFilePicker` for recovery codes, travel bundles, access grants,
  vault attachment download, and generated exports;
- `showOpenFilePicker` for choosing an attachment.

Both use the File System Access API only when the browser exposes it. The
fallback is an anchor download or a hidden `<input type="file">`, so Firefox
and Safari keep their existing behavior.

The picker is never persisted. The app does not hold a file handle after the
operation, does not request read/write permission later, and does not scan a
chosen directory. A cancelled picker writes nothing and shows no error.

## Security boundaries

- A picker result is a person's explicit choice; it is not a grant to read
  other files.
- The save picker writes exactly the bytes it is given. For an attachment, those
  bytes are opened from OPFS and decrypted in memory first.
- The open picker returns a `File`; attachment sealing reads it and writes
  encrypted parts to OPFS. The plaintext `File` is not copied into OPFS.
- OPFS file names are app-owned. Reset removes only names under the app's
  prefix and the file-parts directory.
- Browser storage is still origin-scoped. Another origin, profile or browser
  cannot see the vault, and OPFS is not a backup.

## Limits

- `showSaveFilePicker` and `showOpenFilePicker` need a secure context and a
  user gesture. Chromium has them; Firefox and Safari fall back.
- OPFS is not available in every private mode or embedded context. The UI must
  say so rather than report a successful write.
- Deleting one vault does not currently garbage-collect every encrypted file
  part. Reset removes the whole file-parts directory. Per-item cleanup would
  need reference counting because a manifest can be copied between items.
- OPFS does not survive a browser profile reset, and persistence is requested
  when the PWA is installed; it is not a guarantee against eviction.

## Native/PWA split

- **PWA**: OPFS and the File System Access pickers.
- **Native CLI/daemon**: real filesystem paths and its own file permissions; it
  does not use browser OPFS.
- **Host**: never receives a file handle or the contents of an attachment.

## Acceptance

- Save uses `showSaveFilePicker` when present and writes the same bytes as the
  anchor fallback.
- Cancelling a save writes nothing.
- A save-picker failure other than cancellation falls back to a download.
- Open uses `showOpenFilePicker` when present; otherwise the hidden file input.
- A browser without OPFS shows an attachment error and writes no part.
- Reset removes the file-parts directory with the rest of the app's origin
  files.
