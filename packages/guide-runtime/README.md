# @opensesame/guide-runtime

The deterministic GuideLang runtime: a state machine that runs one parsed
[`GuideLang`](../guide-lang) program at a time through injected ports and
settles on a `GuideOutcome` the support layer can replan from. It has no DOM,
no router, no renderer and no timer of its own; every deadline comes from an
injected clock, so a test drives a whole guide without sleeping.

## Where it fits

- **Used by:** [`apps/pages`](../../apps/pages) (the `support.guided-help`
  module and the tutorial tests). The browser adapters in
  `apps/pages/src/tutorial/` are the only code that turns a target id into an
  element, and they resolve it from an authored registry.
- **Builds on:** [`@opensesame/guide-lang`](../guide-lang) for the program
  types, limits and id checks.
- It re-enforces every GuideLang budget and id check at run time rather than
  trusting the parser. Starting a run supersedes the one in flight.

## Surface

| Area | Exports |
|---|---|
| Runtime (`runtime.ts`) | `createGuideRuntime(ports)` returning `start(program)`, `pause()`, `cancel(reason)`, `snapshot()`, `subscribe(observer)`; `GUIDE_RUNTIME_NOTES` |
| Ports (`ports.ts`) | `GuideRuntimePorts`: `renderer` (`GuideRenderer`), `targets` (`GuideTargetResolver`), `routes` (`GuideRouteController`), `state` (`GuideStateObserver`), `clock` (`GuideClock`); `GuideOutcome`, `GuideCancelReason` (`user`, `lock`, `navigation`, `superseded`) |
| Clocks (`clock.ts`) | `systemGuideClock`, `createTestClock` |
| Fakes (`fakes.ts`) | `createRecordingRenderer`, `createFakeTargets`, `createFakeRoutes`, `createFakeState` for tests |

## Develop

```bash
pnpm --filter @opensesame/guide-runtime test
pnpm --filter @opensesame/guide-runtime typecheck
```

## Related

- [ADR 0088](../../docs/adr/0088-ai-native-contextual-support.md) — AI-native
  contextual support
- [`docs/architecture/ai-contextual-support.md`](../../docs/architecture/ai-contextual-support.md)
