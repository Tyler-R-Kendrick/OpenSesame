# Password parity dependency reconciliation, 2026-10-06

A fresh OSV scan found nine advisories after integrating main. All dependency fixes are exact pins; no advisory exemptions were added.

| Dependency | Final version or treatment |
|---|---|
| MCP SDK | 1.31.0, credential issuer checked before preparation and transport |
| simple-git | 4.0.1, argv-parser 2.0.1 plus a local guard for abbreviated executable options in both runtime bundles |
| sharp | 0.35.5, official native libvips 1.3.4 with librsvg 2.63.2 |
| shell-quote | 1.11.0 |
| source-map-js | 1.2.2 |
| sprintf-js | Removed: js-yaml 3.15.2 resolves argparse 2.0.1; a CLI compatibility patch preserves its version action |

See [MCP source and attack regressions](2026-10-06-mcp-oauth-issuer-binding.md), [shell, source-map and YAML CLI checks](2026-10-06-password-parity-cli-dependencies.md), and the [local Git-parser residual guard](../../../patches/simple-git-parser-residual.md). The Git abbreviation regression fails on the published parser; the local guard is not an official backport. Security regressions are included in quality:test and therefore run in the repository verification gate.

The official sharp Linux libvips tarball matched its registry SHA-512. Actual installed runtime versions are sharp 0.35.5, librsvg 2.63.2 and libvips 8.18.7. The lockfile contains neither sprintf-js nor argparse 1.

Four fresh secret-scanner findings were reviewed public fixtures: a synthetic part ID, the known SHA-1 of password, a pairing key explicitly decoding to a bogus test key, and a cross-language derived-password vector from a public sequential-byte root. Each exception requires the exact value and exact file under the generic-api-key rule. Isolated negative controls still detect eight findings: differing secrets in those four files and the same public values in unrelated files. No directory was excluded for these fixtures.

A fresh OSV run reports no unremediated advisories, while separately verifying the existing braces and node-forge source backports. AST scanning passes. The working-tree secret scan passes; its history scan retains 71 pre-existing warnings. Final repository and parity outcomes are recorded by exact revision in the pull-request self-reviews.
