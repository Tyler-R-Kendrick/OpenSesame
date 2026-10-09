# OpenSesame security audit, run 3

## Run

- Profile: standard. Scope: apps, crates, packages, ops, spec, scripts, tools.
- Source: `33ecab02e8a0befa70f184e66fb1aa203b2aa084` on `cursor/cf-audit-getrun`, onto `origin/main` `6a1648ed8af6868885e303837f34a3bc745063f4`.
- Prior runs: run-1 (`a8843c3e`), run-2 (`6395f1e4`, regression-only — does not count toward two consecutive clean full runs).
- Grok Build unavailable (402); phases 3–6 closed by Cursor parent on 2026-10-08T12:00:00Z.

## Posture

Zero confirmed on the fix stack. Seven run-3 hunter candidates rejected after source review. Six needs_validation leads unchanged from run 2. `ensure_view_authority` now guards one-shot View reads (hook-records, log); observation **control** commit path remains needs_validation.

## Confirmed findings

None.

## Verdict counts

| Verdict | Count |
| --- | ---: |
| confirmed | 0 |
| needs_validation | 6 |
| rejected | 17 |

## Needs validation

- `apps/android/invocation/custom-scheme-skips-validate-platform-invocation` — Exported custom-scheme handlers skip invocation policy before wallet operations
- `crates/sandbox/spawn/grant-expiry-not-rechecked` — Sandbox broker calls ignore grant expiry after the profile is minted
- `domain.EgressBinding.allows_url/encoded-path-escape` — Path-scoped egress allowlist accepts encoded traversals that decode outside the prefix
- `gateway/observation-control/role-evidence-fence-skipped` — Role evidence fence does not bind observation control or one-shot log reads
- `opensesame.cli.connect.open_url.authorization-url-cmd-start` — Windows open_url passes a Host authorization_url to cmd.exe /C start
- `ops/compose/docker-compose.yml/nats/plaintext-host-port` — Compose publishes the NATS client port with no host IP and no server auth config

## Toward two clean full runs

Run 2 does not count. Run 3 is the first full pass after the stack closes run-1 confirmed items. **Run 4** must also complete with 0 confirmed before the audit loop stops.
