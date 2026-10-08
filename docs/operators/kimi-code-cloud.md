# Kimi Code CLI on Cursor Cloud Agents

OpenSesame Cloud Agent images install **Kimi Code CLI** (`@moonshot-ai/kimi-code`,
pinned in [`.cursor/Dockerfile`](../../.cursor/Dockerfile)) on `PATH` for login
shells via `/etc/profile.d/kimi-code.sh` (same pattern as cargo).

## Authentication order

1. **Device OAuth** — run `kimi login` once on the VM (device code). Tokens live
   under `~/.kimi-code/credentials/*.json`. Never commit or print them.
2. **Optional API key** — Cursor **Runtime Secrets**:
   - `KIMI_MODEL_API_KEY` (required for this path)
   - `KIMI_MODEL_NAME` (use `k3` or `kimi-k3` for Kimi K3)
   - `KIMI_MODEL_BASE_URL` (optional override)

Plain `KIMI_API_KEY` is **not** read by Kimi Code; use `KIMI_MODEL_API_KEY`.

## Headless automation

Model **K3** is pinned with `-m k3` (catalog alias `kimi-k3` on Moonshot
providers). Non-interactive runs use JSON stream output:

```bash
scripts/dev/kimi-preflight.sh
scripts/dev/kimi-headless.sh -p "your prompt"
```

`kimi-headless.sh` unsets `KIMI_API_KEY` and, by default, `KIMI_MODEL_*` so a
depleted or test runtime secret does not shadow OAuth (`KIMI_HEADLESS_PREFER_OAUTH=0`
keeps API-key env for key-only runs). For `-p` runs it adds `--output-format
stream-json` and `-m k3` when you did not pass them (`--auto` is not combined
with `-p`).

## When to use Cursor Agent instead

Use Kimi for remaining batch automation while quota allows. Switch to Cursor
Agent when Kimi returns payment/quota errors or `kimi-preflight.sh` fails with
no OAuth and no `KIMI_MODEL_API_KEY`. Record the reason in audit/provenance
notes (see [2026-10-provenance.md](../audit/2026-10-provenance.md)).
