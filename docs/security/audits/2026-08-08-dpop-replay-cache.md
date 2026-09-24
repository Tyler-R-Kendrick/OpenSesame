# Security audit — DPoP replay cache bounds — 2026-08-08

Branch: `chore/audit-tick31`

## Scanners

| Check | Result |
|------|--------|
| cve-lite / clippy (workspace) | CLEAN |
| gitleaks working tree | CLEAN (history warnings still from the unmerged pages-vault branch) |
| `cargo test --workspace --lib` | CLEAN |
| Residual review | `InMemoryReplayCache` retained every `jti` forever |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Medium | The DPoP replay cache was an unbounded `HashSet<String>` of attacker-supplied `jti` values, so a long-running validator grew without limit — memory exhaustion from ordinary (valid) traffic | Entries carry a timestamp and expire after `DEFAULT_REPLAY_TTL_SECS` (300s); the validator now passes the request clock so pruning tracks the proof window |
| Medium | No capacity ceiling — with expiry alone a burst inside one window could still exhaust memory | `DEFAULT_REPLAY_CAPACITY` (100k) with fail-closed behavior: at capacity new proofs are rejected rather than evicting entries, since eviction would re-open the replay window |
| Low | `jti` length was unbounded and empty `jti` was accepted | Reject empty and anything over `MAX_JTI_LEN` (256) before storing |

Expiry is safe because `decode_dpop_proof` already rejects proofs whose `iat` is
older than `max_age_secs`, so a pruned `jti` cannot be replayed.

## Gate

```bash
cargo +1.88.0 clippy --workspace --all-targets -- -D warnings
cargo +1.88.0 test -p opensesame-proof
cargo +1.88.0 test --workspace --lib
```
