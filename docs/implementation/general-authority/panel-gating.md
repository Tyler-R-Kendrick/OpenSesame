# Per-panel gating with no backend (GA-P-03)

> Status (2026-10-08): the Host rows of this contract were rewritten after
> [ADR 0128](../../adr/0128-pages-without-host.md) removed Host from Pages:
> `useHostConfigured()` (`apps/pages/src/lib/use-configured.ts`) is now a shim
> that always returns false, and there is no `NoHostNote` component in the tree,
> so no panel draws that note. The gating that is live is per Identity family
> (`useIdentityServes(family)`, `useIdentityConfigured()`, `useIdentityPlane()`,
> [ADR 0160](../../adr/0160-the-device-identity-plane-is-declared.md)). The
> `setupRequired` rule still holds and is tested.

ADR 0090: a panel is gated on **what it needs**, never on "a backend".

## Contract

| Need | Hook / note | Must not |
|---|---|---|
| Host URL configured | `useHostConfigured()` — always false since ADR 0128; a panel gated on it stays dark | Hide guest / Identity-only panels |
| Identity API | `useIdentityConfigured()`, `useIdentityServes(family)` | Block Access › Resources |
| No Host | nothing to draw; `NoHostNote` no longer exists | Invent `setupRequired` wall |

`setupRequired` must not return on the boot path (`packages/app-core/src/lib/settings.ts`
defaults stay empty; setup seams tests assert no `setupRequired` property).

## Evidence

```bash
pnpm --filter @opensesame/app-core exec vitest run src/lib/setup.test.ts -t 'never a gate'
rg -n "useHostConfigured|useIdentityServes" apps/pages/src/sections apps/pages/src/modules apps/pages/src/lib
```

Identity-plane and local vault panels stay available.
