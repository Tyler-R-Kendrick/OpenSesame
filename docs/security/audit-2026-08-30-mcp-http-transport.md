# Audit 2026-08-30 — mcp-host Streamable HTTP transport

## Scope

`apps/mcp-host/src/transports/streamable-http.ts`, the transport selection in
`src/server.ts`, and the previously-inert `src/auth/bearer.ts` /
`src/auth/protected-resource.ts` helpers now wired into it. Introduced with
the agent-surface parity work (ADR 0065); profile obligations from ADR 0023.

## Threats considered and mitigations

1. **Routable exposure of operator tooling.** The listener refuses any
   non-loopback bind fail-closed (`mcp_http_loopback_required`); there is no
   TLS story in this binary by design, so a routable bind is never accepted.
   Remote access requires the operator to front it deliberately (e.g. a
   tailnet or SSH forward), keeping ADR 0048's local-plane posture.

2. **Unauthenticated access from local processes.** Every `/mcp` request
   requires `Authorization: Bearer <OPENSESAME_MCP_HTTP_TOKEN>` (16-char
   minimum, fail-closed when unset). Comparison is `timingSafeEqual` over
   SHA-256 digests, hiding both content and length. Non-bearer schemes are
   refused via `assertBearerScheme`. 401 responses carry
   `WWW-Authenticate: Bearer resource_metadata="<host>/.well-known/oauth-protected-resource"`
   and name the `mcp-authorization-2026-07-28-bearer` profile.

3. **Token passthrough (confused deputy).** The inbound bearer authenticates
   the transport only. The transport module never reads
   `OPENSESAME_ACCESS_TOKEN`/`OPENSESAME_OPERATOR_TOKEN` (source-oracle test),
   and tools keep sourcing their own credentials via `hostAuthHeaders()`; the
   inbound token is compared, then dropped. This preserves ADR 0023's
   "inbound MCP bearers are never forwarded downstream" and does not touch
   task DPoP profiles.

4. **DNS rebinding.** `enableDnsRebindingProtection` with a Host-header
   allowlist pinned to the actually-bound loopback host:port (computed after
   `listen`, so ephemeral test ports are covered too). A browser page on an
   attacker origin resolving to 127.0.0.1 fails the Host check even if it
   somehow obtained the bearer.

5. **Session fixation / cross-session reuse.** Sessions use SDK-generated
   `randomUUID()` ids; requests without a valid session are rejected by the
   SDK transport per the Streamable HTTP spec.

6. **Startup race.** Between `listen()` and transport attachment the handler
   answers 503 (`transport_starting`) rather than touching an undefined
   transport.

## Verification

- `apps/mcp-host/src/streamable-http.test.ts`: loopback/token/config
  fail-closed cases, 401 without/with wrong token and non-bearer scheme,
  PRM pointer in `WWW-Authenticate`, successful initialize with session id,
  health/404 behavior, and the source oracle for threat 3.
- `pnpm --filter @opensesame/mcp-host test` full suite; redteam structural
  suite continues to exercise the stdio path (`packages/redteam`).

## Residual risk

- Any local process that can read the operator's environment can read the
  transport token — the same trust boundary as the existing operator token.
- The stdio transport remains the default; HTTP is opt-in via
  `OPENSESAME_MCP_TRANSPORT=http`.
