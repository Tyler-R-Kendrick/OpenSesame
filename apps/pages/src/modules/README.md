# Optional capability modules

One directory per optional capability, named by its capability id verbatim
(`connectors.external/`, dots kept). The entry is `runtime.ts`, exporting
`capabilityRuntime: CapabilityRuntime` from
`lib/capabilities/runtime-contract.ts` (ownership.md §4.2–4.3).

## Contract

- `activate(ctx)` registers every contribution through `ctx.register(kind,
  entry)` and returns `{ capability, dispose }`. `dispose` revokes every
  handle, aborts in-flight work, drops the module's own in-memory state and
  is idempotent. A second `activate` after `dispose` registers fresh handles
  under the new lease.
- Sections, routes, settings categories, setup panels, command paths, keymap
  jumps, tutorial descriptors, item kinds, WebMCP tools, background jobs and
  unlock effects are the only ways a module reaches the shell. Nothing is
  patched into `AppShell`, `RailRows`, `keymap.ts` or the tutorial registry
  by a module; the core reads contributions.
- Network for new code goes through `ctx.egress.fetch(url, init, { capability,
  purpose })`. Existing transport code the module wraps is listed in each
  runtime's header as its egress declaration.
- A module never receives the vault store's root material. It gets
  `ctx.vault.tomb` / `ctx.vault.guest` and the sealed-file helpers the wrapped
  feature already used.

## Rules

- No top-level side effects in a module or anything it imports: no provider
  init, timers, fetch, DOM or service-worker registration, storage
  migration, permission requests. Module scope holds data, types, functions
  and empty containers only. Each `runtime.test.tsx` imports the runtime
  under spies to prove it.
- `activate` re-checks `ctx.lease.signal` after every `await`; an aborted
  lease registers nothing further and the handle it returns is already
  disposed.
- `dispose` only revokes local state. It never performs a network call, a
  storage write, or a ceremony — disabling a capability mid-authorization
  must not run the code being disabled.
- Pending callbacks (OAuth returns, staged tokens) resume only inside
  `activate` or an `unlock-effect`, both fenced by the current lease.
- Provider SDKs stay inside their own capability's chunk: `@vercel/connect`
  under `connectors.external`, GitHub App / forge clients under
  `backup.git-remote`, KMS configuration under `backup.cloud-secrets`.
- Runtime files stay under 400 lines; adapters live beside them.

Shared helpers in this directory: `activation.ts` (handle collection and
idempotent dispose), `signals.ts` (lease-fenced work), `tutorial-contributions.ts`
(register existing tutorial descriptors by id), `test-context.ts` (a fake
`ApprovedCapabilityContext` for the module tests).
