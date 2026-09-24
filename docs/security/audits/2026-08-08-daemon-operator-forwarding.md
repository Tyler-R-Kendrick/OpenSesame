# Audit tick 61 — the operator token stays on this machine

Scanners (cve-lite, semgrep, ast-grep, gitleaks, cargo-audit, cargo-deny, clippy,
task-security-battle-test) were clean. The reading was `apps/daemon` and
`crates/audit`.

## The daemon handed its operator token to whoever `OPENSESAME_SERVER` named (fixed)

Three daemon routes — `approve_device`, `approve_claim`, and
`operator_invoke_l1` — forwarded to the Host API with
`x-opensesame-operator: <token>` attached. The Host API base is configuration
(`OPENSESAME_SERVER`, `--host-api`), defaulting to loopback but not confined to
it, so a remote value sent the host's operator secret to whoever answered there,
in cleartext over `http://`.

That secret is the daemon's whole authorization story: every mutating local route
gates on it. `apps/mcp-host/src/host-api.ts` already refuses to offer it to a
non-loopback target; the daemon now agrees. Forwards that carry the token go
through one helper that denies with `503 remote_host_api` when the base does not
name this machine, rather than reaching a remote at the cost of the secret.

The loopback test lives in `crates/host-core` as `daemon::base_url_is_local`,
beside the existing listen-address policy. A base carrying userinfo is not local:
`http://127.0.0.1@evil.test/` is a request to evil.test.

## Minted capabilities accumulated for the life of the process (fixed)

`mint_capability` inserted into the capability map and never removed anything.
Expired capabilities were already inert on introspect, so they were pure growth.
Minting now drops expired rows first.

## Read and left alone

- `crates/audit`: the receipt verifier registry from an earlier tick is wired
  (`resolve_receipt_verifier`, published key ids), receipts bind
  `authority_key_id` into the signed digest, and an unknown key reports as
  unknown rather than as tamper evidence.
- The daemon's Identity API fallback carries no operator token, only a
  caller-supplied bearer.
- `mint_capability` picks the first session in the map, which is a dev stub rather
  than an authorization decision; it is operator-gated and mints no credential
  material.
