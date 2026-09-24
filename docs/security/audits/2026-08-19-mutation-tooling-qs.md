# Audit: mutation tooling transitive denial of service

Date: 2026-08-19

## Finding

Adding Stryker introduced `typed-rest-client@2.3.1`, whose exact dependency on
`qs@6.15.1` is affected by GHSA-q8mj-m7cp-5q26. The dependency is development
only, but the repository security gates correctly treated it as blocking.

The cve-lite gate also exited before parsing its JSON whenever the scanner found
a blocking issue, which hid the gate's own actionable diagnostics.

## Resolution

- The parent-specific pnpm override pins `typed-rest-client>qs` to 6.15.3.
- The lockfile contains no 6.15.1 resolution.
- The cve-lite gate now captures and validates the report even when the scanner
  exits non-zero because it found an issue.

## Verification

```bash
pnpm why qs
pnpm audit:osv
pnpm audit:cve-lite
```
