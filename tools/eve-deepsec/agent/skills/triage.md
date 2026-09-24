---
description: Investigate Deepsec pattern-scan candidates in the OpenSesame repo without running deepsec process.
---

# Deepsec triage (Blackbox GLM)

Pattern scan is free. **AI `deepsec process` is not** — it uses Pi and paid Gateway hosts.
This eve agent *is* the investigator. Use `zai/glm-5.2` via Blackbox only.

## Steps

1. `deepsec_scan` if the candidate index may be stale.
2. `deepsec_candidates` with a high-signal slug (`auth-bypass`, `ssrf`, `xss`,
   `open-redirect`, `secret-in-log`, `mcp-tool-handler`, `jwt-handling`) and an
   optional `pathPrefix` such as `apps/gateway/`.
3. For each hit, `repo_read` the file and `repo_grep` for callers/tests.
4. Decide: confirmed, false positive, or needs human review.
5. Cite `path:line`. Do not patch unless asked.

## OpenSesame checks

- No BFF merge of Identity (`:8788`) and Host (`:8787`) APIs.
- NATS callout must not honor email-join.
- Outbox is SoT; JetStream is wake-only.
- No agent-facing secret reveal or `getSecret()`.
- Webhooks: HMAC before side effects; claim delivery id before outbox append.
