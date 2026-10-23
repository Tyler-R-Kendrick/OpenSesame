# DeepSec scan evidence — 2026-10-22

## Model route

DeepSec was run with the workspace at `/home/tyler/.cache/deepsec-opensesame`:

- `defaultModel: opencode-go/deepseek-v4.1-flash`
- `defaultAgent: opencode`
- OpenCode provider: stored OpenCode Console subscription (no provider API key)
- The agent process was invoked as
  `opencode run --format json --model opencode-go/deepseek-v4.1-flash`

A one-shot prompt to that exact model returned `model-ok` with the stored
subscription and no provider key in the environment.

Run metadata records the same route:

```json
{
  "processorConfig": {
    "agentType": "opencode",
    "model": "opencode-go/deepseek-v4.1-flash",
    "modelConfig": {
      "model": "opencode-go/deepseek-v4.1-flash",
      "maxTurns": 80,
      "thinkingLevel": "medium",
      "reasoningEffort": "medium"
    }
  }
}
```

## Scan

- Pattern scan: `20261022092138-7389e44f47898b45`
- Candidate scope: 2,964 files, 5,225 matcher hits
- High-risk AI scope: auth, SSRF, XSS, JWT, redirects, secret exposure,
  webhook, agent-tool, object and deserialization matchers
- Processing runs resume under the same project; `processing` locks from a
  dead run are reclaimed after the documented one-hour stale window.
- Concurrency was held at three batches to keep the WSL host stable after
  earlier eight-process runs froze it.
