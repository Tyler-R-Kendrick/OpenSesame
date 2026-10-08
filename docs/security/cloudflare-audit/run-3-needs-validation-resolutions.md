# Run 3 `needs_validation` resolutions (fix stack)

Run 3’s `findings.json` and `coverage-ledger.json` are frozen at run time (six `needs_validation` records). This note records how each lead was closed on the stacked fix PRs branched from `cursor/cf-audit-run-3-artifacts` (#829).

| Order | Fingerprint | PR branch | Evidence |
| --- | --- | --- | --- |
| 1 | `domain.EgressBinding.allows_url/encoded-path-escape` | `cursor/cf-audit-egress-encoded-path-d641` | `encoded_path_traversals_fail_the_prefix_gate` |
| 2 | `crates/sandbox/spawn/grant-expiry-not-rechecked` | `cursor/cf-audit-sandbox-grant-expiry-d641` | `crates/sandbox/tests/grant_expiry.rs` |
| 3 | `opensesame.cli.connect.open_url.authorization-url-cmd-start` | `cursor/cf-audit-cli-open-url-d641` | `authorization_urls_must_be_https_or_dev_loopback` |
| 4 | `ops/compose/docker-compose.yml/nats/plaintext-host-port` | `cursor/cf-audit-nats-loopback-d641` | `scripts/test/compose-nats-bind.test.mjs` |
| 5 | `gateway/observation-control/role-evidence-fence-skipped` | `cursor/cf-audit-gateway-observe-fence-d641` | `hook_records_honor_the_role_evidence_fence`, `control_honors_the_role_evidence_fence` |
| 6 | `apps/android/invocation/custom-scheme-skips-validate-platform-invocation` | `cursor/cf-audit-wallet-custom-scheme-d641` | `custom_scheme_*` tests + mobile wiring |
