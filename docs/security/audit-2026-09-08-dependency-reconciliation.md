# Dependency reconciliation and compatibility evidence

Review date: 2026-09-08. Scope: the integrated hardening checkout's installed
dependency tree and lockfile, PRs #376/#378, public npm package metadata, and
the two parent-range exceptions recorded by the September 4 audit.
This is not a fresh vulnerability database scan or a claim of zero advisories.

## Reconciliation

[PR #376](https://github.com/Tyler-R-Kendrick/OpenSesame/pull/376) is closed,
unmerged. [PR #378](https://github.com/Tyler-R-Kendrick/OpenSesame/pull/378)
already merged the SimpleWebAuthn update in
`b6c5ba147aaf0db770a77304b6568c8c50ca172d`. The installed and locked server
version is 13.3.2. Reapplying #376 would duplicate that change and introduce
unrelated lockfile churn.

The installed and locked containment versions remain `@xmldom/xmldom@0.8.15`,
`qs@6.16.0`, and `fast-uri@3.1.6`. They were not downgraded or relabeled as
parent-supported versions during this review.

## Parent compatibility

Pages uses `kdbxweb@2.1.1`, whose published manifest requests xmldom `^0.7.4`.
The npm registry still reports 2.1.1 as latest. Upstream's unpublished master
manifest says 2.2.0 and requests xmldom `^0.8.10`, but also declares Node
`^18.18.0`; that is not an installable, verified Node 22 upgrade recommendation.
See the [upstream manifest](https://github.com/keeweb/kdbxweb/blob/master/package.json).

`@stryker-mutator/core@10.0.0` supplies `typed-rest-client@2.3.1`, which requests
exactly `qs@6.15.1`. This edge belongs to the development mutation toolchain,
not the application server. Its `Util.js` uses `qs.stringify`, not `qs.parse`.
The npm registry reports typed-rest-client 3.1.0 as latest, but that version
still requests exact `qs@6.15.3`. A major parent upgrade therefore does not
remove this range mismatch. See the
[upstream manifest](https://github.com/microsoft/typed-rest-client/blob/master/package.json).

No parent versions or lock entries were changed. Eliminating these mismatches
requires a reviewed supported parent release or a maintained parent patch/fork
with compatibility evidence; changing a version range alone does not prove
compatibility. The secure containment overrides remain necessary meanwhile.

## Regression evidence

On the integration checkout with Node 22.23.1 and Vitest 4.1.10:

```text
pnpm --filter @opensesame/pages exec vitest run \
  src/lib/vault/import/formats/kdbx.test.ts \
  src/lib/vault/import/formats/kdbx.characterization.test.ts --maxWorkers=2
2 files passed, 28 tests passed (1.17 seconds)
```

Those existing tests exercise the real KDBX parser, roundtrip fixture and
characterized format behavior with the resolved xmldom implementation.
`scripts/lib/dependency-compatibility.test.mjs` adds four network-free checks
through the actual Stryker-resolved REST client: repeated arrays/escaping,
dotted objects, bracket arrays, and null/omitted/false/zero distinctions. The
existing `audit:cve-lite` entry point runs these before its scanners. Missing
dependencies fail the checks; no diagnostics or scanner rules are suppressed.

## Residual limits

The two historical exceptions are not the entire override compatibility debt.
The current tree also contains major-range mismatches for UUID consumers
(AG-UI, natural, node-notifier), esbuild consumers (Vite, tsx, esbuild-kit), and
extension tooling's shell-quote, adm-zip and tmp pins. These are compatibility
candidates, not automatically exploitable vulnerabilities. This bounded review
does not certify those consumers or remove their security pins. Full frozen
installation, scanner gates and integrated application tests remain separate
evidence. Historical audit records were not rewritten.
