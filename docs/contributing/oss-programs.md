# OSS community programs — the running map

Which OSS community programs OpenSesame is enrolled in, which it should join
next, and what joining each one takes. Decided in
[ADR 0211](../adr/0211-oss-fuzz-and-oss-verify-enrollment.md). Keep this
document honest: a program listed as "enrolled" has a merged upstream record;
"prepared" means the pack is in-tree and waiting on a maintainer step;
"recommended" is a decision that has not been made yet.

## Enrolled

| Program | What it gives | Where it lives |
|---|---|---|
| GitHub Actions CI + required checks | every PR runs lint, typecheck, tests, bundle budgets, Rust tests; CodeQL on six languages | `.github/workflows/` |
| GitHub security features | secret scanning + push protection, private vulnerability reporting, Dependabot alerts | repo Settings (verified enabled) |

One Settings toggle remains manual: **secret scanning validity checks**
(checks whether a detected token is still live) — the REST API accepts the
request but does not apply it on this personal account; flip it in
Settings › Code security › Secret scanning.
| OpenSSF Scorecard | weekly supply-chain score, published to the dashboard and the README badge | `.github/workflows/security.yml` |
| OSV-Scanner on a schedule | every lockfile against the OSV database, weekly | `.github/workflows/security.yml` |
| gitleaks on a schedule | full-history secret scan, weekly (plus the pre-commit hook per commit) | `.github/workflows/security.yml` |
| Dependabot | proposed version bumps for cargo (both workspaces), npm, and GitHub Actions | `.github/dependabot.yml` |
| Release attestations | build provenance + SHA256SUMS over every release-kit binary (ADR 0207) | `.github/workflows/release-kit.yml` |
| OpenSSF Security Insights | machine-processable security posture (threat model, gates, reporting) | `security-insights.yml` |

## Prepared — waiting on a maintainer step

- **OSS-Fuzz** (Google's hosted ClusterFuzz) — the submission pack is
  `tests/fuzz/clusterfuzzlite/` (project.yaml, Dockerfile, build.sh over the
  48 cargo-fuzz targets). To file: set `primary_contact`, fork
  google/oss-fuzz, copy the three files to `projects/opensesame/`, validate
  locally with `infra/helper.py build_image && infra/helper.py build_fuzzers
  opensesame`, open the PR. After acceptance: crashes arrive by email, and
  the [OSS-Fuzz badge](https://google.github.io/oss-fuzz/getting-started/badges/)
  can go on the README.
- **OSS Verify** (Theorem Labs' formal proofs over compiled fuzz binaries) —
  the enrollment pack is `tests/fuzz/oss-verify/`. To file: set
  `primary_contact`, clone theorem-labs/oss-verify, copy the directory to
  `projects/opensesame/`, run `python3 tools/validate.py projects/opensesame`
  and `tools/check --no-shell --twice opensesame` on a Linux host with Docker
  (~10 GB; the byte-reproducibility check cannot run on this repo's
  Windows/arm64 checkout), open the PR. After acceptance: machine-checked
  proofs that no input up to 64 MiB crashes the enrolled targets, findings
  reported privately to the contact.

## Recommended next

1. **OpenSSF Best Practices badge** (bestpractices.dev) — the highest-value
   next step. The criteria are a checklist (contributor-visible docs, release
   signing, vulnerability reporting, dynamic analysis…) that this repo almost
   entirely satisfies already: SECURITY.md, GOVERNANCE.md, the audit-gate
   suite, fuzzing, CodeQL, provenance-attested releases. Applying is a
   web form against the repo; gaps it surfaces are real gaps. Aim for
   **passing**, then **silver**.
2. **OpenSSF Allstar** — watches an enrolled repo continuously against
   Scorecard-derived policies and opens issues on regressions (e.g. a
   workflow that loses its action pinning). Cheap to adopt once Scorecard
   runs weekly; needs a GitHub App install on the account.
3. **deps.dev / OpenSSF_deps** — automatic for public repos once dependency
   data flows; nothing to file, worth checking the OpenSSF Best Practices
   badge widget and deps.dev score after the first Scorecard run.
4. **GitHub artifact attestations for npm packages** — when the npm publish
   workflow first runs (`publish-npm.yml`, needs `NPM_TOKEN`), add
   `--provenance` so npm packages ship with SLSA provenance the way the
   release-kit binaries already do.
5. **MCP Registry listing** — the MCP servers (`packages/mcp-host`,
   `packages/mcp-client`) are consumers, not yet published; once the npm
   publication of a server package lands, register it in the MCP Registry so
   agents can discover it. This pairs with the capability-registry parity
   story (ADR 0065).
6. **crates.io publication** — the crates carry `description`/`repository`
   metadata now but are not published; if the host plane ever ships as
   crates, publish the leaf libraries (`os-domain`-equivalents,
   `human-vault`, `sealed-store`) before any binary crate, and add
   `cargo publish` to the release kit behind the `release` environment.

## Later / situational

- **CLOMonitor** — automatic once Scorecard + Security Insights + governance
  files are detected; check the score, fix what it lists, nothing to file.
- **GitHub Sponsors** — `.github/FUNDING.yml` is in place; a Sponsors profile
  is the maintainer's personal decision.
- **Outreachy / GSoD / GSoC** — need a foundation or an org application and a
  second maintainer to mentor; revisit if the maintainer bench grows
  (GOVERNANCE.md).
- **awesome-lists and ecosystem directories** — submit the Pages PWA and MCP
  servers to the relevant lists (agent-security, password-manager
  alternatives) only after a release is published that a stranger can install
  end-to-end.
- **Securityinsights + Scorecard refresh cadence** — when the posture changes
  (new gate, new boundary), update `security-insights.yml`
  (`header.last-reviewed`) and this page in the same PR.

## Filing etiquette

- Both fuzzer enrollments put a real contact address into Google's and Theorem
  Labs' infrastructure. That address is chosen at filing time and committed
  nowhere in this tree.
- Upstream PRs are filed from the maintainer's own account: OSS Verify
  verifies the enroller is a maintainer of the enrolled project, and OSS-Fuzz
  wants a project contact it can reach.
- Findings from any of these programs convert into the ordinary triage flow —
  `docs/validation/fuzzing.md` § Crash triage, a dated `docs/security/audits/`
  record for anything real — never into a private side channel.
