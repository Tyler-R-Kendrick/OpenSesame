# PostHog setup (operator runbook)

This is a manual runbook. Repo code cannot create a PostHog project or
change PostHog org settings — a human operator (or an agent acting with the
operator's real PostHog access) follows these steps by hand.

Telemetry code lives in `packages/telemetry` (`@opensesame/telemetry`), which
implements the allowlist filter documented in §2 below in code, not just as
policy, and in `packages/mcp-host/src/telemetry.ts`, the one place that sends
anything (through `posthog-node`). This runbook covers the SaaS-side project
the code sends events to.

## 1. Create a dedicated OpenSesame PostHog project

Create a **new PostHog project scoped to OpenSesame only**.

**Do not reuse an existing default project from an unrelated product.** If
the operator's PostHog org already has a project connected for something
else (for example a "Default project" under a different product's org),
that project must **not** receive OpenSesame events. Telemetry from a
different product mixing with OpenSesame's would corrupt both products'
analytics and make the anonymity/allowlist guarantees below meaningless —
create a fresh project named e.g. "OpenSesame" and point OpenSesame's
environment variables (§4) at *that* project's key, never at an
already-in-use default project.

## 2. Telemetry contract — must match `packages/telemetry`'s allowlist exactly

`packages/telemetry` enforces this exact contract in code via an allowlist
filter. This is the authoritative spec both the code and this runbook are
built from — if the two ever disagree, that's a bug to fix, not a choice to
make.

**Allowed events** (exactly these nine, no others; today only `mcp_tool_call`
is sent, by `packages/mcp-host`, and no code in the tree emits the other
eight):

- `app_opened`
- `vault_unlocked`
- `vault_unlock_failed`
- `vault_locked`
- `item_opened`
- `ceremony_queued`
- `ceremony_completed`
- `settings_changed`
- `mcp_tool_call`

**Allowed properties** (exactly these eight, no others):

- `tool`
- `client`
- `client_version`
- `duration_ms`
- `outcome`
- `error_class`
- `item_type`
- `queue_depth`

**Explicitly prohibited from ever reaching PostHog:**

- MCP tool arguments or results
- Authorization headers or tokens
- Vault or ceremony content
- Prompts
- User identifiers

Telemetry is **anonymous** — nothing in the tree calls PostHog's
`identify()`, and `packages/mcp-host` captures under a random per-process id
held only in memory. It is **off by default**: the client is a no-op
unless a telemetry key environment variable is configured (§4). None of
this is a paper policy the operator has to trust — it's enforced by the
allowlist filter in `packages/telemetry`'s code, which drops any event name
or property not on the two lists above before anything is sent.

Nothing about this project's configuration should try to work around the
allowlist (e.g. enabling autocapture, which would capture arbitrary DOM/URL
data outside the contract — see §3).

## 3. Project settings to configure at creation

Configure these explicitly when creating the project — do not leave them at
whatever PostHog's current defaults happen to be:

| Setting | Value | Why |
|---|---|---|
| Session replay | **OFF** | Out of scope for this product; would capture far more than the allowlist permits. |
| Autocapture | **OFF** | Autocapture records arbitrary DOM interactions and URLs, bypassing the explicit event/prop allowlist above. |
| Data region | **US**, unless the operator has a specific reason to pick EU (e.g. a data-residency requirement) | US is PostHog's default region; record the operator's actual choice here once made: `_(operator: record your chosen region here)_`. |
| Retention | **90 days** (recommended default) | Reasonable default for anonymous product-usage telemetry at this scale; operator may adjust up or down — record the actual chosen value here: `_(operator: record your chosen retention here)_`. |
| Project access | Minimal — only people who need to see OpenSesame product analytics | Keep the access list to the smallest group that needs it; do not default to org-wide access. |

## 4. Where the project API key goes

After creating the project, PostHog issues a project API key. Set it as an
environment variable matching whatever entries `.env.schema` carries for
telemetry (added alongside `packages/telemetry` in this same build-out —
check the repo's root `.env.schema` for the exact current variable names if
this runbook and the schema ever drift):

- `OPENSESAME_TELEMETRY_KEY` — the project API key, read by
  `packages/mcp-host`.
- `OPENSESAME_TELEMETRY_HOST` (optional) — only needed if the project is
  **not** using PostHog's default US cloud host (`https://us.i.posthog.com`;
  for example, if the operator chose the EU region in §3, or a self-hosted
  PostHog instance).
- `.env.schema` also declares `VITE_OPENSESAME_TELEMETRY_KEY` and
  `VITE_OPENSESAME_TELEMETRY_HOST` for the Pages build (Vite inlines
  `VITE_*` values into the shipped JS), but no Pages code reads them yet: the
  `telemetry.external` capability has no Pages implementation.

Put these in local `.env` files — never commit a real project key. Follow
the same "commit the schema, not the secret" convention the rest of this
repo's `.env.schema` uses (see `docs/operators/local.md`, "Developer
`@env-spec`"). The key is a write-only capture key, which is why the schema
marks it `@public` rather than `@sensitive`.

Because telemetry is off-by-default no-op code, an environment with none of
these variables set simply sends nothing — that's the expected state for
any environment that hasn't opted in.

## 5. Cost / free tier

PostHog's free tier comfortably covers this repo's expected event volume —
nine event types, no session replay, no autocapture, low cardinality
properties. That said, check PostHog's current free-tier limits before
assuming they remain sufficient if OpenSesame's usage grows substantially;
those limits change over time and this runbook won't track them.
