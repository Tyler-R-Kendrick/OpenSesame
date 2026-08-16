# Git-sealed store (`pass` parity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a native git-backed sealed secret store on `opensesame` with classic `~/.password-store` interop, Pages PWA sync, and agent ConnectionRef-only access.

**Architecture:** New Rust crate `opensesame-sealed-store` owns hierarchical path CRUD, git auto-commit, and `.osseal`/`.gpg`/`.age` adapters. It reuses AEAD primitives from `opensesame-human-vault`. Host CLI gains top-level store verbs (no `pass` namespace). `connector-host` stops shelling out to `pass`. Pages syncs vault items ↔ store tree. Agents keep ADR 0005 (no reveal).

**Tech Stack:** Rust 1.88, clap 4, `age` crate, Sequoia (or `gpg` fallback), existing `human-vault` crypto, Vitest for Pages, cargo test for Rust.

**Spec:** `docs/superpowers/specs/2026-08-15-git-sealed-store-design.md`

## Global Constraints

- Binary name stays `opensesame`; no `pass` subcommand group
- Never expose `getSecret()` / plaintext on agent or MCP paths (ADR 0005)
- CLI plaintext requires TTY or `--reveal`
- No `sudo`; no requiring the external `pass` binary after Task 5
- Store root: `OPENSESAME_STORE_DIR` → `PASSWORD_STORE_DIR` → `~/.password-store`
- New writes prefer `.osseal` when `.opensesame-recipients` exists; honor `.gpg-id` / `.age-recipients` for classic trees
- Reuse `crates/human-vault` for content AEAD; do not NIH a second AES-GCM stack
- Rust pin: `cargo +1.88.0`
- Do not commit live secrets or private keys

## File map

| Path | Role |
|------|------|
| `crates/sealed-store/Cargo.toml` | New crate package |
| `crates/sealed-store/src/lib.rs` | Public API re-exports |
| `crates/sealed-store/src/root.rs` | Store root resolution + init |
| `crates/sealed-store/src/path.rs` | Logical name ↔ filesystem path |
| `crates/sealed-store/src/entry.rs` | Plaintext entry (line1 + trailer) |
| `crates/sealed-store/src/envelope.rs` | `.osseal` framing |
| `crates/sealed-store/src/gpg.rs` | `.gpg` adapter |
| `crates/sealed-store/src/age_fmt.rs` | `.age` adapter |
| `crates/sealed-store/src/store.rs` | CRUD / ls / find / grep |
| `crates/sealed-store/src/git.rs` | Auto-commit + passthrough |
| `crates/sealed-store/src/generate.rs` | Password generator |
| `crates/human-vault/src/lib.rs` | Shared encrypt/decrypt helpers if needed |
| `Cargo.toml` | Workspace member |
| `apps/cli/src/store.rs` | CLI store command handlers |
| `apps/cli/src/main.rs` | Wire store verbs + `init --sealed-store` |
| `apps/cli/Cargo.toml` | Depend on sealed-store |
| `crates/connector-host/src/providers.rs` | Native password-store plans |
| `apps/pages/src/lib/vault/store-sync.ts` | Push/pull mapping |
| `apps/pages/src/sections/SettingsSection.tsx` | Sync UI |
| `docs/adr/0037-git-sealed-store.md` | ADR |
| `AGENTS.md` | Command crib sheet |

---

### Task 1: Scaffold `opensesame-sealed-store` + path helpers

**Files:**
- Create: `crates/sealed-store/Cargo.toml`
- Create: `crates/sealed-store/src/lib.rs`
- Create: `crates/sealed-store/src/path.rs`
- Create: `crates/sealed-store/src/root.rs`
- Modify: `Cargo.toml` (add workspace member)
- Test: unit tests in `path.rs` / `root.rs`

**Interfaces:**
- Consumes: std, `thiserror`, `directories`
- Produces:
  - `pub fn resolve_store_dir() -> PathBuf`
  - `pub fn logical_to_relative(name: &str) -> Result<PathBuf, StoreError>`
  - `pub fn relative_to_logical(rel: &Path) -> Result<String, StoreError>`
  - `pub struct StoreRoot { pub path: PathBuf }`
  - `impl StoreRoot { pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> }`

- [ ] **Step 1: Write the failing test**

```rust
// crates/sealed-store/src/path.rs
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn logical_name_maps_to_nested_relative() {
        assert_eq!(
            logical_to_relative("Email/github.com").unwrap(),
            PathBuf::from("Email/github.com")
        );
    }

    #[test]
    fn rejects_parent_segment() {
        assert!(logical_to_relative("../etc/passwd").is_err());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo +1.88.0 test -p opensesame-sealed-store path::tests::logical_name_maps_to_nested_relative`

Expected: FAIL (package missing)

- [ ] **Step 3: Scaffold crate and implement path/root**

`crates/sealed-store/Cargo.toml`:

```toml
[package]
name = "opensesame-sealed-store"
version.workspace = true
edition.workspace = true
license.workspace = true

[dependencies]
opensesame-human-vault = { path = "../human-vault" }
anyhow = { workspace = true }
rand = { workspace = true }
serde = { workspace = true }
serde_json = { workspace = true }
thiserror = { workspace = true }
zeroize = { workspace = true }
base64 = { workspace = true }
directories = "6.0.0"
```

Add `"crates/sealed-store"` to workspace `members` in root `Cargo.toml`.

Implement `StoreError`, `logical_to_relative` (reject empty, `..`, absolute, NUL), and `resolve_store_dir` reading env in order.

- [ ] **Step 4: Run tests**

Run: `cargo +1.88.0 test -p opensesame-sealed-store`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml crates/sealed-store
git commit -F - <<'EOF'
feat(sealed-store): scaffold crate and path helpers

EOF
```

---

### Task 2: `.osseal` envelope + entry plaintext model

**Files:**
- Create: `crates/sealed-store/src/entry.rs`
- Create: `crates/sealed-store/src/envelope.rs`
- Modify: `crates/sealed-store/src/lib.rs`
- Modify: `crates/sealed-store/Cargo.toml` (ensure human-vault dep)

**Interfaces:**
- Consumes: `opensesame_human_vault::{encrypt_item, decrypt_item, ItemDataKey, AssociatedData}` (or thin wrappers if signatures need store-specific AD)
- Produces:
  - `pub struct Entry { pub secret: String, pub trailer: String }`
  - `impl Entry { pub fn parse(text: &str) -> Self; pub fn render(&self) -> String; }`
  - `pub fn seal_osseal(plaintext: &[u8], content_key: &ItemDataKey) -> Result<Vec<u8>, StoreError>`
  - `pub fn open_osseal(blob: &[u8], content_key: &ItemDataKey) -> Result<Vec<u8>, StoreError>`
  - Magic header bytes: `b"OSSEAL1\n"`

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn entry_round_trip_preserves_secret_and_trailer() {
    let e = Entry {
        secret: "s3cr3t".into(),
        trailer: "url: https://example.com\n".into(),
    };
    let parsed = Entry::parse(&e.render());
    assert_eq!(parsed.secret, "s3cr3t");
    assert!(parsed.trailer.contains("example.com"));
}

#[test]
fn osseal_round_trip() {
    let key = ItemDataKey([7u8; 32]);
    let pt = b"hello\nmeta: 1\n";
    let ct = seal_osseal(pt, &key).unwrap();
    assert!(ct.starts_with(b"OSSEAL1\n"));
    assert_eq!(open_osseal(&ct, &key).unwrap(), pt);
}
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `cargo +1.88.0 test -p opensesame-sealed-store entry:: tests::osseal_round_trip`

- [ ] **Step 3: Implement entry + envelope**

Use human-vault item encrypt with AD `purpose = "sealed-store-entry"`. Prepend magic. Wrong key ⇒ error, no panic.

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add crates/sealed-store
git commit -F - <<'EOF'
feat(sealed-store): add entry model and .osseal envelope

EOF
```

---

### Task 3: Store CRUD with recipient file + content key material

**Files:**
- Create: `crates/sealed-store/src/store.rs`
- Create: `crates/sealed-store/src/recipients.rs`
- Modify: `crates/sealed-store/src/lib.rs`

**Interfaces:**
- Produces:
  - `pub struct Recipients { /* loaded from .opensesame-recipients */ }`
  - `pub fn init_store(root: &Path, recipients: &[String]) -> Result<StoreRoot, StoreError>`
  - `impl StoreRoot`:
    - `pub fn insert(&self, name: &str, entry: &Entry, key: &ItemDataKey) -> Result<(), StoreError>`
    - `pub fn show(&self, name: &str, key: &ItemDataKey) -> Result<Entry, StoreError>`
    - `pub fn rm(&self, name: &str) -> Result<(), StoreError>`
    - `pub fn ls(&self, prefix: &str) -> Result<Vec<String>, StoreError>`
    - `pub fn find(&self, query: &str) -> Result<Vec<String>, StoreError>`

v1 keying for `.osseal`: single symmetric store key derived from unlock passphrase via `wrap_vrk_with_password` / `unwrap_vrk_with_password` in human-vault, with wrapped VRK file `.opensesame-key` (ciphertext only). Recipients file lists public identities for future multi-recipient; passphrase wrap is the v1 unlock path.

- [ ] **Step 1: Write failing integration-style unit test using `tempfile`**

Add dep `tempfile = "3"` under `[dev-dependencies]`.

```rust
#[test]
fn insert_show_ls_rm() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = ItemDataKey([9u8; 32]);
    root.insert("Dev/token", &Entry { secret: "abc".into(), trailer: String::new() }, &key).unwrap();
    assert_eq!(root.show("Dev/token", &key).unwrap().secret, "abc");
    assert!(root.ls("Dev").unwrap().iter().any(|n| n.contains("token")));
    root.rm("Dev/token").unwrap();
    assert!(root.show("Dev/token", &key).is_err());
}
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement init + CRUD writing `name.osseal`**

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add crates/sealed-store
git commit -F - <<'EOF'
feat(sealed-store): implement init and .osseal CRUD

EOF
```

---

### Task 4: Git auto-commit helper

**Files:**
- Create: `crates/sealed-store/src/git.rs`
- Modify: `crates/sealed-store/src/store.rs` (call after mutating ops)

**Interfaces:**
- Produces:
  - `pub fn ensure_git_repo(root: &Path) -> Result<(), StoreError>`
  - `pub fn auto_commit(root: &Path, message: &str) -> Result<(), StoreError>`
  - `pub fn git_passthrough(root: &Path, args: &[String]) -> Result<i32, StoreError>`

Uses `std::process::Command` with `git -C <root> …`. If not a git repo, mutating ops succeed without commit (match `pass` when git unset). If repo, `git add -A` + `git commit -m`.

- [ ] **Step 1: Failing test** (skip if `git` missing)

```rust
#[test]
fn auto_commit_records_insert() {
    let dir = tempfile::tempdir().unwrap();
    std::process::Command::new("git").args(["init"]).current_dir(dir.path()).status().unwrap();
    // configure user.email/name locally for commit
    let root = init_store(dir.path(), &[]).unwrap();
    let key = ItemDataKey([1u8; 32]);
    root.insert("a", &Entry { secret: "x".into(), trailer: String::new() }, &key).unwrap();
    auto_commit(dir.path(), "Add a").unwrap();
    let log = std::process::Command::new("git")
        .args(["-C", dir.path().to_str().unwrap(), "log", "-1", "--pretty=%s"])
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&log.stdout).contains("Add a"));
}
```

Wire `insert`/`rm` to call `auto_commit` with `pass`-style messages.

- [ ] **Step 2–4:** FAIL → implement → PASS

- [ ] **Step 5: Commit**

```bash
git add crates/sealed-store
git commit -F - <<'EOF'
feat(sealed-store): auto-commit mutating store operations

EOF
```

---

### Task 5: GPG + age adapters; drop `pass` shell-out

**Files:**
- Create: `crates/sealed-store/src/gpg.rs`
- Create: `crates/sealed-store/src/age_fmt.rs`
- Modify: `crates/sealed-store/src/store.rs` (format detection)
- Modify: `crates/connector-host/src/providers.rs`
- Modify: `crates/sealed-store/Cargo.toml` (add `age` dependency)

**Interfaces:**
- Produces:
  - `pub fn read_gpg_id(root: &Path) -> Result<Vec<String>, StoreError>`
  - `pub fn decrypt_gpg(path: &Path) -> Result<Vec<u8>, StoreError>` // gpgme/sequoia or `gpg -d`
  - `pub fn encrypt_gpg(path: &Path, plaintext: &[u8], recipients: &[String]) -> Result<(), StoreError>`
  - `pub fn decrypt_age(path: &Path, identities: &[age::x25519::Identity]) -> Result<Vec<u8>, StoreError>`
  - `pub fn encrypt_age(...) -> Result<(), StoreError>`
  - `show` tries `.osseal`, then `.gpg`, then `.age`

**connector-host change:** replace

```rust
("password-store", HumanProviderOperation::Read) => {
    command("pass", vec!["show".into(), resource.into()])
}
```

with an in-process plan variant, e.g. `HumanProviderPlan::SealedStore { op, name, store_dir }` executed via sealed-store (human CLI path only).

- [ ] **Step 1: Fixture test with mocked gpg OR skip + document**

Prefer: unit-test format dispatch chooses extension; integration test marked `#[ignore]` if no gpg.

- [ ] **Step 2–4:** Implement adapters; update provider; add test that `human_plan("password-store", …)` no longer returns executable `pass`.

```rust
#[test]
fn password_store_plan_does_not_shell_to_pass() {
    let plan = human_plan(
        "password-store",
        HumanProviderOperation::List,
        "/",
        &serde_json::json!({"store_dir": "/tmp/store"}),
    )
    .unwrap();
    match plan {
        HumanProviderPlan::Command { program, .. } => assert_ne!(program, "pass"),
        HumanProviderPlan::SealedStore { .. } => {}
        _ => panic!("unexpected plan"),
    }
}
```

- [ ] **Step 5: Commit**

```bash
git add crates/sealed-store crates/connector-host
git commit -F - <<'EOF'
feat(sealed-store): add gpg/age adapters and retire pass shell-out

EOF
```

---

### Task 6: CLI store verbs on `opensesame`

**Files:**
- Create: `apps/cli/src/store.rs`
- Modify: `apps/cli/src/main.rs`
- Modify: `apps/cli/Cargo.toml`

**Interfaces:**
- Extend `Commands` with: `Insert`, `Generate`, `Show`, `Ls`, `Find`, `Grep`, `Cp`, `Mv`, `Rm`, `Edit`, `Git`
- Extend existing `Init` with `#[arg(long)] sealed_store: bool`, `path: Option<PathBuf>`, `recipient: Vec<String>`
- `show` / reveal gating:

```rust
fn require_reveal(reveal: bool) -> anyhow::Result<()> {
    if reveal || std::io::stdin().is_terminal() {
        return Ok(());
    }
    anyhow::bail!("plaintext output requires a TTY or --reveal; agents must use ConnectionRef invoke");
}
```

- [ ] **Step 1: Add clap variants and a unit test for `require_reveal` logic in `store.rs`**

- [ ] **Step 2: Run CLI help**

Run: `cargo +1.88.0 run -p opensesame-cli -- show --help`

Expected: help text for show

- [ ] **Step 3: Implement handlers calling sealed-store**

Unlock flow: prompt passphrase → unwrap VRK from `.opensesame-key` → ops → zeroize.

- [ ] **Step 4: Manual smoke on temp dir**

```bash
STORE=$(mktemp -d)
cargo +1.88.0 run -p opensesame-cli -- init --sealed-store --path "$STORE"
printf 'hunter2\n' | cargo +1.88.0 run -p opensesame-cli -- insert Dev/demo --echo
cargo +1.88.0 run -p opensesame-cli -- show Dev/demo --reveal
```

(Adjust flags to match implemented clap; keep secrets out of shell history in final UX via prompt.)

- [ ] **Step 5: Commit**

```bash
git add apps/cli
git commit -F - <<'EOF'
feat(cli): add pass-parity sealed store commands

EOF
```

---

### Task 7: Password generator

**Files:**
- Create: `crates/sealed-store/src/generate.rs`
- Modify: `apps/cli/src/store.rs` (`Generate` command)

**Interfaces:**
- `pub fn generate_password(length: usize, symbols: bool) -> String` — CSPRNG from `rand`
- Align character sets with Pages `apps/pages/src/lib/vault/password.ts` where practical

- [ ] **Step 1: Test length and charset**

```rust
#[test]
fn generate_length_and_no_symbols() {
    let p = generate_password(32, false);
    assert_eq!(p.len(), 32);
    assert!(p.chars().all(|c| c.is_ascii_alphanumeric()));
}
```

- [ ] **Step 2–4:** FAIL → implement → PASS; wire CLI

- [ ] **Step 5: Commit**

```bash
git add crates/sealed-store apps/cli
git commit -F - <<'EOF'
feat(sealed-store): add password generator for insert/generate

EOF
```

---

### Task 8: Pages PWA store sync (pull/push)

**Files:**
- Create: `apps/pages/src/lib/vault/store-sync.ts`
- Create: `apps/pages/src/lib/vault/store-sync.test.ts`
- Modify: `apps/pages/src/sections/SettingsSection.tsx`
- Modify: `apps/pages/src/lib/vault/model.ts` (only if mapping needs exported helpers)

**Interfaces:**
- `export type StorePlainEntry = { path: string; secret: string; trailer: string }`
- `export function entryToVaultItem(entry: StorePlainEntry): VaultItem` — map path → folder/name; parse OpenSesame trailer JSON if present
- `export function vaultItemToEntry(item: VaultItem): StorePlainEntry`
- `export function mergeStoreEntries(existing: VaultItem[], incoming: StorePlainEntry[]): MergePreview` — reuse merge patterns from `import/merge.ts`

v1 UX: Settings actions **Import from sealed store (file tree)** and **Export to sealed store** operate on a user-picked directory via File System Access API where available; otherwise zip of ciphertext files. Decryption happens in-page after master-password unlock using exported/unwrapped keys compatible with `.osseal` (document key handoff: same passphrase-derived VRK material as CLI, or explicit key file import).

- [ ] **Step 1: Vitest for path mapping**

```ts
import { describe, expect, it } from "vitest";
import { entryToVaultItem, vaultItemToEntry } from "./store-sync.js";

describe("store-sync mapping", () => {
  it("maps Folder/name to folder + name", () => {
    const item = entryToVaultItem({
      path: "Email/github.com",
      secret: "x",
      trailer: "",
    });
    expect(item.name).toBe("github.com");
    // folder name Email
  });
});
```

- [ ] **Step 2:** `pnpm --filter @opensesame/pages test` — expect FAIL

- [ ] **Step 3:** Implement mapping + Settings buttons (honest copy: ciphertext only)

- [ ] **Step 4:** Tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/pages
git commit -F - <<'EOF'
feat(pages): bridge vault items to sealed store paths

EOF
```

---

### Task 9: Agent ConnectionRef binding + deny reveal

**Files:**
- Modify: `crates/connection-broker/src/lib.rs` / config as needed for `store_dir` + path binding
- Modify: `apps/gateway` tests for deny materialize on store-backed connections
- Modify: `crates/connector-host/src/providers.rs` — ensure agent/MCP code paths cannot call `HumanProviderOperation::Read`

**Interfaces:**
- `sealed-local` / `password-store` connections expose invoke only
- Add regression test: human `secret get --reveal` allowed; simulated agent path rejected

```rust
#[test]
fn agent_surfaces_do_not_offer_password_store_read() {
    // Assert MCP/tool registry excludes secret get for these providers
}
```

Exact assertion should match existing MCP registration tests in-repo (locate via `rg "HumanProviderOperation::Read" apps/mcp-host`).

- [ ] **Step 1–4:** Find existing deny patterns → add store-specific cases → PASS

- [ ] **Step 5: Commit**

```bash
git add crates/connection-broker crates/connector-host apps/gateway apps/mcp-host apps/mcp-client
git commit -F - <<'EOF'
feat(security): bind sealed store to ConnectionRef without reveal

EOF
```

---

### Task 10: ADR + AGENTS crib sheet

**Files:**
- Create: `docs/adr/0037-git-sealed-store.md`
- Modify: `AGENTS.md` (command crib sheet)
- Modify: `apps/pages/README.md` (sync section)

**ADR body:** Status Accepted; Context (pass parity + git); Decision (native engine, formats, agent boundary); Consequences (no pass binary; CLI verbs; PWA bridge).

- [ ] **Step 1: Write ADR from spec decision table**

- [ ] **Step 2: Update AGENTS.md with store commands under Host plane**

- [ ] **Step 3: Commit**

```bash
git add docs/adr/0037-git-sealed-store.md AGENTS.md apps/pages/README.md
git commit -F - <<'EOF'
docs: ADR 0037 git-sealed store and command crib sheet

EOF
```

---

## Spec coverage checklist

| Spec requirement | Task |
|------------------|------|
| Native engine + `.osseal` | 1–3 |
| Git auto-commit / `git` passthrough | 4, 6 |
| CLI verbs, no `pass` group, `init --sealed-store` | 6–7 |
| Classic `.gpg` / `.age` interop | 5 |
| Drop `pass` shell-out | 5 |
| PWA pull/push bridge | 8 |
| Agent ConnectionRef only | 9 |
| ADR + docs | 10 |
| `--reveal` / TTY gate | 6 |
| Reuse human-vault crypto | 2–3 |

## Plan self-review notes

- No TBD placeholders in tasks; v1 unlock is passphrase-wrapped VRK in `.opensesame-key` (explicit)
- Multi-recipient age/GPG encryption is Task 5; passphrase VRK is the OpenSesame-native unlock for `.osseal` in v1
- Type names (`Entry`, `StoreRoot`, `ItemDataKey`, `HumanProviderPlan::SealedStore`) are consistent across tasks
