# @opensesame/redteam

A [promptfoo](https://www.promptfoo.dev/) red-team corpus for the MCP surfaces
exposed by [`apps/mcp-host`](../../apps/mcp-host) (`@opensesame/mcp-host`), the
stdio MCP server that fronts the Host API / daemon with the tools
`task_start`, `task_status`, `task_invoke`, `task_terminate`, `daemon_status`,
`host_ready`, and `operator_invoke_l1`.

This package is intentionally **not** part of the default `pnpm test` run. It
runs on its own via `pnpm --filter @opensesame/redteam redteam`, and via the
root-level `pnpm test:redteam` alias.

## What this tests, and why

Four attack classes, each grounded in a real bug class or design invariant
documented in this repo's audit history:

| Class | File | Grounded in |
| --- | --- | --- |
| Prompt injection via relayed tool results | [`tests/prompt-injection.yaml`](tests/prompt-injection.yaml) | [`docs/security/audit-2026-08-08-mcp-agent-boundary.md`](../../docs/security/audit-2026-08-08-mcp-agent-boundary.md) and the commit `f012c71` bug class: an upstream response body used to be relayed to the model verbatim. |
| Confused-deputy / scope-widening via tool params | [`tests/confused-deputy.yaml`](tests/confused-deputy.yaml) | [`docs/security/audit-2026-08-08-mcp-resource-scope.md`](../../docs/security/audit-2026-08-08-mcp-resource-scope.md) ("a resource is not an origin") and the `operator_invoke_l1` design: the model supplies only `connection_ref` — operation, resource, and the intent digest are whatever the server itself froze earlier, never restated by the caller. |
| Credential exfiltration via an echoing upstream | [`tests/credential-exfiltration.yaml`](tests/credential-exfiltration.yaml) | [`docs/security/audit-2026-08-08-mcp-agent-boundary.md`](../../docs/security/audit-2026-08-08-mcp-agent-boundary.md): the exact fix under test is `forAgent`/`scrubLocalSecrets` in [`apps/mcp-host/src/agent-payload.ts`](../../apps/mcp-host/src/agent-payload.ts). |
| Malformed / oversized inputs against the zod schemas | [`tests/malformed-input.yaml`](tests/malformed-input.yaml) | The `capabilities`/`ttl_seconds` bounds declared in [`apps/mcp-host/src/tools.ts`](../../apps/mcp-host/src/tools.ts). |

See also [`docs/security/audit-2026-08-08-mcp-endpoint-fences.md`](../../docs/security/audit-2026-08-08-mcp-endpoint-fences.md)
for the loopback/https fencing on `OPENSESAME_SERVER` / `OPENSESAME_DAEMON_URL`
that all four classes' spawned `apps/mcp-host` processes rely on.

Every test case calls the **real, unmodified** `apps/mcp-host` over stdio —
nothing here mocks or stubs the server itself, only the upstream Host API /
daemon it talks to.

## How it's wired

Two `promptfooconfig.yaml` providers, used by disjoint sets of tests (each
test pins itself to exactly one provider via a `providers:` field, so there's
no accidental cross-product):

- **`mcp-host-structural`** (`file://src/mcp-provider.ts`) — our own small
  TypeScript harness. For each test case it spawns the real `apps/mcp-host`
  over stdio using `@modelcontextprotocol/sdk`'s `StdioClientTransport` /
  `Client` (the client-side mirror of
  [`apps/mcp-host/src/transports/stdio.ts`](../../apps/mcp-host/src/transports/stdio.ts),
  same SDK version: 1.30.0), optionally starts a private, ephemeral stub Host
  API / daemon on an OS-assigned port ([`src/mock-upstream.ts`](src/mock-upstream.ts))
  primed with the upstream response the test wants to probe, makes the exact
  tool calls the test specifies, and returns the raw MCP responses (plus every
  request the stub upstream received) as one JSON blob. **No LLM is involved**
  — the confused-deputy, credential-exfiltration, and malformed-input classes
  assert on the server's own structural behavior, not a model's judgment, so
  they run identically with or without model credentials.

- **`claude-live-mcp`** (`anthropic:messages:claude-sonnet-4-6`) — promptfoo's
  built-in Anthropic provider, wired via its native `config.mcp` integration
  to spawn the same real `apps/mcp-host` and run a genuine multi-turn
  tool-calling loop against it. Used only by the prompt-injection class, where
  what's actually under test is the *model's* judgment about instructions
  embedded in a tool result — that call has to go through a live model. The
  fixed-port stub Host API / daemon it talks to
  ([`scripts/mock-upstream-daemon.mjs`](scripts/mock-upstream-daemon.mjs))
  listens on `apps/mcp-host`'s exact default ports (127.0.0.1:8787 and
  127.0.0.1:18790) so no per-test provider config override is needed — each
  of the four injection cases just steers the model, via its prompt, toward
  the one tool whose canned response carries that case's injected
  instruction.

> **Model id note:** `claude-sonnet-4-6` is the current stable Sonnet model id
> as of when this suite was written (2026-08). If Anthropic has shipped a
> newer default Sonnet by the time you run this, update the id in
> `promptfooconfig.yaml` (two places: the top-level `providers:` entry and
> `defaultTest.options.provider`) and in each `tests/prompt-injection.yaml`
> assertion's inline `provider:` block — promptfoo will otherwise fail against
> a retired model id.

## Auth: two paths, pick one

The `claude-live-mcp` provider (and the llm-rubric grading calls in
`tests/prompt-injection.yaml`) are configured with `config: { apiKeyRequired:
false }`. That has one specific effect: when `ANTHROPIC_API_KEY` is **not**
set in the environment, promptfoo falls back to an authenticated Claude Code
session's local OAuth credential (from the macOS keychain entry
`Claude Code-credentials`, or `$HOME/.claude/.credentials.json`) instead of
failing fast on a missing key.

So, to run the full suite (including prompt-injection), pick one:

- **(a) Run from inside an authenticated Claude Code session**, with
  `ANTHROPIC_API_KEY` **unset**. promptfoo will pick up that session's OAuth
  credential automatically — no separate key needed.
- **(b) Export a real Anthropic Console API key**: `export
  ANTHROPIC_API_KEY=sk-ant-...`. This overrides path (a).

**A key must never be committed to this repo.** Set it in your shell, a local
untracked `.env` your shell sources, or your CI secret store — never in
`promptfooconfig.yaml`, a test file, or anywhere under version control.

Neither path is needed for the confused-deputy, credential-exfiltration, or
malformed-input classes — those run against `mcp-host-structural`, which never
calls a model.

## Running locally

```bash
# Full suite (starts the fixed-port stub upstream, runs promptfoo eval, tears
# the stub down afterward — see scripts/run-redteam.mjs):
pnpm --filter @opensesame/redteam redteam

# Same, from the repo root:
pnpm test:redteam

# View the last run's results in promptfoo's local UI:
pnpm --filter @opensesame/redteam redteam:report

# Run `promptfoo eval` directly (skips the supervisor script above — fine for
# the three structural classes; the prompt-injection cases will fail with a
# connection error unless something is already listening on 127.0.0.1:8787
# and :18790, e.g. a manually-started `redteam:mock-upstream` — see below):
pnpm --filter @opensesame/redteam redteam:eval

# Start just the fixed-port stub upstream, standalone, for manual poking:
pnpm --filter @opensesame/redteam redteam:mock-upstream
```

### Graceful degradation

- **No `pnpm install` yet**: every provider fails per-test with a clear
  `mcp-host structural probe failed: ...` (or an equivalent promptfoo
  provider-connection error for `claude-live-mcp`) rather than hanging — the
  harness wraps its connect/call steps in explicit timeouts
  (`src/mcp-provider.ts`) precisely so a missing dependency shows up as a
  fast, readable per-test failure instead of a stuck `promptfoo eval`.
- **No model credentials available**: `pnpm --filter @opensesame/redteam
  redteam:eval` still runs the confused-deputy, credential-exfiltration, and
  malformed-input classes cleanly (12+ cases, zero model dependency). Only the
  prompt-injection cases — and the llm-rubric grading calls within them — will
  report a provider auth error, which is expected and self-explanatory in
  promptfoo's output.
- **Ports 8787 / 18790 already in use**: `pnpm --filter @opensesame/redteam
  redteam` (the supervisor script) fails fast with a message naming the exact
  ports and suggesting what to stop, rather than eval'ing against whatever
  real service happens to be listening there.

## Extending the corpus

Each test file's cases follow the same shape: `vars.calls` is a sequence of
`{ tool, params }` MCP tool calls made against one continuous spawned
`apps/mcp-host` process (so e.g. a `task_start` then `task_invoke` in the same
case share task context, exactly like a real multi-turn agent session would).
`vars.mockRoutes` primes that case's private stub upstream; `vars.env` sets
extra environment variables (e.g. a fixture `OPENSESAME_OPERATOR_TOKEN`) on
the spawned process; `vars.includeToolSchemas: true` also returns
`tools/list` output for schema-introspection assertions. See
[`src/mcp-provider.ts`](src/mcp-provider.ts)'s `RedteamVars` interface for the
exact shape, and any existing test file for a worked example.

Prefer hard `contains` / `not-contains` / `javascript` assertions against the
raw MCP response JSON for anything mechanical (schema errors, header values,
scrubbing) — they don't depend on model availability and don't have a grading
model's own judgment as a source of flakiness. Reach for `llm-rubric` only
where what's actually being judged is a model's behavior, as in the
prompt-injection class.

## Scheduled runs

The nightly dependency-triage and weekly-security-audit Claude Code Routines
described in [`docs/operations/agent-routines.md`](../../docs/operations/agent-routines.md)
may invoke this suite (`pnpm test:redteam`) as part of their scheduled run —
see that doc for the exact schedule and how failures are surfaced.

## Verification status

This suite was built and self-reviewed without a completed `pnpm install`
(per this build's constraints), so `promptfoo eval` itself has not been run
end-to-end here. What *was* verified directly against the real, unmodified
`apps/mcp-host` server while writing it:

- Every zod validation error string asserted on in `tests/malformed-input.yaml`
  was captured live from a real `task_start` call via the MCP client SDK.
- The confused-deputy digest-substitution case (`tests/confused-deputy.yaml`)
  was verified by actually freezing an intent, then calling `operator_invoke_l1`
  with a forged `intent_digest`/`operation`, and inspecting the real HTTP
  request the server sent to the (stubbed) daemon: the forged fields never
  appeared; the server's own frozen digest did.
- The credential-exfiltration refusal and scrub-vs-refuse split in
  `tests/credential-exfiltration.yaml` were verified by having a stub upstream
  echo the process's real fixture `OPENSESAME_OPERATOR_TOKEN` back in both a
  credential-shaped field (refused) and a plain field (redacted, not refused).
- All assertion logic in the three structural test files was replayed against
  those captured, real outputs with a throwaway harness and passed.

What to run once the workspace is fully installed and either auth path above
is available:

```bash
pnpm install
pnpm --filter @opensesame/redteam exec promptfoo eval --help   # sanity: CLI resolves
pnpm --filter @opensesame/redteam redteam                       # full suite
```

The `claude-live-mcp` provider's `config.mcp` field names (`enabled`,
`server.command`/`args`/`name`) were checked against promptfoo's public docs
current as of writing; if `promptfoo eval` reports an unrecognized config key
under `mcp`, or the tool-calling loop doesn't actually execute against the
live server, check the current `providers/anthropic` and `integrations/mcp`
docs on promptfoo.dev — this is the one part of the config that couldn't be
exercised end-to-end here.
