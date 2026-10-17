# Governance

OpenSesame has a single maintainer. Tyler Kendrick
([@Tyler-R-Kendrick](https://github.com/Tyler-R-Kendrick)) is the benevolent
dictator for life (BDFL). This project has no foundation and no steering
committee.

## Decisions

Consequential decisions are recorded as Architecture Decision Records in
[`docs/adr/`](docs/adr/). The index is
[`docs/adr/README.md`](docs/adr/README.md).

## Committers and maintainers

A committer or maintainer is someone Tyler invites after sustained
contributions and demonstrated trust.

## Disputes

Discuss disagreements in issues and pull requests. The maintainer makes the
final call.

## Releases

Pushes to `main` deploy the Pages app through GitHub Actions
(`.github/workflows/deploy-pages.yml`). Version tags matching `v*` publish the
host container image (`.github/workflows/publish-containers.yml`). That
workflow can also be started by hand. npm publication is a separate manual
workflow (`.github/workflows/publish-npm.yml`).

## Continuity

If the maintainer is unavailable, the community may fork the repository under
the license in [LICENSE](LICENSE). The project does not claim a foundation or
committee that would take over.
