# Security Policy

## Reporting
Report vulnerabilities privately to the repository maintainers. Do not file public issues that include exploit details, tokens, or claim secrets.

## Scope
Covers both the Rust authority plane and TypeScript identity plane in this repository.

## Hard rules
- Never log claim tokens, device codes, refresh tokens, or passkey challenges.
- Canonical principal IDs must not appear as downstream OIDC `sub` values.
- Experimental CIMD/DCR/ATProto/Nostr features stay disabled unless explicitly enabled and reviewed.

## Supported local verification
```bash
pnpm -r --filter '@opensesame/*' test
pnpm test:security
./scripts/battle-test.sh
```
