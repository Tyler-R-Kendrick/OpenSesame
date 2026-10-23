# Support

OpenSesame is maintained by one person, best-effort. There is no paid support
channel and no guaranteed response time.

## Questions and help

- **Documentation** — start at [docs/README.md](docs/README.md); the
  [repository tour](docs/getting-started/repository-tour.md) says where things
  go, and [getting started](docs/getting-started/README.md) walks a fresh
  clone to a running app.
- **Bug reports and feature requests** — open a GitHub issue using the
  templates under [.github/ISSUE_TEMPLATE](.github/ISSUE_TEMPLATE/). Please
  include what you ran, what you expected, and what happened.
- **Security vulnerabilities** — do **not** open a public issue. Follow
  [SECURITY.md](SECURITY.md): use GitHub private vulnerability reporting on
  this repository.
- **Design and behavior questions** — most "why is it this way" answers are
  recorded as Architecture Decision Records in [docs/adr/](docs/adr/), with
  the product contract in [AGENTS.md](AGENTS.md).

## Response expectations

A maintainer triages issues and pull requests in their local time zone as
availability allows. An issue that includes a minimal reproduction and the
output of the relevant gate (`pnpm verify`, or the specific `pnpm audit:*`
gate) is the fastest path to a fix.
