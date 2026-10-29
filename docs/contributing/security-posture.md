# Security posture — detail

Detail moved from `AGENTS.md` §6. `AGENTS.md` §6 keeps the pointer index and the generic checker rules. Model, account, and cost specifics for external checkers are operator configuration, not repository policy, and are not recorded here.

## 6. Security posture

- `docs/security/notification-approval-threat-model.md` — trust boundaries and
  residual risks for external notification and approval (ADR 0086);
  `docs/operators/notification-channels.md` — the channel capability matrix and
  per-provider setup.
- `docs/security/security-boundaries.md`, `docs/security/threat-model.md`,
  `docs/security/identity-threat-model.md`,
  `docs/security/key-hierarchy.md` — architecture-level security docs.
- `docs/security/audits/YYYY-MM-DD-<topic>.md` — a running series of
  point-in-time audit docs, each documenting a specific vulnerability that
  was found and fixed. Add a new dated file rather than editing history, then
  `pnpm docs:index` (the index is checked by `pnpm quality`).
- `docs/security/tooling-evaluation.md` — evaluation of the audit gate
  tooling.
- Gate scripts (invoked via the `pnpm audit:*` scripts in §3):
  `scripts/audit/cve-lite-gate.sh`, `scripts/audit/ast-grep-security-gate.sh`,
  `scripts/audit/clippy-gate.sh`, `scripts/audit/osv-scanner-gate.sh`,
  `scripts/audit/cargo-audit-gate.sh`, `scripts/audit/gitleaks-gate.sh`,
  `scripts/audit/semgrep-gate.sh`, `scripts/audit/deepsec-gate.sh`,
  `scripts/audit/daemon-deps-gate.sh`, `scripts/audit/plugin-boundary-gate.sh`,
  `scripts/audit/kani-gate.sh`, `scripts/audit/miri-gate.sh`,
  `scripts/audit/shuttle-gate.sh`.

### Codex Security checker

`codex-security` is an external, model-backed review tool. It supplements the
deterministic `pnpm audit:*` gates; it does not replace them. CLI `0.1.20` with
bundled plugin `0.1.37` was the latest release validated in this repository on
2026-08-25.

Before a scan, check the installed and published versions. Upgrade only when
the task authorizes changing user-level tooling, and install an exact version:

```bash
codex-security --version
npm view @openai/codex-security version dist-tags --json
npm install -g @openai/codex-security@<exact-version>
codex-security --version
```

Routine reviews must target explicit security-boundary paths or a committed
diff. Never start a bare, uncapped repository-wide scan. Use the stored ChatGPT
sign-in with a low-cost model and low reasoning by default so reviews consume
the subscription allowance and preserve it for coverage. Do not use
`--auth auto`: unattended scans give API keys precedence. Use `--auth api-key`
only when the human explicitly requests API billing. Set one shared budget
before permitting network access, run preflight first, and retain artifacts
outside the checkout:

```bash
codex-security scan <clean-checkout> \
  --path <security-boundary> \
  --path <another-security-boundary> \
  --auth chatgpt \
  --model <low-cost-model> --effort low \
  --mode standard \
  --max-cost 15 \
  --fail-on-severity high \
  --headless --verbose \
  --output-dir <trusted-state-dir> --archive-existing \
  --dry-run

# Remove --dry-run only after checking paths, model, effort,
# authentication method, output directory, and maxCostUsd in preflight output.
```

The `--max-cost 15` cap is shared by every repeated `--path` in that
invocation; it is not a separate allowance per path. The cap is a ceiling, not
a promise that the scan will finish. Raising it or running a whole-repository
scan requires explicit human approval: prior uncapped runs exhausted budgets
after scanning only a small fraction of the tree. Use `--path` to split intentionally selected security boundaries
when a complete diff cannot fit the approved budget. Record any lower reasoning
effort as a coverage limitation.

Committed-diff scans require a completely clean checkout, including no
untracked files. Never stash, remove, or overwrite user work to satisfy this
check. Scan a disposable local clone at the same HEAD instead:

```bash
repo_root="$(git rev-parse --show-toplevel)"
scan_root="$(mktemp -d -p /tmp opensesame-codex-security.XXXXXX)"
git clone --no-local "$repo_root" "$scan_root/repo"
base_sha="$(git -C "$repo_root" rev-parse <base-sha-or-ref>)"
# Use "$scan_root/repo" as <clean-checkout> and "$base_sha" as the diff base.
```

Do not run that setup with `sudo`, and do not change repository or ancestor
ownership. Codex Security rejects an output directory when any ancestor is
owned by neither root nor its effective UID. Managed sandboxes may map `/`,
`/home`, and `/tmp` to UID `65534`, so changing the leaf directory cannot fix
`Scan output parent must have a trusted owner`.

When that ownership error occurs, the harness must run the checker in an
isolated user namespace/container with this mount contract:

- a synthetic root owned by the namespace's effective UID;
- the clean checkout mounted read-only at `/workspace`;
- a dedicated host artifact directory mounted read-write at `/state`;
- an ephemeral `CODEX_HOME`, with only required auth/config inputs mounted
  read-only;
- runtime libraries, certificates, and the resolver target mounted read-only;
- the scan launched from `/workspace` with `--output-dir /state`.

This Bubblewrap invocation is the known-good Linux implementation. Replace the
three host paths and scan arguments; if `/etc/resolv.conf` targets a different
absolute path, mount that target read-only instead of `/mnt/wsl`:

```bash
bwrap --unshare-user --uid 0 --gid 0 --tmpfs / --dev /dev --proc /proc \
  --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib \
  --ro-bind /etc /etc --dir /mnt --ro-bind <resolver-target> <resolver-target> \
  --dir /home --dir <sandbox-home> \
  --ro-bind <scanner-home> <scanner-home> \
  --dir <ephemeral-auth-dir> \
  --ro-bind <auth-file> <auth-file> \
  --ro-bind <config-file> <config-file> \
  --dir /workspace --ro-bind <clean-checkout> /workspace \
  --bind <trusted-host-state-dir> /state --tmpfs /tmp \
  --setenv HOME <sandbox-home> \
  --setenv PATH <scanner-bin-dir>:/usr/local/bin:/usr/bin:/bin \
  --chdir /workspace <scanner-binary> scan /workspace \
  --path <security-boundary> --path <another-security-boundary> \
  --auth chatgpt \
  --model <low-cost-model> --effort low \
  --max-cost 15 \
  --headless --verbose --output-dir /state --archive-existing --dry-run
```

Keep `--dry-run` for the first invocation. Remove it only after the printed
preflight is correct and model/repository egress has been approved.

Do not weaken the ownership check, use world-writable auth/config files, expose
the host home, or make the repository writable to the scanner. Obtain explicit
approval for the model's network/repository-content egress.

Interpret results narrowly:

- `cost_limit_exceeded`, interruption, or `partial_output=true` is incomplete;
- only entries marked `completed` in
  `artifacts/02_discovery/work_ledger.jsonl` were actually reviewed;
- `no_candidate` means no candidate in that completed file, not that the diff
  or repository is secure;
- `--fail-on-severity` is a release gate only after a complete scan;
- validate every candidate against the source-to-sink path before changing
  code, then add a regression test at the enforcement boundary;
- report CLI/plugin versions, base/head SHAs, scope, effort, cap and actual
  cost, completed/total files, findings, and residual unreviewed scope.

Keep scanner artifacts private. They may contain sensitive paths or threat
models. Never publish exploit details, tokens, credentials, claim values, or
other secret material in issues, logs, or scan reports.
