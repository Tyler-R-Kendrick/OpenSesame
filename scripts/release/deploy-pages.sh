#!/usr/bin/env bash
# Publication is performed by release-weekly.yml after candidate qualification.
set -euo pipefail
cat >&2 <<'MESSAGE'
deploy-pages.sh is retired. The local rebuild-and-push path cannot publish a
qualified candidate. Use Actions > Weekly release on main; publication consumes
the existing candidate and verifies the live Pages marker afterward.
See docs/operators/ci-promotion.md.
MESSAGE
exit 1
