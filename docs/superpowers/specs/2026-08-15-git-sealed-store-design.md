# Git-native sealed store (`pass` parity)

**Date:** 2026-08-15  
**Status:** Approved  
**Scope:** CLI store verbs, classic `~/.password-store` interop, Pages PWA ↔ git bridge, agent ConnectionRef path

## Problem

Developers want Unix `pass`-style workflow: hierarchical encrypted secrets in a git repo, usable from a CLI, interoperable with existing `~/.password-store` trees, synced with the Pages “This device” vault, and usable by agents **without** plaintext reveal (ADR 0005).

Today OpenSesame has:

- Pages OPFS vault (AES-GCM sealed blob) for human items
- Host CLI `secret get/list` that shells out to the external `pass` binary for `password-store` connections
- Catalog entries `password-store` and `sealed-local`
- No native git-backed store engine and no `pass`-parity verbs on `opensesame`

## Goals

1. **CLI-first sealed store** under the `opensesame` binary (no `pass` subcommand namespace)
2. **Interop** with classic `~/.password-store` (`.gpg`, optional `.age`)
3. **PWA bridge** so Pages vault items sync with the same logical tree
4. **Agent path** that never exposes `show` / `getSecret` — only ConnectionRef → authorize → invoke → receipt

## Non-goals (v1)

- Bitwarden/1Password cloud sync protocols
- Replacing Host-held OAuth connectors with store files
- Platform keychain / Windows Hello as sole recipient (later)
- Requiring the external `pass` binary

## Decision summary

| Topic | Choice |
|-------|--------|
| Approach | Native Rust store engine + format adapters |
| CLI naming | Top-level verbs on `opensesame` (insert/show/…); no `pass` group |
| Store init | `opensesame init --sealed-store` (existing `init` for `.env.schema` unchanged) |
| Default root | `PASSWORD_STORE_DIR` → else `~/.password-store`; override `OPENSESAME_STORE_DIR` |
| New ciphertext | `.osseal` (OpenSesame envelope) |
| Classic | Read/write `.gpg` (Sequoia preferred, `gpg` fallback); `.age` when recipients present |
| Mixed trees | Allowed in one root |
| Agents | `password-store` / `sealed-local` via ConnectionRef only; deny reveal |
| Provider | Replace shell-out to `pass` with the native engine |

## Architecture

```
┌─────────────┐   unlock/recipients    ┌──────────────────────┐
│ Pages PWA   │◄──── sync pull/push ──►│  sealed-store engine │
│ (OPFS vault)│                        │  (crates/sealed-store)│
└─────────────┘                        └──────────┬───────────┘
                                                  │
┌─────────────┐   insert/show/git/…               │ path tree
│ opensesame  │───────────────────────────────────┤ .osseal / .gpg / .age
│ (apps/cli)  │                                   │ git auto-commit
└─────────────┘                                   ▼
                                       ┌──────────────────────┐
┌─────────────┐   ConnectionRef       │  store root (git)     │
│ Agent / MCP │── invoke / receipt ──►│  ~/.password-store    │
│ (no reveal) │   Host egress inject  └──────────────────────┘
└─────────────┘         ▲
                        │
              gateway + connector-host
              (human Read/List only on CLI)
```

### Components

| Piece | Location | Responsibility |
|-------|----------|----------------|
| Store engine | `crates/sealed-store` | Path CRUD, list/find/grep, git hooks, format dispatch |
| Envelope crypto | `crates/human-vault` (existing) + sealed-store | Reuse AEAD/wrap primitives; `.osseal` on-disk framing in sealed-store |
| Format adapters | `crates/sealed-store` | `.osseal`, `.gpg`, `.age` |
| CLI verbs | `apps/cli` | Human UX; `--reveal` gates |
| Provider plans | `crates/connector-host` | `password-store` / `sealed-local` use engine; no `pass` binary |
| PWA sync | `apps/pages` | Map vault items ↔ paths; merge; settings |
| Optional helper | `apps/daemon` | Local sync assist for github.io ↔ store (when configured) |
| ADR | `docs/adr/0037-git-sealed-store.md` | Record decision |

## On-disk format

### Layout

`pass`-compatible hierarchy under the store root:

```
~/.password-store/
  .gpg-id                 # classic recipients (optional)
  .age-recipients         # optional
  .opensesame-recipients  # native recipients (age and/or OS identity pubs)
  .git/                   # optional but expected for source-control workflow
  Email/github.com.gpg    # classic
  Dev/api-token.osseal    # native
```

### Entry body (plaintext before seal)

Compatible with `pass`:

1. First line: primary secret
2. Remaining lines: freeform metadata (and/or structured fields for OpenSesame kinds)

For PWA round-trip, sealed body MAY include a JSON metadata trailer after a blank line delimiter when the entry was written by OpenSesame (kind, uris, totp, ceiling, etc.). Classic `pass` readers that only use line 1 remain compatible.

### `.osseal` envelope

- Random 256-bit content key
- Content encrypted with AES-256-GCM (96-bit nonce)
- Content key wrapped to each recipient (age X25519 and/or OpenSesame device/identity pubkey)
- Header: version, recipient stubs, algorithm ids — no plaintext secrets
- AEAD failure ⇒ treat as wrong key or tamper; never emit partial plaintext

### Recipient policy

- Mutating writes encrypt to all recipients listed for that format
- Changing recipients re-encrypts affected entries (explicit `opensesame init --sealed-store` re-init or a dedicated rewrap command in implementation)
- Private keys never enter the git tree

## CLI surface

Human-only store verbs on the host CLI binary `opensesame`:

| Command | Behavior |
|---------|----------|
| `init --sealed-store [--path] [--recipient …]` | Create store root, recipients file(s), optional `git init` |
| `insert <name>` | Insert (prompt or stdin); encrypt; git commit if repo |
| `generate <name> [--length] [--no-symbols] …` | Generate + insert |
| `show <name>` | Decrypt to stdout; requires TTY or `--reveal` |
| `ls [path]` | List tree |
| `find <query>` / `grep <query>` | Name / decrypted-content search (human only) |
| `cp` / `mv` / `rm` / `edit` | `pass` semantics |
| `git <args…>` | Git passthrough in store root |

**Unchanged:**

- `opensesame init` without `--sealed-store` continues to initialize `.env.schema`
- `opensesame secret get/list` remain connection-scoped human reads; `password-store` provider uses the engine
- Host `invoke` / MCP / agent APIs do **not** gain reveal commands

**Defaults:**

- Store root resolution: `OPENSESAME_STORE_DIR` → `PASSWORD_STORE_DIR` → `~/.password-store`
- Auto-commit message style aligned with `pass` (`Add …`, `Edit …`, `Remove …`)

## Classic `pass` interop

- Read existing `.gpg` entries without migrating
- Write `.gpg` when `.gpg-id` is present and no OpenSesame-only policy forces `.osseal`
- Prefer writing `.osseal` when `.opensesame-recipients` exists and `.gpg-id` does not
- If both exist: write `.osseal` for new OpenSesame CLI inserts; leave existing `.gpg` until edited (edit rewrites in place same extension unless `--format` overrides)
- Drop dependency on invoking the `pass` binary in `crates/connector-host`

## PWA ↔ git bridge

### Path mapping

| Vault field | Store path |
|-------------|------------|
| `folder` + `name` | `Folder/name` (sanitize `/` and empty folder → top-level) |
| `kind` | Metadata in sealed body |
| login password / secret value | Line 1 |
| notes, uris, totp, ceiling, fields | Trailer after blank line |

### Sync

- **Pull:** open store (human unlock / agent-unavailable) → decrypt entries → merge into OPFS vault using the same merge preview rules as password-manager import
- **Push:** vault → sealed files under store root → commit (and push if remote configured)
- Settings expose store path / remote; never upload plaintext to Identity or Host
- Offline Pages: OPFS remains authoritative until sync runs (CLI or daemon helper)

## Agent path

- Catalog providers `password-store` and `sealed-local` bind a store path (or subtree) to a ConnectionRef
- Agents: authorize → invoke → receipt; Host may inject material at egress only
- Explicitly denied: agent `show`, `secret get`, MCP tools that print plaintext, L3 materialize unless `raw_credential_export` (default deny)
- PWA secret-item ceilings continue to bound grants that reference store-backed connections

## Security invariants

1. No public `getSecret()` on agent surfaces (ADR 0005)
2. CLI plaintext requires interactive TTY or explicit `--reveal`
3. Ciphertext-only in git; gitleaks allowlist for store paths; block accidental plaintext commits via hook guidance
4. Session keys in memory only; lock clears them
5. No sudo; no privilege escalation for gpg-agent access beyond user session

## Error handling

| Condition | Behavior |
|-----------|----------|
| Missing store / not initialized | Clear error with `init --sealed-store` hint |
| No matching recipient / wrong passphrase | Fail closed; no plaintext |
| Corrupt AEAD / GPG | Fail closed |
| `show` without TTY and without `--reveal` | Bail with same message family as `secret get` |
| Agent attempts reveal | Hard deny at API boundary |

## Testing

- Unit: path CRUD, mixed extensions, recipient wrap/unwrap, git auto-commit
- Fixture: sample `password-store` tree with known plaintext under test keys
- PWA: push/pull merge round-trip; conflict preview
- CLI: `--reveal` gate; non-TTY refusal
- Provider: `password-store` Read/List without `pass` binary
- Agent/gateway: invoke allowed, reveal denied
- Fuzz: extend vault/envelope fuzz targets to `.osseal`

## Documentation

- ADR 0037 capturing this decision
- Update `AGENTS.md` crib sheet with store commands
- Pages README: Settings sync section
- Security note if new audit surface appears (dated audit doc only when a bug is found)

## Implementation phasing (for the plan)

Single product, four delivery slices that each leave the tree green:

1. **Engine + `.osseal` + CLI verbs** (git auto-commit)
2. **GPG/age adapters + drop `pass` shell-out**
3. **PWA pull/push bridge**
4. **Agent ConnectionRef binding + deny tests**

## Alternatives considered

1. **Shell-out to `pass` forever** — rejected: no crypto ownership, fragile agent/host story
2. **Whole-repo git-crypt/SOPS only** — rejected: not hierarchical `pass` parity; weak PWA mapping
3. **GPG-only canonical format** — rejected: painful multi-recipient UX; keep as interop, not default for new OpenSesame writes
