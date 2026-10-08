# @opensesame/redteam

Structural red-team harness. The promptfoo MCP corpus that used to live here
targeted the Host-facing `packages/mcp-host` tools; those tools were removed
with the authority plane, and the corpus, its providers and its supervisor went
with them. What remains is the part whose subjects still ship:

- **Mock-upstream fences** (`src/pact.test.ts`, `src/mock-upstream.ts`) — the
  stub upstream the harnesses prime: 404 bodies carry no secret fields, and
  unmatched routes stay 404 under a flood of requests.
- **Agent-surface catalog denylist** (`src/pact.test.ts`) — every tool name the
  capability registry exposes on the surviving agent surfaces
  (`mcp_client`, `webmcp`) clears the secret-name denylist; the removed
  `mcp_host` surface must stay empty.
- **Duress catalogs and compiler** (`src/duress/`) — the attack-tree catalog
  and policy compiler in `@opensesame/contracts`, including the
  forbidden-claims terminology detector and a compiler fuzz pass.

Run it with `pnpm test:redteam` (an alias for this package's `vitest run`);
it is also part of the default `pnpm test`.
