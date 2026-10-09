# Security Policy

## Reporting
Report vulnerabilities privately to the repository maintainers. Do not file public issues that include exploit details, tokens, or claim secrets.

## Scope
Covers the whole repository: the Rust authority plane, the TypeScript identity plane and the client plane (Pages PWA, browser extension, CLIs, MCP servers).

## Hard rules
- Never log claim tokens, device codes, refresh tokens, or passkey challenges.
- Canonical principal IDs must not appear as downstream OIDC `sub` values.
- Experimental CIMD and DCR stay off unless explicitly enabled and reviewed (`OPENSESAME_CIMD_ENABLED`, `OPENSESAME_DCR_ENABLED`, both `false` in `.env.schema`). `atproto` and `nostr` are reserved identity kinds with no adapter in this tree; one added later follows the same rule.

## Supported local verification
```bash
pnpm -r --filter '@opensesame/*' test
pnpm test:security
./scripts/test/battle-test.sh
```
