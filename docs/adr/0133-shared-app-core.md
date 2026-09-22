# ADR 0133 — One shared application core for the PWA, the CLIs and Android

- **Status:** Proposed
- **Date:** 2026-09-22
- **Deciders:** OpenSesame maintainers
- **Relates to:** ADR 0017 (host/client topology), ADR 0058 (native
  authenticator), ADR 0065 (agent-surface parity), ADR 0088 (in-product
  support), ADR 0090 (static front end), ADR 0093 (structural quality gates),
  [`docs/research/android-native-integration.md`](../research/android-native-integration.md) §11,
  [`docs/architecture/modularity-refactor-strategy.md`](../architecture/modularity-refactor-strategy.md)

## Context

Almost all client-plane behaviour lives inside `apps/pages`:
- the vault and its tombs;
- federation and ambient sign-in;
- browser-local IAM;
- connectors and backup;
- duress, SOPS, wallet spending, transport status, the WebMCP tools and the
  support registries.

About 96k lines of `.ts` sit in `apps/pages/src` beside about 34k lines of
`.tsx`. Nothing outside the app can use them:
- The TS CLI (`packages/cli`) cannot read a vault.
- The Android app (`apps/authenticator-native`) cannot fill a password.
- Some logic has already been copied instead of shared:
  - `apps/ceremonies/src/lib/drop.ts` mirrors `lib/vault/drop.ts`;
  - `packages/ceremony-kit/src/claim-stash.ts` mirrors `lib/queue.ts`;
  - `packages/redteam` and `packages/contracts` hold copies of duress
    modules;
  - about twelve private base64 helpers exist.

The Android research (§11) compared the ways to share it:
- A Rust kernel would mean a rewrite.
- Vercel Labs' `scriptc` and Native SDK do not target Android and speak
  Node's API rather than the browser's.
- Running the existing TypeScript through Android's `JavaScriptSandbox`, a
  bare V8 isolate, reuses the code as it is.

What stands in the way was measured on 2026-09-22:
- **React in the logic.** Fifteen `lib/` modules import React, and
  `vault/store.ts` reaches React through `remote-code.ts → identity.ts`.
- **Vite and module-load assumptions.** Sixteen modules read
  `import.meta.env`. Module singletons (`vaultStore`, `sopsSession`,
  `duressSessionFence`, `local-iam-events`) touch storage when imported.
- **One import cycle.** Nineteen of the twenty-four domain groups in
  `lib/` form a single strongly connected import graph, through `identity`,
  `settings`, `vault/store`, `kv`/`vfs`, `activity-log` and
  `embedded-catalog`. Splitting into domain packages first would mean
  breaking every cycle before anything could be reused.
- **Paths are written by hand elsewhere:** 26 capability-registry `pwa:`
  strings, build configs, `verify:*` fixtures and AGENTS.md. The structural
  baseline in `quality-baseline.json` is keyed by path.

## Decision

1. **One package first: `@opensesame/app-core`.**
   - Everything in Pages that is not UI moves into `packages/app-core/src`
     with its relative layout preserved. That covers `lib/**`, the WebMCP
     tool definitions, the non-DOM parts of `tutorial/`, and the colocated
     `.ts` helpers.
   - The moves use `git mv`, so history follows the files. Importers are
     rewritten by a checked-in script, not left behind shims, so no
     old-path/new-path pair survives the move.
   - Browser-only adapters move too, under `src/browser/**`.
   - `apps/pages` keeps:
     - the React tree and the React bindings;
     - the DOM, focus and keyboard helpers;
     - the PWA shell (service worker, install offer, push, update);
     - the tutorial renderer and its DOM target registry.
   - Moving code imports no React value. A type-only import
     (`import type { ComponentType } from "react"`) is allowed: it is erased
     at build time, and the contribution contract uses it to name the shell's
     component type without calling React. The package therefore takes
     `@types/react` as a dev dependency, never `react`.
2. **Standard web APIs are the runtime contract; ports cover what differs.**
   - **Contract, not ports.** These globals exist in both browsers and
     Node: `crypto` and `crypto.subtle`, `fetch` with `Headers`/`Request`/
     `Response`, `URL`, `TextEncoder`/`TextDecoder`, `atob`/`btoa`, timers,
     `AbortController`, `EventTarget`, `structuredClone`, and
     `String.prototype.normalize`.
     - The package writes the subset it uses into a declaration file and
       checks it with a DOM-free tsconfig.
     - A host that lacks them installs them before the core loads: Android
       bridges them to the platform, and CI uses a pure-JS reference.
   - **Ports** are defined in `src/host/types.ts`. They cover behaviour
     that differs by platform:
     - storage: `kv`, `sessionKv`, `legacyKv` (localStorage in a browser),
       `blobStore` (IndexedDB)
     - `navigation` and `peerChannel` (redirects, popups, opener
       messaging)
     - `authenticator` (WebAuthn and PRF)
     - `workers`
     - `env` (replaces `import.meta.env`)
     - `environment` (online state, visibility, activity, platform)
     - `locks` and `crossContext`
     - `clipboard`, `notifications`, `inference` and `toolHost`
   - An optional capability a host cannot provide fails closed, the way
     `protection/adapters/device-local.ts` already reports
     `requires-native-client`.
3. **One host per process.**
   - `configureHost(host)` runs once, before any other module does anything.
     `host()` throws if it never ran.
   - Singletons that touch a port are constructed lazily, on first use, and
     never at import. A test loads the portable entry points with no host
     installed to prove it.
   - Full constructor injection (`createClient(host)`) is deferred until
     something actually needs two instances in one process.
4. **Backing stores do not change.** A port preserves bytes and keys: in a
   browser, `legacyKv` is still `localStorage`. Consolidating stores would
   migrate user data and needs its own decision.
5. **Two new ratchets.** They work like `quality-baseline.json`: they can
   only fall.
   - **Portability ledger:** per-file uses of browser-only globals outside
     `src/browser/**`.
   - **Layering ledger:** permitted cross-domain imports inside app-core.

   They drive the ports, then the split into domain packages bottom-up,
   with `vault-core` (the tomb crypto and format kernel) first.
6. **Relocation keeps the structural baseline honest.**
   - `pnpm quality:gate --relocate <map>` re-keys recorded entries from the
     old path to the new one.
   - It refuses if any count at the new path exceeds the number recorded at
     the old path.
   - It is stricter than `--accept-new-debt`, which remains the escape for
     genuinely new debt.
7. **Behaviour is pinned before anything moves.** Golden vectors generated
   from the current code must decrypt identically at every step: in Pages,
   in app-core, through the CLI and in a bare isolate. They cover:
   - the password wrap, including a password NFKC normalisation changes;
   - bound and legacy unbound bodies;
   - the sealed export and offline-backup envelopes;
   - PIN and PRF-output wraps;
   - failure cases.

   The format is written down in
   [`docs/architecture/vault-format-v1.md`](../architecture/vault-format-v1.md).
8. **Scope boundaries.**
   - **Android scope is unchanged.** ADR 0058 still excludes password and
     passkey-provider behaviour from `apps/authenticator-native`, and this
     ADR adds no Android build or service.
   - **Design rules are unchanged.** Every rule in AGENTS.md §5 keeps its
     text. Where a rule names a Pages path, the path is updated when the
     file moves. The guest road, the unlock ceremony and the static-front-end
     guarantees stay in the Pages shell.
   - **No new agent surface.** The CLI verbs this enables (`opensesame-id
     vault verify|ls` over a sealed backup or export) read the password
     from a TTY only, print names and paths, never values, and are excluded
     from every agent surface in the capability registry (ADR 0005, 0065).

## Sequence

Each step is one pull request and green on its own:
0. This ADR, the format spec, golden vectors, the relocation gate, and a
   partition manifest with a checker for imports from moving code into
   staying code.
1. Take React and UI imports out of the logic, in place.
2. Create the package, the runtime env and the host skeleton; make
   singletons lazy.
3. The wholesale `git mv` relocation.
4. Ports, one domain per PR, under the portability ledger.
5. The Node host and the CLI verbs.
6. The sandbox reference host and a bare-isolate test.
7. Break the cycle and split domain packages.
8. Extract headless view-models from the largest screens, and remove the
   duplicates listed above.

## Consequences

- **Reuse starts at step 3,** not after the import graph is clean. The cost
  is a large package whose cycle is internal, with no package boundary to
  hold it in check until step 7. The layering ledger measures it, and every
  split is small.
- **Compiler settings.** app-core compiles with Pages' compiler options at
  first, not the stricter repository base. Moving 82k lines into
  `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` at once would
  be a rewrite. Tightening is ratcheted per domain.
- **Browser code inside the shared package.** `src/browser/**` is a platform
  subpath, as in many cross-platform libraries. Portability is proven by the
  DOM-free tsconfig, the ledger and the bare-isolate test, not by where a
  file sits.
- **Every hand-written path must follow a move.** The capability registry's
  path resolver, currently skipped, is re-enabled at step 3 so those strings
  are checked from then on.
- **Two vault formats remain.** The Pages tomb uses PBKDF2 and AES-GCM;
  `crates/human-vault` uses Argon2 and XChaCha20. Converging them is out of
  scope.

## Rejected alternatives

- **A minimal kernel package, with the rest left in Pages.** It leaves most
  behaviour unreusable, which is the problem being solved.
- **Break every cycle, then move into many packages.** It delays all reuse
  behind a long series of behavioural refactors inside Pages.
- **Rewrite the kernel in Rust (Wasm plus UniFFI).** It changes behaviour:
  regular-expression semantics and number handling differ, and two
  implementations would coexist during the migration. It stays the fallback
  if the Android sandbox fails its latency or availability test.
- **A bespoke port for every standard API.** Porting more than a hundred
  crypto, fetch and clock call sites would be a rewrite in disguise, for a
  contract that browsers and Node already meet.
- **Shims at old paths.** They would leave two paths to the same code, the
  failure mode `modularity-refactor-strategy.md` §1 documents.
