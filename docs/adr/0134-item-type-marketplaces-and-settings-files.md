# ADR 0134 — Item-type marketplaces are git repositories, and Settings is files

- **Status:** Accepted — implemented
- **Date:** 2026-09-23
- **Deciders:** OpenSesame maintainers
- **Supplements:** ADR 0087 ([vault item types are plugins](0087-vault-item-type-plugins.md)),
  ADR 0065 ([agent-surface parity](0065-agent-surface-parity.md)),
  ADR 0130 ([capability composition](0130-operator-controlled-capability-composition.md)),
  ADR 0063 ([encrypted VFS tombs](0063-encrypted-vfs-tombs.md)),
  ADR 0073 ([first-party VFS tree](0073-first-party-vfs-tree.md))

## Context

ADR 0087 made an item type a manifest a person can install at runtime.
There were two ways to get one: the 23 built-ins, or pasting JSON. The
paste field sat inside the Settings › Vaults panel, with its own
Visual/Source toggle beside the page's Form/YAML/TOML toggle, and a remove
key on every built-in that did nothing. The panel had no way to find a
type someone else had written.

Two things were missing:

1. **Somewhere to find types.** "Is there a type for this already?" is
   the question the paste field could not answer. Authors of types
   already keep them in git, and a git repository is the obvious unit of
   publishing.
2. **Settings as files.** Settings has a Form view and a source view.
   The source view was one generated document per category. Everything
   the Form wrote about item types had no file at all, so there was
   nothing to read, diff, or hand-edit. The views should be drawn from
   files, not the other way round.

## Decision

### 1. A marketplace is a git repository with an index

A marketplace keeps `.opensesame/marketplace.json` at its root (or under
a subdirectory a person names). It uses the same manifest envelope as
everything else (ADR 0065 §4):

```json
{
  "apiVersion": "opensesame.dev/v1alpha1",
  "kind": "Marketplace",
  "metadata": { "name": "OpenSesame", "description": "…" },
  "spec": {
    "itemTypes": [
      { "path": "marketplace/item-types/optional/vehicle.json", "sha256": "…" }
    ]
  }
}
```

- Each entry is a **path inside the same repository**, never a URL. A
  marketplace therefore cannot send the page to a host the person did not
  name. Paths are relative, with no `.` or `..` segments, and end in
  `.json`.
- An optional `sha256` pins the bytes. A definition that does not match
  its pin is shown as refused and cannot be installed. The hash is taken
  over the exact bytes served, byte-order mark included. A definition
  that starts with a BOM is then refused, rather than failing its pin.
- The envelope, `metadata` and every entry are parsed strictly. `spec`
  tolerates keys it does not know, so one index can later list other
  things (connectors) without breaking older clients.
- At most 64 entries. The index and each definition are capped at 64 KiB.

**Ours is the default.** A device starts with
`github:tyler-r-kendrick/OpenSesame#main`. This repository publishes the
index and five types that are not built-ins: vehicle, email account,
backup codes, gift card and combination lock. They live in
`marketplace/item-types/`. `node scripts/pin-marketplace.mjs` re-pins
them. The default-marketplace test fails if a pin goes stale, if a
definition stops parsing as a community type, or if a type collides with
a built-in's id or extension.

### 2. Any git host, read through its raw-file route

A browser cannot speak git's smart-HTTP protocol without a CORS proxy,
and this page will not route a person's traffic through one. A repository
is read through its forge's anonymous raw-file endpoint instead:

| Forge | Reference forms | Read from |
|---|---|---|
| GitHub (github.com only) | `owner/repo`, `github:owner/repo`, `https://github.com/owner/repo[/tree/ref/dir]`, a link to the index file, `git@github.com:owner/repo.git` | `raw.githubusercontent.com` |
| GitLab (and self-hosted) | `gitlab:group/sub/repo`, `https://gitlab.com/…[/-/tree/ref/dir]`, `gitlab+https://host/…` | `/api/v4/projects/:id/repository/files/:path/raw` |
| Gitea / Forgejo / Codeberg | `codeberg:owner/repo`, `…/src/branch/ref/dir`, `gitea+https://host/…`, `forgejo+https://host/…` | `/api/v1/repos/:owner/:repo/raw/:path` |
| Bitbucket (bitbucket.org only) | `bitbucket:ws/repo`, `https://bitbucket.org/ws/repo[/src/ref/dir]` | `api.bitbucket.org/2.0/…/src/:ref/:path` (the main branch is resolved first) |
| Anything else, GitHub Enterprise and Bitbucket Server included | the raw https address of `…/.opensesame/marketplace.json` | that address's directory |

GitHub's and Bitbucket's raw routes live on the public service's own
hosts. So a `github+https://` or `bitbucket+https://` source on any
other host is refused: it would otherwise be read from the same-named
repository on the public site. `HEAD` as a ref means the default
branch and is stored as no pin. A directory is stored on a tree path at
`HEAD` with the pin after `#`, so a ref containing `/` reads back
unchanged.

- A `#ref` suffix pins a branch, tag or commit on any form.
- References are stored in one canonical spelling, so two spellings of
  one repository are the same entry.
- Every request is https, anonymous (`credentials: "omit"`, no referrer),
  never redirected, and timed out after 8 s over headers and body.
- Private repositories and tokens are out of scope. A marketplace is
  read by reference, never by credential, as with the connector
  directory (ADR 0115).

### 3. A marketplace confers no trust

A definition fetched from a marketplace is text. It goes through
`parseDefinition(text, "community")` and then
`installItemTypeDefinition`, the same path a hand-written file takes. So
every refusal in ADR 0087 §5 applies unchanged:

- no handler;
- no built-in id;
- no extension another type already renders;
- no takeover of an id another publisher installed;
- no downgrade.

The Marketplace view shows each offer's fields, with concealed ones
marked, before its install key does anything. An offer's state (not
installed, installed, update, built in, conflict, refused) is computed
from the registry by `item-type-marketplace-model.ts`. It asks
`ItemTypeRegistry.check()`, a dry run that answers exactly as `install`
would, so a row never offers an install or an update the registry then
refuses. The view never decides it.

### 4. Settings is files; the Form is a view of them

A Settings category is its document (`settings/<category>.yaml`) plus the
files its providers keep. Vaults has these:

| File | Stored as | Written by |
|---|---|---|
| `settings/item-types/marketplaces.json` | a sealed tomb file, `config/item-types/marketplaces.json`: this device's, not synced | the Marketplace view's add, remove and restore keys, or the file viewer |
| `settings/item-types/installed/<id>.json` | the authored JSON in the sealed body's `itemTypes` map: synced E2EE (ADR 0087 §7) | an install (a write), an uninstall (a delete), or the file viewer |
| `settings/item-types/builtin/<id>.json` | the embedded corpus | nothing — read-only |

`VirtualFileProvider` (`packages/app-core/src/sections/settings/virtual-files.ts`)
is the contract: `list`, `read`, `check`, `write`, `remove`, and a
directory new files may be created in. `itemTypeFiles`
(`item-type-files.ts`) implements it for item types.

- **Settings' source view is a file viewer.** It lists the category's
  files as a tree beside the open file. It reads, checks, writes and
  removes by path, through the provider.
- **The Form is drawn from the same files.** Installed is the listing of
  `installed/` and `builtin/`. Marketplace is what `marketplaces.json`
  parses to. Every key in the Form is a write to one of those files, and
  every row has a key that opens its file in the viewer.
- **A new file is a new type.** A file's name follows its
  `metadata.id`. Saving a definition whose id differs from its file name
  is refused, and so is a new file whose id is already installed: that
  type is changed in its own file.
- **An edit is made to the file as read.** The Marketplace view edits
  `marketplaces.json` only after reading it from the vault that is open
  now. Switching, locking or unlocking a vault re-reads it, so one
  vault's list is never written into another's.
- **The Visual/Source sub-toggle and the paste field are gone.** There is
  one source view for the page, and it shows files.
- **2026-09-23 note — no page toggle either.** The page's Form/YAML/TOML
  toggle went with it (PR #483): each directory's own document is
  `settings/<category>/config.yaml` (YAML), and every file here is opened
  by `?file=<path>` on its directory's route — from the rail, the command
  bar, or a Form row's open key — rather than by switching representation.
  The file viewer, the providers and the contract above are unchanged.

### 5. Consent and egress

The read belongs to the core `vault.passwords` capability. That
capability now declares `external-service` egress to "the git
repositories a person lists as item-type marketplaces" with
`automatic: false`:

- a read starts only when a person opens the Marketplace tab or presses
  a source's reload key;
- nothing is read on page load or in the background, and a
  `minimal-local` profile makes no request.

ADR 0065 records the new operation `vault.item_types.marketplace` for
the PWA. It is excluded from every agent surface for ADR 0087's reason:
an agent that could choose the types on offer could shape the form a
human is later asked to fill in.

## Consequences

- Finding a type is now a browse. Publishing one is a commit to any
  public git repository that has an index.
- The page has a new outbound destination class: public forges. It is
  never automatic. A person names every destination, and our
  marketplace is the only one listed by default.
- Pins make ours tamper-evident at the byte level. A third-party index
  may omit them, and then its bytes are whatever its host serves. They
  still meet the parser and the registry either way.
- The marketplaces file is per device, not synced. Which public
  repositories someone reads is not worth a body-format change. The
  installed types are synced, and they are what matters.
- Other categories can become files the same way: a provider in
  `packages/app-core`, registered for the category in
  `apps/pages/src/sections/settings/files/providers.ts`. A category with
  no provider shows its document alone, as before.
- The Bitbucket main-branch lookup and the GitLab and Gitea API routes
  depend on those forges' CORS for anonymous reads. A self-hosted
  instance that refuses cross-origin reads can still be listed by the raw
  address of its index behind any host that serves it.
