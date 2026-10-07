# Retired-credential implementation: local validation and open acceptance

The recorded implementation on signed upstream 5d98 is locally validated; production acceptance remains pending. The [current status](current-source-status-5d98.md) states the exact scopes and remaining gates. [PR 764](https://github.com/Tyler-R-Kendrick/OpenSesame/pull/764) contains the verified signed source; the [full hosted campaign](https://github.com/Tyler-R-Kendrick/OpenSesame/actions/runs/37565578573) is dispatched and pending.

Owners opt into selected retired-password traps. Matches record possession and reject by default, with an optional separately keyed synthetic vault. Real authority requires fresh original-owner authentication. See [ADR 0180](../../adr/0180-retired-credential-traps.md) for the design and limitations.

- [V45 lint, quality and typecheck](prepush-current-5d98-v45.json): 67 successful type tasks, 61 cached and six fresh.
- [V23 workspace tests](workspace-expanded-test-v23.json): 70 successful tasks, 64 cached and six fresh; the literal pnpm test rerun used all 70 cached tasks.
- [V14 security gates](security-gates-current-5d98-v14.json): all six configured gates passed; existing RSA exceptions and nonfatal historical secret findings remain explicit.
- [V9 builds](../2026-10-06-retired-credential-release/production-build-5d98-v9.json) and [fresh reviewed gallery](../2026-10-06-retired-credential-release/experience/current-5d98-v9-gallery/README.md): all nine build stages passed; 20 fresh captures completed and nine original-pixel views were reviewed.

The [genuine late-commit repair](webmcp-storage-commit-lifetime-5d98.json) retains the observed pre-fix failures and exact focused results. Already-admitted native I/O can complete necessary bookkeeping after withdrawal; no undo guarantee is claimed. The separate [failed V22 run](workspace-expanded-test-v22-failure.json) and [source-structure fixture correction](sb069-fixture-declaration-repair-5d98.json) preserve the actual failure and test-only repair.

[Source, platform and depth qualifications](source-platform-and-depth-acceptance-5d98.json) distinguish current authored Windows cases from execution, the historical Linux pass from an unexecuted current rerun, degraded fuzz controls from native Jazzer, and finite regression tests from a mutation campaign or formal proof. Installed extensions, native/device and signing acceptance remain pending. The optional receiver requires provisioning only before connected delivery is enabled.

This compact evidence excludes raw scanner findings, test/browser logs, private downloads and secrets. Earlier partial publication and historical proof files remain separately retained with their original scopes.
