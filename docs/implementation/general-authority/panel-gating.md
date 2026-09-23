# Per-panel gating with no backend (GA-P-03)

ADR 0090: a panel is gated on **what it needs**, never on "a backend".

## Contract

| Need | Hook / note | Must not |
|---|---|---|
| Host URL configured | `useHostConfigured()` | Hide guest / Identity-only panels |
| Identity API | Identity-specific hooks / empty defaults | Block Access › Resources |
| No Host | `NoHostNote` on Host-only panels | Invent `setupRequired` wall |

`setupRequired` must not return on the boot path (`packages/app-core/src/lib/settings.ts`
defaults stay empty; setup seams tests assert no `setupRequired` property).

## Evidence

```bash
pnpm --filter @opensesame/pages exec vitest run src/lib/setup.test.ts -t 'never a gate'
rg -n "useHostConfigured|NoHostNote" apps/pages/src/sections apps/pages/src/components
```

Pages that need a Host (Connections, Sync targets, Host sessions) show
`NoHostNote` when unset. Identity-plane and local vault panels stay available.
