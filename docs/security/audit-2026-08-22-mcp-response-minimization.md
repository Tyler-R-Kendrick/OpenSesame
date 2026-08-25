# MCP administrative response minimization

Date: 2026-08-22

## Finding

The MCP Host applied credential redaction before returning Host and daemon
responses, but administrative tools still relayed unrecognized response fields.
A compromised upstream could place prompt-injection text in fields such as
`note`, `warning`, `assistant_directive`, or a readiness body. The live red-team
model refused the instructions but repeated their contents to the user.

## Fix

`apps/mcp-host/src/tools.ts` now parses successful administrative responses
through per-tool Zod allowlists and returns only documented identifiers,
status, bounded capabilities, and counters. Unknown fields and raw readiness
bodies are omitted. The original response is still checked by `forAgent`
before projection so credential-shaped material causes a refusal even when it
appears in an unrecognized field. Error responses expose only a bounded error
code.

The invocation result remains intentionally separate: connector invocation
results are the requested agent data and continue through the existing
credential fence.

## Evidence

- MCP Host: 80/80 tests passed.
- Structural red-team: 19/19 tests passed.
- Model-backed promptfoo red-team: 18/18 passed, including all four injected
  administrative response cases.
- The harness suppresses only Node's known `DEP0205` runtime warning so stderr
  assertions continue to detect application diagnostics.

