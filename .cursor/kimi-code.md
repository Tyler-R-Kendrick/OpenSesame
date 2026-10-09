# Kimi Code CLI on Cursor Cloud Agents

OpenSesame cloud agents use **`kimi`** (Kimi Code CLI) for delegated fix work, parallel to **`grok`** (Grok Build). The image installs the official binary; each VM still needs a one-time **Kimi Code subscription** sign-in (`kimi login`, OAuth device code — not a Kimi Open Platform API key).

Upstream reference: [Kimi Code docs](https://moonshotai.github.io/kimi-code/) (configuration, `kimi` command, providers).

## Image install

Defined in [`.cursor/Dockerfile`](Dockerfile):

- `KIMI_INSTALL_DIR=/usr/local` → binary at `/usr/local/bin/kimi`
- Build verifies `kimi --version` (pinned release from `https://code.kimi.com/kimi-code/install.sh`)

## Kimi K3 model id

| What | Value |
| --- | --- |
| **Model alias** (CLI `-m` and `default_model`) | `kimi-code/k3` |
| **Upstream model id** (in `config.toml` `[models."kimi-code/k3"].model`) | `k3` |
| **Display name** | K3 |

After `kimi login`, the managed Kimi provider and model table are written into `~/.kimi-code/config.toml`. To make K3 the default for every invocation (when the subscription includes it), set:

```toml
default_model = "kimi-code/k3"
```

You can confirm aliases with `kimi provider list` (requires login). Override per run with `-m` / `--model` even when `default_model` is set.

Other coding aliases from the same subscription (examples from upstream docs): `kimi-code/kimi-for-coding`, `kimi-code/kimi-for-coding-highspeed`.

## Authentication

```bash
kimi login
```

- Prints a **verification URL** and **user code** on stderr, then polls until approved or cancelled.
- Optional: `kimi login --region global` (kimi.ai) vs default mainland (kimi.com).
- Do **not** use `KIMI_API_KEY` / Open Platform keys for this flow.

### Credential and config locations

Root: `$KIMI_CODE_HOME` (default `~/.kimi-code/`).

| Path | Purpose |
| --- | --- |
| `config.toml` | Providers, models, `default_model` (populated by login) |
| `credentials/<name>.json` | OAuth tokens (`0700` dir, `0600` files) |
| `logs/kimi-code.log` | Diagnostic log |
| `sessions/` | Session history |

Credentials survive only if the VM home directory is persistent; unlike Grok, there is no Cursor Runtime Secret for Kimi OAuth.

## Headless fix work (non-interactive)

Print mode (`-p` / `--prompt`) runs one turn, streams assistant text to **stdout**, tool progress to **stderr**, and does **not** open the TUI. It uses the **`auto` permission policy** internally (routine edits and shell commands run without prompts; static deny rules still apply). Do not combine `-p` with `--yolo`, `--auto`, or `--plan`.

**Probe (after login):**

```bash
kimi -m kimi-code/k3 -p "say OK"
```

Expect exit code `0` and a short assistant reply on stdout.

**Prompt from an argument:**

```bash
cd /path/to/repo
kimi -m kimi-code/k3 -p "Fix the failing test in packages/foo without changing public APIs."
```

**Prompt from a file:**

```bash
kimi -m kimi-code/k3 -p "$(cat /path/to/task-prompt.md)"
```

**Structured output (optional):**

```bash
kimi -m kimi-code/k3 -p "List changed files" --output-format stream-json
```

**Resume context:** print mode can attach to the working directory’s session store; for a clean one-shot fix, run from the task worktree without `-c` / `--continue` unless you intentionally want prior session state.

## When Kimi is unavailable — fall back to Cursor Composer

Treat Kimi as **optional capacity**. If the probe or fix invocation fails for auth, configuration, or subscription usage, continue the task with the Cursor agent (Composer) instead of blocking.

### Detecting failures

| Situation | Typical signal | Action |
| --- | --- | --- |
| Not signed in / login incomplete | `No model configured`, `Run \`kimi\` and use /login`, or `Model "kimi-code/k3" is not configured in config.toml` | Ask Tyler to complete `kimi login`; until then use Composer |
| Login / network | `Login failed:`, `fetch failed`, `EAI_AGAIN` on `auth.kimi.com` | Retry login later; use Composer |
| **Subscription usage / quota exhausted** | Process exit non-zero; stderr or log contains HTTP **429** and one of: `exceeded_current_quota_error`, `insufficient_quota`, `quota_exhausted`, or messages matching *exceeded your current quota*, *insufficient balance*, *check your account balance*, *recharge* | Do not retry in a tight loop; use Composer |
| Generic rate limit (429, not quota) | `rate_limit` / retry-after without quota wording | Back off or use Composer |
| Other API errors | `error: failed to run prompt:` plus message in stderr; details in `~/.kimi-code/logs/kimi-code.log` | Fix config or use Composer |

**Agent check (example):**

```bash
if ! kimi -m kimi-code/k3 -p "say OK" >/tmp/kimi-probe.out 2>/tmp/kimi-probe.err; then
  if grep -qiE 'quota|insufficient_quota|exceeded_current_quota|insufficient balance|not configured|/login' /tmp/kimi-probe.err; then
    echo "Kimi unavailable; continuing with Composer"
  fi
fi
```

## Parity with Grok Build

| | Grok Build | Kimi Code CLI |
| --- | --- | --- |
| Binary | `grok` | `kimi` |
| Auth | Cursor secret `XAI_API_KEY` | `kimi login` (device code) |
| Headless | `grok -p "…" --always-approve --output-format json` | `kimi -m kimi-code/k3 -p "…"` |
| Default model | Grok deployment via API key | `default_model = "kimi-code/k3"` or `-m kimi-code/k3` |
