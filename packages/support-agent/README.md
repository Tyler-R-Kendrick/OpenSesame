# @opensesame/support-agent

The provider-neutral core of in-product support: the port a support model is
reached through, the system instruction it runs under, the egress boundary a
request crosses before it leaves the page, model-output handling, the
in-memory conversation, and a deterministic fake. A surface chooses the
provider (the browser's on-device Prompt API, an AG-UI endpoint) and the tour
renderer; this package decides what may be said and what may be sent.

## Where it fits

- **Used by:** [`packages/app-core`](../app-core) (`src/tutorial/agents/` — the on-device and AG-UI transports), [`apps/pages`](../../apps/pages), [`packages/control-plane`](../../packages/control-plane) (`routes/support.ts` uses `redactSupportQuestion`), [`tests/fuzz/jazzer`](../../tests/fuzz/jazzer) (`support_payload.ts`).
- **Builds on:** [`@opensesame/guide-lang`](../guide-lang) (the only thing a model may emit besides prose), [`@opensesame/os-domain`](../os-domain).
- No React, no tour renderer, no vendor model SDK.
- A `SupportTurn` carries prose and at most one GuideLang program. There is no field for a tool call, URL, selector or authority mutation.
- `sanitizeSupportRequest` rebuilds the outbound request field by field from primitives and refuses an unexpected key (`SupportEgressRefused`) rather than forwarding it.
- The transcript lives in the session closure only — never storage, logs, analytics or telemetry — and `destroy()` drops it.
- A failed guide never swallows a good answer; repair is one bounded retry carrying compiler error codes, never the model's failed text.

## Surface

| Module | Exports |
|---|---|
| `contract.ts` | `SupportAgentPort` (`availability`, `run`, `destroy`), `SupportRequest`, `SupportTurn`, `SupportPageContext`, `SupportError`, `SUPPORT_LIMITS` |
| `instructions.ts` | `buildSupportInstructions`, `SUPPORT_POLICY_CLAUSES` (asserted verbatim by a test) |
| `egress.ts` | `sanitizeSupportRequest`, `assertNoStructuralLeak`, `redactionWarning`, `SupportEgressRefused` |
| `remote-payload.ts` | `remoteSupportPayload`, `redactSupportQuestion`, `REMOTE_QUESTION_LIMIT`, `REMOTE_PAYLOAD_BYTES` |
| `turn.ts` | `runSupportTurn`, `parseSupportTurn`, `groundSupportAnswer`, `extractSupportSources`, `guideRepairInstruction`, `supportVocabulary` |
| `session.ts` | `createSupportSession` |
| `fake.ts` | `createFakeSupportAgent` and scripted fakes (`fakeAgentAnswering`, `fakeAgentDownloadable`, `fakeAgentHanging`, `fakeAgentReplanning`, …), `fakeSupportPageContext` |

There is no module mocking in this repo; other packages test against the fake,
which is a real implementation of the port.

## Develop

```bash
pnpm --filter @opensesame/support-agent test
pnpm --filter @opensesame/support-agent typecheck
```

## Related

- [ADR 0088](../../docs/adr/0088-ai-native-contextual-support.md) — AI-native contextual support
- [`packages/guide-lang`](../guide-lang) and [`packages/guide-runtime`](../guide-runtime)
