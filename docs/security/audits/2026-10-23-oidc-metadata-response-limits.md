# Native OIDC metadata response limits

## Scope and invariant

Reviewed `packages/oauth-provider` at base revision
`4798795f83c63c219f973a23cab56457811d878e`, with pinned
`oidc-provider` 9.11.2. Native `sector_identifier_uri` downloads during dynamic
registration and `jwks_uri` downloads during client authentication must have
finite byte budgets before JSON parsing, regardless of response framing.

## Finding and fix

The shared provider configuration inherited unbounded defaults for both
purposes. Enabling DCR made remote sector documents reachable; remote JWKS
were also used by registered clients. The separate CIMD `SafeMetadataFetcher`
did not mediate either native path.

Set both native `fetchResponseBodyLimits` to 64 KiB in
`src/metadata/response-limits.ts`, matching the repository's existing metadata
policy, and declare the supported option in the local type shim. The dependency checks Content-Length before reading and counts streamed
bytes before retaining them. This shared boundary covers JWKS refreshes as well
as first fetches. Other defaults, including the native CIMD document limit,
remain inherited.

Valid registration, client authentication, feature flags and native error
semantics remain intact. Registration authentication and rate policy are
unchanged; a per-response cap does not bound aggregate concurrent work.

## Validation

`src/__tests__/fetch-response-limits.test.ts` exercises the native provider's
registration and token endpoints, substituting only remote HTTP responses.
Before the fix, the four oversized fixed/streamed document cases failed:
sector registration succeeded and JWKS authentication passed the key check.
The four legitimate small/exact-limit controls passed before and after.

After the fix, all 13 regressions pass: both metadata purposes accept valid
JSON through exactly 65,536 bytes, reject oversized fixed and streamed bodies,
cancel declared oversized bodies before reading, cancel unbounded streams
when the byte budget is crossed, and leave discovery available. DCR remains
disabled when its flag is off. Valid JWKS authenticate the client and reach
`invalid_grant` for the deliberately nonexistent authorization code.

Checks passed:

- `corepack pnpm --filter @opensesame/oauth-provider typecheck`
- `corepack pnpm --filter @opensesame/oauth-provider test` — 30 files, 226 tests
- `corepack pnpm exec biome check packages/oauth-provider/src/create-provider.ts packages/oauth-provider/src/metadata/response-limits.ts packages/oauth-provider/src/oidc-provider-shim.d.ts packages/oauth-provider/src/__tests__/fetch-response-limits.test.ts`
- `corepack pnpm lint:anti-slop:files packages/oauth-provider/src/create-provider.ts packages/oauth-provider/src/metadata/response-limits.ts packages/oauth-provider/src/oidc-provider-shim.d.ts packages/oauth-provider/src/__tests__/fetch-response-limits.test.ts`
- `git diff --check`

An independent read-only review found no concrete surviving bypass or
compatibility regression. Response fixtures exercise the dependency's real
reader and cancellation but do not measure process RSS or test external TLS
servers. Full repository release checks are separate from these focused checks.

## Repository-wide validation limits

Overall verification outcome: `blocked`; the patch and focused proof are complete,
but repository-wide gates are not green. `node --test scripts/security/*.test.mjs`
passed all 65 tests. `node scripts/quality/quality-gate.mjs` failed on the existing
complexity violation in
`apps/pages/src/sections/connections/connect/NativeConnectorPanels.tsx`
(allowed 0, found 1). That file is byte-identical to the base revision; this
patch introduces no structural regression. Log-hygiene and package-metrics
checks passed. The broader `pnpm quality` run exited 137 after dependency setup;
its complete test result is unknown. The reduced-worker retry is also incomplete.
Full release `pnpm verify`, full-workspace typechecking and full-workspace tests
were not completed. These results describe the original local verification. The patch is now
submitted for review; it has not been merged or marked resolved in Security Cloud.
