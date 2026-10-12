# Privacy (identity plane)

- Pairwise subjects by default (`subjectTypes: ["pairwise"]`); no canonical principal ID in downstream tokens.
- Origin-profile clients get scope `openid` only and cannot obtain `offline_access`, `admin` or `opensesame.admin`.
- Claim, approval and interaction pages served by the Identity API load no third-party analytics, fonts or scripts (CSP `default-src 'none'`) and send `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. The device-flow pages oidc-provider draws are replaced by local pages that load nothing beyond themselves.
- Audit routes require an authenticated principal and return only that principal's own events; metadata is limited to an allowlist of keys, redacted on write and again on read, so secrets and codes never appear in it.
- Diagnostic logs go through `createLogger` (`packages/observability`): Pino redaction paths for tokens, codes and secrets plus a deep scrub of every value with the shared rules in `spec/log-scrub/log-scrub.json` (ADR 0157).
