# Publishing OpenSesame artifacts

The supported entry point is **Weekly release** on `main`
(`.github/workflows/release-weekly.yml`). It selects a dev-qualified immutable
candidate, requires prerelease, mutation and security, and promotes the stored
Pages and Linux kits. See [CI and artifact promotion](ci-promotion.md) for
schedules, versions, settings, evidence and recovery.

## Pages and native kits

Nightly production stamps the Pages runtime/profile/release metadata before
qualification. Publication verifies the complete candidate, deploys unchanged
Pages files through Actions and checks the served source and content. Native
releases contain the same qualified archives, original build proof, receipts
and promotion evidence.

The old `deploy-pages.yml`, `release-kit.yml` and local
`scripts/release/deploy-pages.sh` paths now fail with a migration message.
Manual releases use the same nightly/weekly controllers and gates. A tag push
cannot start another native build. See [Release kit](release-kit.md) for consumer
verification and separately named test proxy downloads.

## Container and npm publication

The old `publish-containers.yml` and `publish-npm.yml` publishers are retired.
They rebuilt outside candidate qualification; their manual entry points now
fail without publication permissions. Container build validation still runs
in prerelease.

Restoring these distributions requires OCI digests/npm tarballs in the immutable
candidate inventory, tests of those payloads and candidate-bound publishing.
An npm token or tag alone must not restore the old rebuild-and-publish path.

## Other hosting providers

A Vercel or other provider Git integration that rebuilds on every main push is
a separate policy. It does not consume the qualified Pages artifact and is
outside this initial publisher. Review such external automatic deployments when
adopting the weekly production cadence.

The Pages product is static and device-local. Do not reintroduce Identity,
Host or daemon endpoints into its runtime configuration: the existing writer
enforces that boundary. Hosted Identity/Host services have their own operator
configuration under `ops/compose/`.
