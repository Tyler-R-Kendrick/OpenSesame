# @opensesame/guide-runtime

The deterministic GuideLang runtime: a state machine that runs one parsed
[`GuideLang`](../guide-lang) program at a time through injected ports and
settles on a `GuideOutcome` the support layer can replan from. A run is paced
in one of two modes: `auto`, a model's trajectory that runs to its next
observation boundary with a deadline on every wait, and `tour`, a person walking
a tutorial who holds each step with Next, Back and restart
([ADR 0163](../../docs/adr/0163-tutorial-mode.md)). It has no DOM,
no router, no renderer and no timer of its own; every deadline comes from an
injected clock, so a test drives a whole guide without sleeping.

## Where it fits

- **Used by:** [`apps/pages`](../../apps/pages) (the `support.guided-help`
  module and the tutorial tests). The browser adapters in
  `apps/pages/src/tutorial/` are the only code that turns a target id into an
  element, and they resolve it from an authored registry.
- **Builds on:** [`@opensesame/guide-lang`](../guide-lang) for the program
  types, limits and id checks.
- It re-enforces the instruction, text and timeout budgets and every id check
  at run time rather than trusting the parser (the source-text budgets, bytes
  and lines, stay with the parser, since an AST has no source; a tour run
  passes the wider budget it was compiled under). Starting a run supersedes
  the one in flight. In `tour` mode nothing
  times out on the person, and a control that is not on screen degrades its
  step to text instead of failing the guide.

## Surface

| Area | Exports |
|---|---|
| Runtime (`runtime.ts`) | `createGuideRuntime(ports)` returning `start(program, { mode?, limits? })`, `next()`, `back()` and `restart()` (tour only), `pause()`, `cancel(reason)`, `snapshot()`, `subscribe(observer)`; `GUIDE_RUNTIME_NOTES`; `TOUR_APPEAR_GRACE_MS` (`tour.ts`) |
| Step plan (`plan.ts`) | `planGuideSteps(program)`: the program grouped into the beats (`narrate`, `point`, `close`) a tour walks; `GuidePlan`, `GuideBeat` |
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
