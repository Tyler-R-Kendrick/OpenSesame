# Tombs, pass-otp, and pass-update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship multi-tomb sealed-store registry (portable + optional Linux Tomb), first-class `opensesame pass otp` (pass-otp trailer + structured), and `opensesame pass update` plus Pages single-item update actions.

**Architecture:** Extend `opensesame-sealed-store` Entry with OTP round-trip; add Rust TOTP; CLI verbs under `opensesame pass`; tomb registry resolves active store/key; Pages maps vault totp ↔ store OTP and adds Update actions. Agents never reveal.

**Tech Stack:** Rust 1.88 (`sealed-store`, `opensesame-cli`), clap, existing `human-vault` crypto; Pages TypeScript (`totp.ts`, `store-sync.ts`, ItemDetail); Vitest + `cargo +1.88.0 test`.

**Spec:** [docs/superpowers/specs/2026-08-16-tombs-pass-otp-update-design.md](../specs/2026-08-16-tombs-pass-otp-update-design.md)

## Global Constraints

- No agent `getSecret` / OTP code / update reveal tools (ADR 0005).
- No `sudo` from OpenSesame; Linux Tomb only if user can already run `tomb`.
- OTP on disk: pass-otp `otpauth://` trailer **and** structured field; lossless round-trip.
- Tombs: portable multi-tomb first; `linux-tomb` adapter optional.
- Pages update: single-item only in v1; bulk update is CLI-only.
- Prefer TDD; `cargo +1.88.0 test -p opensesame-sealed-store` and `pnpm --filter @opensesame/pages exec vitest run` for touched areas.

---

## File map

| Path | Responsibility |
|------|----------------|
| `crates/sealed-store/src/entry.rs` | Parse/render OTP in trailer; `Entry.otp` |
| `crates/sealed-store/src/otp.rs` (new) | `OtpUri`, RFC 6238 TOTP, validate |
| `crates/sealed-store/src/tomb_registry.rs` (new) | Load/save tombs.json; resolve active root |
| `crates/sealed-store/src/update.rs` (new) | Update-first-line / multiline helpers |
| `crates/sealed-store/src/lib.rs` | Exports |
| `apps/cli/src/main.rs` | `PassCmd::Otp`, `Update`, `Tomb`, `Open`, `Close` |
| `apps/cli/src/store.rs` | Command implementations |
| `apps/pages/src/lib/vault/store-sync.ts` | totp ↔ otp trailer mapping |
| `apps/pages/src/sections/vault/ItemDetail.tsx` | Update password/secret action |
| `docs/competitors/tomb.md` | Competitor note |
| `docs/competitors/pass.md` | otp/update/tomb bullets |
| `docs/adr/0038-multi-tomb-sealed-store.md` (new) | ADR amendment to 0037 roots |
| `PRODUCT.md` | Capability bullets |

---

### Task 1: Entry OTP parse/render + TOTP engine

**Files:** `crates/sealed-store/src/otp.rs`, `entry.rs`, `lib.rs`

- [ ] Write failing tests: trailer with `otpauth://totp/…` populates `Entry.otp`; render replaces/keeps single otpauth line; RFC 6238 test vector yields expected code.
- [ ] Implement `OtpUri` parse/validate and `totp_code(at_unix)`.
- [ ] Wire `Entry::parse` / `render` to sync `otp` ↔ trailer.
- [ ] `cargo +1.88.0 test -p opensesame-sealed-store`
- [ ] Commit: `feat(sealed-store): otpauth trailer + TOTP engine`

### Task 2: `opensesame pass otp` CLI

**Files:** `apps/cli/src/main.rs`, `apps/cli/src/store.rs`

- [ ] Add `PassCmd::Otp` subcommands: `code`, `insert`, `append`, `uri`, `validate` (default to `code` when name alone if clap allows; else require `code`).
- [ ] Implement insert/append with force/echo/stdin; code prints digits; validate exits 0/1.
- [ ] Smoke test manually or CLI unit where feasible.
- [ ] Commit: `feat(cli): pass otp (pass-otp parity)`

### Task 3: `pass update` core

**Files:** `crates/sealed-store/src/update.rs`, `apps/cli/src/store.rs`, `main.rs`

- [ ] Failing tests: update first line preserves trailer+otp; auto-length; exclude regex skips.
- [ ] Implement update for one path then directory prefix.
- [ ] Wire CLI flags: `-l`, `-a`, `-n`, `-p`, `-m`, `-i`, `-e`, `-f` (clip/edit optional if timeboxed).
- [ ] `cargo +1.88.0 test -p opensesame-sealed-store` + CLI smoke.
- [ ] Commit: `feat(cli): pass update (pass-update parity)`

### Task 4: Tomb registry + active root

**Files:** `crates/sealed-store/src/tomb_registry.rs`, `root.rs` / store open helpers, CLI

- [ ] Failing tests: load/save registry; `active` resolves store+key paths; missing tomb errors.
- [ ] Implement `pass tomb list|add|rm|use` and `--tomb` override on mutating commands.
- [ ] Document env `OPENSESAME_TOMBS_CONFIG`.
- [ ] Commit: `feat(sealed-store): portable multi-tomb registry`

### Task 5: Linux Tomb adapter

**Files:** `apps/cli/src/store.rs` (or `tomb_linux.rs`), registry `backend`

- [ ] Detect `tomb` on PATH; `pass open`/`close` shell out without sudo.
- [ ] Tests: mock or skip-if-missing; unit-test argv construction.
- [ ] Commit: `feat(cli): optional linux tomb open/close adapter`

### Task 6: Pages OTP sync + Update action

**Files:** `store-sync.ts`, tests, `ItemDetail.tsx`, `ItemEditor.tsx` as needed

- [ ] Tests: vault item with totp ↔ store entry otpauth trailer.
- [ ] UI: “Update password” / “Update secret” generate-or-enter flow; preserve totp/notes.
- [ ] `pnpm --filter @opensesame/pages exec vitest run src/lib/vault/`
- [ ] Commit: `feat(pages): vault update action + otp store-sync`

### Task 7: Docs + ADR + PRODUCT

**Files:** `docs/competitors/tomb.md`, `pass.md`, `docs/adr/0038-…`, `PRODUCT.md`, Pages README if needed

- [ ] Write competitor note and ADR 0038 (multi-tomb root resolution).
- [ ] Update PRODUCT capabilities.
- [ ] Commit: `docs: tombs, pass-otp, pass-update design landing`

---

## Verification gate

```bash
cargo +1.88.0 test -p opensesame-sealed-store --all-targets
cargo +1.88.0 build -p opensesame-cli
pnpm --filter @opensesame/pages exec vitest run src/lib/vault/
pnpm --filter @opensesame/pages typecheck
```
