# ADR 0015 — Audit vs diagnostic logging

## Status
Accepted

## Decision
Audit events are durable domain evidence with allowlisted metadata. Diagnostic logs (Pino) and OpenTelemetry use aggressive redaction and attribute allowlists. Claim secrets, device codes, refresh tokens, cookies, and raw PII are forbidden in both by default.

## Consequences
Separate packages `@opensesame/audit` and `@opensesame/observability`; sentinel scan helpers in `@opensesame/testing`.
