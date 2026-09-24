# @opensesame/guide-lang

GuideLang v1: the declarative tutorial language an in-product support model
may write, and the only thing the guide runtime will execute. This package is
its parser, canonical serializer and validator. The language can show a person
where something is and wait for them to do it; it has no directive for a
click, a keystroke, a submit, a fetch, a selector or a URL, so a
prompt-injected model cannot ask for an operation the grammar cannot express.

## Where it fits

- **Used by:** [`packages/guide-runtime`](../guide-runtime) (executes a parsed
  program), [`packages/support-agent`](../support-agent),
  [`packages/app-core`](../app-core) (the support registries and agents in
  `src/tutorial/`) and [`apps/pages`](../../apps/pages) (the guided-help
  module and its adversarial tests).
- **Builds on:** nothing; no runtime dependencies, no DOM.
- Every id a program names (goal, target, route, predicate) is checked against
  a `GuideVocabulary` the application authored; a program with an unknown id is
  refused whole. Parsing fails closed on any unknown directive.
- Hard limits (`GUIDE_LIMITS`): 8 instructions, 500 characters of text per
  directive (counted in code points), 8192 bytes, 32 lines, timeouts between
  250 ms and 60 s, one guide on screen. Control, bidi and zero-width
  characters are rejected in model text.

## Surface

| Area | Exports |
|---|---|
| Syntax (`ast.ts`) | `GuideProgram`, `GuideInstruction` and one type per directive: `say`, `focus`, `hint`, `annotate`, `scroll`, `navigate`, `wait`, `success`, `pause`, `end`; `GUIDE_LANG_HEADER` (`guide/1`), `GUIDE_LIMITS`, `countGuideTextCharacters`, `hasForbiddenTextCharacter` |
| Parse (`parse.ts`) | `parseGuide(source)` returning a program or `GuideParseError`s |
| Serialize (`serialize.ts`) | `serializeGuide`, `serializeInstruction` (canonical form) |
| Validate (`validate.ts`) | `validateGuide(program, vocabulary)`, `compileGuide(source, vocabulary)` (parse, then validate) |
| Ids (`ids.ts`) | `isGuideGoalId`, `isGuideTargetId`, `isGuideRouteId`, `isGuidePredicateId` |
| Errors (`errors.ts`) | `GUIDE_PARSE_ERROR_CODES`, `guideParseErrorMessage` |

## Develop

```bash
pnpm --filter @opensesame/guide-lang test
pnpm --filter @opensesame/guide-lang typecheck
```

An authored guide is compiled by the same parser and validator as model
output.

## Related

- [ADR 0088](../../docs/adr/0088-ai-native-contextual-support.md) — AI-native
  contextual support
- [`docs/architecture/ai-contextual-support.md`](../../docs/architecture/ai-contextual-support.md)
  · [`docs/validation/ai-contextual-support.md`](../../docs/validation/ai-contextual-support.md)
