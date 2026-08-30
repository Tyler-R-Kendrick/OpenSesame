# 0065. Agent-surface parity via a capability registry (MCP + WebMCP)

Date: 2026-08-30

## Status

Accepted

## Context

The MCP servers (`apps/mcp-host`, `apps/mcp-client`) exposed twelve tools while
the host CLI, client CLI, and the authority vault PWA grew far past that.
Nothing forced a new feature to consider the agent surfaces, so drift was the
default: a capability would ship in `apps/cli` or `apps/pages` and agents
simply could not reach it. The same gap was about to repeat with WebMCP
(`navigator.modelContext`), which had no implementation at all.

Prose parity tables have already failed in this repository —
`docs/validation/authentication-service-parity.md` cites a test file that does
not exist. The only parity mechanisms that have held are literal registries
swept by tests (`CONNECTOR_IDS` + `ceremony-consistency.test.tsx`), exact
catalog-equality tests (`apps/mcp-client/src/server.test.ts`), and byte-diff
gates (`pnpm test:anti-slop`).

## Decision

1. **One registry, many surfaces.** `packages/capability-registry` holds a
   single literal `CAPABILITIES` list. Every capability maps each surface
   (`cli`, `pwa`, `mcp_host`, `mcp_client`, `webmcp`) to its concrete carrier
   (command line, lib seam/route, tool name) or to `null`, and may carry an
   `excluded` entry per agent surface with a reason and an ADR citation.
   A committed `capabilities.json` mirror (regenerated via
   `pnpm --filter @opensesame/capability-registry generate`, guarded by a
   sync test) lets Rust tests consume the same source of truth through
   `include_str!`.

2. **Parity is enforced, not documented.** Package-level tests — which CI
   already runs — hold the invariants:
   - registry self-tests: every host/identity capability is MCP-mapped or
     MCP-excluded; every capability with a PWA surface is WebMCP-mapped or
     WebMCP-excluded; every exclusion cites an existing ADR; no agent catalog
     contains a secret-shaped tool name.
   - each MCP server asserts **bidirectional exact equality** between its
     implemented tool list and the registry-derived catalog (the previous
     `arrayContaining` form let additions pass silently).
   - `apps/pages` asserts the WebMCP tool registry equals the registry-derived
     pages catalog, that every `lib/<file>.ts:<export>` surface string resolves
     to a real export, and that every `route:` string is a real section route.
   - `apps/cli` and `packages/cli` assert every registered `cli` surface
     string's tokens appear in the argument-parser sources (`include_str!`
     pact style).
   The consequence: adding a feature to any surface without deciding its
   agent-surface story turns CI red.

3. **Agent-safe parity, stated not silent.** Reveal-gated secret
   materialization stays off every agent surface (ADR 0005, ADR 0052): secret
   values, leases, crypto plans, sealed-store reveals, TOTP seeds,
   secret-config value reads, connection credential entry. Each of these is a
   registry entry whose `excluded` block names the reason — the exclusion list
   is code, and removing an entry fails a test.

4. **Coarse reads, narrow writes.** One `X_read` tool per resource (list +
   inspect), one tool per consequential mutation. A tool name may carry more
   than one capability; a capability maps to exactly one tool name per
   surface. Tool names never match the secret-name denylist — which is why the
   client-plane config reader is `config_metadata_read`, not
   `secret_config_read`.

5. **Ceremonies stay human.** Approvals, grants, claims, credential entry and
   reveals are `kind: "ceremony"`. Headless MCP gets at most read-only inbox
   visibility. WebMCP gets *ceremony-open* tools: the tool navigates the
   already-unlocked app to the ceremony with context prefilled and returns
   `{status: "ceremony_opened", location}`; the human clicks the final
   approve/reveal/copy. Agents can therefore drive everything the user can do
   while consent and raw secrets stay with the person.

6. **TOTP codes over WebMCP.** By explicit product decision, WebMCP exposes
   the *current* TOTP code for a vault item (`opensesame_totp_code`):
   unlock-gated, code-only (never the seed), per-item rate-limited. The seed
   remains excluded everywhere (rule 3).

7. **WebMCP lifecycle.** `packages/webmcp` wraps `navigator.modelContext`
   behind feature detection (silent no-op where unsupported). `apps/pages`
   registers boot tools (status/navigate/health) at mount and session tools
   only between unlock and lock/sign-out; every payload passes the agent
   fence before leaving the handler. `apps/pwa` mirrors a thin
   status/health/sign-in-open set.

8. **Transports.** mcp-host serves stdio and Streamable HTTP. The HTTP
   transport binds loopback by default, requires the Bearer profile of
   ADR 0023 (`mcp-authorization-2026-07-28-bearer`), never forwards an
   inbound bearer downstream, and never downgrades task DPoP profiles.

## Consequences

- New features must touch the registry; the registry forces the MCP/WebMCP
  decision — implement, or exclude with a reasoned ADR citation. Either way
  it is visible in the diff and in `capabilities.json`.
- `ops/routines/weekly-agent-surface-drift.md` sweeps for the failure mode
  structural tests cannot see: a new gateway route, CLI verb, or pages section
  that never gained a registry entry at all.
- The registry package must stay dependency-free so every surface (browser,
  Node, Rust via JSON) can consume it.
- `docs/validation/pact.md` references these tests; no hand-maintained
  parity matrix is added anywhere.
