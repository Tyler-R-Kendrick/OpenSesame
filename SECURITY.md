# Security Policy

## Supported versions

Security fixes target the default branch (`main`). Published Pages and native artifacts advance through candidate qualification and release approval. Fixes for older commits are best-effort.

## Reporting

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/OpenSesame-Labs/OpenSesame/security/advisories/new). On this repository, open **Report a vulnerability** under Security Advisories. Do not file public issues that include exploit details, tokens, or claim secrets.

If private reporting is unavailable, contact the maintainer through the GitHub profile [@Tyler-R-Kendrick](https://github.com/Tyler-R-Kendrick).

We acknowledge a report within 3 business days, aim for an initial assessment within 10 business days, and respond to every report within 14 days or less.

## Scope

This policy covers the whole repository: the Rust authority plane, the TypeScript identity plane, and the client plane. The surfaces in scope include:

- Pages PWA
- native CLI, Host, and daemon (`opensesame`)
- Identity API (control-plane)
- browser extensions
- MCP servers

## Safe harbor

Good-faith security research that follows this policy and avoids privacy violations, data destruction, or service disruption is welcome. We will not pursue legal action against you for research that stays inside those limits.

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

## Maintainer note

Maintainers should enable private vulnerability reporting in GitHub repo Settings → Security.
