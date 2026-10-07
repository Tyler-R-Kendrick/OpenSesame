# Extension security feature campaigns

These authored campaigns are distinct from the canonical mutation list. They
are measurement recipes, not claims that all mutants have been killed. The
historical 109-mutant campaign had 61 assertion kills, 14 timeouts and 34
survivors: 68.81%, failing the unchanged 100% threshold. Preserve that report
until actual current-source results establish another figure. A timeout is a
separate status, not an assertion kill or formal proof.

Run from the repository root after installing the pinned toolchain:

```sh
pnpm exec stryker run tools/mutation/extension-security-feature.config.json
pnpm exec stryker run tools/mutation/extension-security-feature-genuine.config.json
```

The first campaign selects the six broker/client model test files (57 cases at
authoring). The second selects those same files plus the genuine BrowserHost
management suite (9 additional cases, 66 projected). Keep their reports and
scores separate. The model verifies protocol decisions and callback effects;
the host suite adds actual encrypted storage, current-owner proof and durable
commit boundaries. Neither score replaces the other or covers the entire app.
Both select broker lines 75–144 and client lines 69–94. They retain canonical
browser aliases/setup, 20s test/hook limits, one worker and one mutant runner.

Both break thresholds are 100. Stryker's timeout is the measured selected test
net time × 1.5, plus 10000ms deviation and measured dry-run overhead. It is not
a hard total 10s deadline; the original dry-run limit remains five minutes.
Reports are separate under `artifacts/mutation/`; sandboxes are separate and
always cleaned. Hosted collectors must retain raw statuses, actual exits,
tool versions and unchanged before/after input catalogs.

The associated native-only bounded protocol campaign is:

```sh
bash scripts/fuzz/jazzer-credential-gate.sh
```

It requires actual Jazzer.js 4.0.0 native loading, generates 34 bounded public
seeds and runs exactly three targets sequentially: controlled canary parsers
(including complete MCP parse→validate→synthetic response), receiver schemas,
and awaited independent AES-GCM/HMAC packet/ACK authentication. Each target
has a 60s engine budget, 8194-byte input limit and the original 5000ms native
execution timeout. Expected rejection catches never swallow security oracle
failures. An explicit valid independent packet/ACK control prevents vacuous
rejection from being treated as success.

The script's existing audit-directory helper creates a fresh private directory
outside the checkout. It retains native-loader and per-target logs/exit files,
learned corpus and crash artifacts. It permits no random fallback, including
when `JAZZER_ALLOW_FALLBACK=1`. Bounded native fuzzing demonstrates executed
feedback and tested invariants; it does not prove absence of vulnerabilities.
