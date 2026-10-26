# Proposal validation

Baseline inspected: `aad2c85b4b567fd632d0e409d53d17bb66e8fba4`.
Validation performed on the inert proposal files, not on an activated pipeline.

## Checks completed

| Check | Result and boundary |
|---|---|
| Four YAML documents | Parsed successfully with a YAML loader that preserves the Actions `on` key. |
| Producer Actionlint | `actionlint` 1.7.12 passed `candidate-build.yml` without suppressions. |
| Controller Actionlint | Passed after excluding only missing-reusable-file diagnostics for the explicitly planned adapters. The unsuppressed run reports those missing files, as expected. This does not validate their unimplemented inputs, outputs or behavior. |
| Job references | Every local `needs` dependency resolves to a job in its controller. |
| Embedded shell | Every `run` body passed `bash -n`; ShellCheck was not installed/run. |
| Embedded Python | Both producer programs passed syntax compilation. |
| Manifest positive fixture | A complete six-payload bundle passed; sizes, hashes, metadata, canonical JSON and manifest digest matched. |
| Manifest negative fixtures | Thirteen invalid bundles were rejected, each before producing `candidate.json`; cases below. |
| Whitespace and links | Diff whitespace and local proposal Markdown links checked. |
| Independent design review | Reconciled source/receipt freshness, cumulative main diff, explicit no-op behavior, same-run evidence, suite identity, artifact roles, retention wording and production/test separation. |

Actionlint was obtained from the official v1.7.12 release and its Linux AMD64
archive checked against release SHA-256
`8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8`.

The controller lint invocation used only this missing-interface exclusion:

```bash
actionlint -shellcheck= -pyflakes= \
  -ignore '^could not read reusable workflow file' \
  docs/proposals/ci-artifact-promotion/workflows/*.yml
```

The missing activation targets are `ci-fast-checks.yml`, `candidate-build.yml`,
`ci-dev-checks.yml`, `ci-prerelease-checks.yml`, `ci-release-checks.yml`, and
`release-publish.yml` under `.github/workflows`. A producer draft exists here;
the remaining reusables are implementation contracts rather than working files.
Full lint without that exclusion is required after implementation.

## Manifest negative fixtures

The fixture exercise invoked the actual manifest Python embedded in the producer,
using synthetic archives in disposable directories. These are parser/admission
checks, not real binaries or application behavior tests.

1. Missing required Linux kit.
2. Unexpected extra output.
3. Filesystem symbolic link.
4. Archive parent-path traversal.
5. Archive symbolic link.
6. Duplicate archive member.
7. Pages release marker for a different source SHA.
8. Incorrect Pages deployment profile.
9. Missing Pages release marker.
10. Native kit bridge bytes different from the standalone bridge.
11. Test-only upstream marker in a production executable.
12. Missing marker in a declared test proxy.
13. Unexpected member inside a native kit.

These checks establish the draft manifest generator's behavior for those cases.
They do not prove authenticated artifact transfer, provenance, complete
runtime coverage, or immunity from every malformed input. In particular, a
manifest produced after downloading intermediate payloads cannot itself establish
that the original upload digests matched: the checked-download/provenance work in
the protocol remains required.

## Work not executed

- No complete PWA build, Rust release matrix, browser suite, mutation run, security
  scan or production deployment was run for this documentation-only proposal.
- The existing repository-wide lint/typecheck/test/verify suites were not run.
  Active product code and active workflow files are unchanged.
- No helper/reusable/publication adapter that is marked planned was treated as
  implemented or tested. No placeholder job was used to claim a passing gate.
- No live branch rules, environment configuration, package credentials or actual
  CI timing distribution was established by these static checks.
- No source-artifact build provenance was issued. No tag or release was created.

## Required next verification

Implement the interfaces, then validate the complete chain against an explicitly
selected main revision before enabling schedules or publication. Exercise the
failure cases in [candidate-protocol.md](candidate-protocol.md), preserve the
coverage contracts in [migration-map.md](migration-map.md), and run the actual
packaged-product journeys described in [artifact-builds.md](artifact-builds.md).

Record the exact candidate SHA, producer run/attempt, artifact and manifest
digests, each required check's execution, scanner/tool versions, runtime, and
publication result. Static validation of a draft is not release qualification.
