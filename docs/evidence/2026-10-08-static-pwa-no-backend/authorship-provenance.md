# Authorship provenance — static PWA / plane deletion (2026-10-08)

## Attempted automation (Grok Build)

- **Tool:** Grok Build (`scripts/dev/grok-headless.sh` / `grok` CLI)
- **Outcome:** HTTP **402 Payment Required** — Grok Build usage balance exhausted
- **Log:** `/tmp/grok-delete-apis-attempt.log` (captured on the Cloud Agent VM)

```json
{"type":"error","message":"Internal error: {\n  \"message\": \"API error (status 402 Payment Required): Grok Build usage balance exhausted\",\n  \"http_status\": 402\n}"}
```

## Completed work (Cursor Cloud Agent)

- **Agent:** Cursor Cloud Agent on branch `cursor/delete-host-identity-daemon-b359`
- **Scope:** Deletion of Host / Identity / daemon planes from the monorepo, CLI
  strip to relay/local paths, audit and publishing doc updates, and the
  backend-stamp rg gate for static PWA honesty (see `rg-gate.txt` in this folder).
- **Evidence folder:** `docs/evidence/2026-10-08-static-pwa-no-backend/`

Tyler requested honest attribution: Grok did not finish; Cursor Agent carried
the deletion and documentation forward after the 402.

## Follow-up (CLI rewire + checklist) — 2026-10-08

- **Grok Build:** attempted again → HTTP **402** (usage balance exhausted). Log: `/tmp/grok-cli-rewire-attempt.log`.
- **Cursor Cloud Agent:** rewired `doctor`, `config`, `tui`, `security`, and `vault secret|sync|crypto` to local sealed-store / breach-intel / vault-relay paths; updated `removed-cli-commands.md` and `apps/cli/tests/local_rewired_verbs.rs`.

## Restoration (CLI + backend planes) — 2026-10-09

- **Producer:** `live_kimi_code` / Kimi K3, on branch `cursor/restore-cli-backends-b359`.
- **Scope:** PR #865's plane deletion was further than Tyler requested — only
  the PWA was meant to be backend-free (PR #861). The Host (`:8787`),
  Identity (`:8788`) and daemon (`:18790`) planes, the full `opensesame` CLI
  verb tree, compose/ops and publishing workflows, and the deleted test
  surfaces are restored from the #861 tip (`03065913`). `apps/pages` stays
  static; the removal-era `deleted-surfaces.md` / `removed-cli-commands.md`
  are replaced by `restored-surfaces.md` / `restored-cli-commands.md`.
