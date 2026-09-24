# Privacy (identity plane)

- Pairwise subjects by default; no canonical principal ID in downstream tokens.
- Origin-profile clients cannot obtain `offline_access`, admin scopes, or broad PII.
- Claim/device security pages: no third-party analytics, fonts, or scripts; `Referrer-Policy: no-referrer`; `Cache-Control: no-store`.
- Audit access is authorized and audited; secrets/codes never appear in audit metadata.
- Diagnostic logs use Pino redaction; OpenTelemetry attribute allowlists exclude claim/auth query strings and bodies.
