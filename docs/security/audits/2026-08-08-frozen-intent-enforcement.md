# Audit tick 43 — frozen intents were advisory, not enforced

Date: 2026-08-08
Scanners: cve-lite, gitleaks, semgrep, security battle test, clippy, cargo-audit, osv-scanner, cargo-deny, ast-grep

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| High | The task-bound execution path did not exist. `POST /api/v1/tasks/intents` froze an intent, returned a digest, and forgot it; the MCP host and daemon then executed through `POST /api/v1/intents`, which builds an intent from the request body and never reads `task_run_id` or `intent_digest`. No capability was asserted, no ceiling consulted, no state version checked — an agent could freeze `read` on `doc:1` and then execute anything the demo grant allowed, with a receipt carrying no task provenance. | Frozen intents are now held server-side and executed by digest at `POST /api/v1/tasks/invoke`, which routes through `Broker::invoke_frozen` (recomputes the digest, asserts the capability, checks the task state version, and verifies the ceiling is unchanged). Digests are single-use and expire with the intent. |
| High | `operator_invoke_l1` (MCP host) let the model override `operation` and `resource` while still presenting the frozen intent's digest — one call executed, another call's digest attested. | The tool takes only `connection_ref`; operation, resource, and arguments come from the frozen intent, and the daemon forwards the digest to the fenced route. |
| Medium | `POST /api/v1/intents` silently ignored `task_run_id` / `intent_digest`, so a task-bound caller looked fenced while spending no ceiling. | The route refuses those fields (in body or headers) with `task_authority_requires_frozen_invoke`, naming the freeze/invoke pair. |
| Low | The daemon echoed the reqwest transport error, which carries the Host API address. | Log it, answer `host_api_unreachable`. |

## Notes

- `SharedTaskEngine` dropped its outer `Mutex`: `InMemoryTaskStore` already synchronizes
  itself, and a `std` guard cannot be held across the `.await` in the invoke path.
- Server-side custody is the point. If the caller restated the frozen fields at execution
  time, the digest would only prove it can hash, so the pending map is the enforcement
  boundary — bounded at 512 entries and pruned by the five-minute intent expiry.
- Ownership is checked before the digest is spent: another principal's frozen intent
  answers 404, not 403, so digests are not an existence oracle.

## Verification

- `cargo clippy --workspace --all-targets --all-features` — clean
- `cargo test --workspace` — clean (new `claims_task_authority` unit tests)
- `pnpm --filter @opensesame/mcp-host test` — clean
- semgrep, gitleaks, cve-lite, security battle test — clean
