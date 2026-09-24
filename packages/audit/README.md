# @opensesame/audit

The Identity plane's audit trail: build, redact and append audit events, chain
each event to the digest of the one before it, verify a chain, and record the
frozen secret/config changelog events. Metadata keys are allowlisted; a key
that names a secret is dropped even if it is allowlisted, and string values are
truncated to 256 characters.

## Where it fits

- **Used by:** [`apps/control-plane`](../../apps/control-plane) (appends events
  and builds its chained sink), [`packages/app-core`](../app-core) (imports
  only `@opensesame/audit/redact` for the browser-local activity log and
  local access audit) and the Jazzer.js fuzz targets in
  [`tests/fuzz/jazzer`](../../tests/fuzz/jazzer).
- **Builds on:** [`@opensesame/os-domain`](../os-domain) (`AuditEvent` and the
  JSON guards).
- A digest is not a signature. The chain makes an in-place edit or deletion
  visible to anyone who cannot recompute every later link; a writer that can
  is a different threat (see the comment at the top of `src/chain.ts`).
- The root entry uses `node:crypto`; the `./redact` subpath does not, which is
  why the browser core imports only that.

## Surface

| Export | What it does |
|---|---|
| `appendAuditEvent(sink, input)` | Builds a redacted `AuditEvent` and appends it to an `AuditSink` |
| `createChainedAuditSink(options)` | Wraps a sink so each event carries the previous event's digest; retries a predecessor conflict on `audit_events_previous_digest_uidx` |
| `verifyAuditChain`, `auditEventDigest`, `canonicalAuditPayload`, `AUDIT_CHAIN_GENESIS` | Chain verification and the bytes a digest covers |
| `redactAuditMetadata`, `isDeniedAuditMetadataKey`, `AUDIT_METADATA_ALLOWLIST`, `AUDIT_VALUE_MAX_LENGTH` | The redaction pass (also at `@opensesame/audit/redact`) |
| `SECRET_CHANGELOG_EVENT_TYPES`, `recordSecretChangelog`, `filterSecretChangelogEvents`, `isSecretChangelogEventType` | Frozen changelog event names, kept in step with the Host's changelog hook and Pages |

## Develop

```bash
pnpm --filter @opensesame/audit test
pnpm --filter @opensesame/audit typecheck
```

`src/__tests__/redact.characterization.test.ts` snapshots redaction output and
`redact.property.test.ts` runs fast-check properties over it. Adding a key to
`AUDIT_METADATA_ALLOWLIST` widens what reaches an audit row.

## Related

- [ADR 0046](../../docs/adr/0046-relayed-execution-and-authorization-inbox.md)
- [`docs/architecture/general-authority.md`](../../docs/architecture/general-authority.md)
