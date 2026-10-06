# Password parity dependency remediation — 2026-10-05

The latest-main dependency audit found vulnerable Wasmtime and npm dependencies.
Published fixes now resolve Wasmtime 36.0.17 (workspace minimum 36.0.16),
fast-uri 3.1.8, basic-ftp 6.2.1, flatted 3.4.2, log4js 6.4.0, and js-yaml
3.15.2/5.4.1. Version-scoped js-yaml overrides retain each caller's major API.
The basic-ftp fix requires its next major; its affected chain belongs to
promptfoo's proxy-agent tooling. Frozen-lockfile installation completed.

Two advisories had no published fixed release: braces 3.0.3
(GHSA-vfj7-8cjw-p6xm) and node-forge 1.4.0 (GHSA-86w9-cpqp-85rv).
Local pnpm backports repair their source rather than ignore their advisories.
Before installation, the regression checks demonstrated that an 8,003-character
nested brace pattern was accepted and an RSA signature whose nested
DigestAlgorithm held a third garbage element verified successfully.
After installation, the same checks reject both inputs and retain ordinary
brace expansion and valid RSA signature verification. Caller-supplied deep
brace ASTs are bounded as well.

Braces is reached through WXT/fast-glob/micromatch development tooling.
Node-forge is reached through WXT's Android debugging support and promptfoo's
JKS tooling. Neither dependency is the password workflow's credential storage
or private-request executor. These limited paths do not substitute for fixes.

## Source evidence

- `patches/braces@3.0.3.patch`: SHA-256 `dd8ce02ab42b154d240c121957697f3e1dd1a9169871cb6eb9abe866d8d44bce`.
- `patches/node-forge@1.4.0.patch`: SHA-256 `517417eac096279fb75e51aa9b9eefe735508e0daacedf9979ebf25f6394a47a`.

The checked-in `scripts/security/dependency-backports.json` also records every
modified installed source file's SHA-256. `verified-backports.mjs` recognizes
only these two exact advisory/package/version combinations. It requires the
patch digest, manifest and lockfile patch binding, patched snapshot and every
consumer edge (including direct and aliased dependencies), the installed
lockfile-hash path, and installed source digests. It then runs the actual attack
regressions before calling a version-only scanner finding remediated.
Missing or changed evidence fails closed. No advisory ignore was added.

## Verification

`node --test scripts/security/dependency-backports.test.mjs
scripts/security/verified-backports.test.mjs` passes seven tests, including
negative controls for changed/missing patches, changed installed source,
raw transitive/direct dependencies, aliased dependencies, unknown advisory IDs
and different versions. The exact OSV gate reports two source-verified
backports and zero unremediated findings; its raw JSON retains both version-only
findings. The gate also refuses scanner errors and malformed results.

A fresh native/PWA build and full repository verification must follow this
dependency snapshot before merge. The prior parity run proves the earlier
snapshot and is not substituted for final dependency verification.

## Customer-envelope capture review

After integrating main `e53d2a2ca18628021be020f1c916a9aca793d93e`,
Gitleaks matched the public CDP virtual-authenticator identifier
`2c4c3bf6-621a-43c7-96db-92c657496656` in the duress `capabilities.json`
and `journeys.json` evidence captures. This is an identifier, not an authentication
credential. The reviewed allowlist requires both this exact anchored value and
one of those two paths; captures remain unchanged. Negative controls verify
that different values in those paths and the same value elsewhere still fail.
