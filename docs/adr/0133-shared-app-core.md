# ADR 0133 — One shared application core for the PWA, the CLIs and Android

- **Status:** Accepted — implemented (see *As built*)
- **Date:** 2026-09-22; as built 2026-09-23
- **Deciders:** OpenSesame maintainers
- **Relates to:** ADR 0017 (host/client topology), ADR 0058 (native
  authenticator), ADR 0065 (agent-surface parity), ADR 0088 (in-product
  support), ADR 0090 (static front end), ADR 0093 (structural quality gates),
  [`docs/research/android-native-integration.md`](../research/android-native-integration.md) §11,
  [`docs/research/modularity-refactor-strategy.md`](../research/modularity-refactor-strategy.md)

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
  - `tests/redteam` and `packages/contracts` hold copies of duress
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
  baseline in `tools/quality/quality-baseline.json` is keyed by path.

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
   - **Ports** are fields of `Host` in `src/host.ts`. They cover behaviour
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
5. **Two new ratchets.** They work like `tools/quality/quality-baseline.json`: they can
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
2. Create the package, the runtime env and the host skeleton.
3. The wholesale `git mv` relocation.
4. Ports, one domain per PR, under the portability ledger. A singleton
   becomes lazy in the PR that gives its constructor a port.
5. The Node host and the CLI verbs.
6. The sandbox reference host and a bare-isolate test.
7. Break the cycle and split domain packages.
8. Extract headless view-models from the largest screens, and remove the
   duplicates listed above.

## As built

Everything in *Sequence* landed. Where the build departed from the plan
above, this section is the record.

**Packages.**
- `@opensesame/app-core` holds the client core, laid out as `apps/pages/src`
  was, including the screens' view-models (`*-model.ts` beside the path of the
  component they serve). Pages keeps rendering, state, effects and the
  presentation that is genuinely DOM work (downloads, clipboard, key
  handling, the wordmark animation).
- `@opensesame/vault-core` is the vault format kernel: header, KDF and seals,
  unlock records, the item model and paths, TOTP, the offline-backup
  envelope, the vault-file reader and the secret-drop format, with the golden
  vectors. It depends on `os-domain` and `vault-item-types` only and compiles
  under the strict repository base. Pages' `/claim` route opens drops with
  it (the ceremonies app did until it moved into Pages and was deleted,
  [ADR 0140](0140-pages-hosts-every-ceremony.md)), so the drop format has one
  implementation.
- **Further splits are drawn where a consumer needs a subset,** not ahead of
  one. `vault-core` exists because the CLI and an Android isolate need the
  read path without the rest. The other domain packages listed in step 7
  would add package boilerplate with no new reuse; what they were meant to
  buy — no import cycle — is enforced directly (below).

**Ports** (`src/ports.ts`), read at call time through accessors: storage
(`local`, `session`), `page` (address, opener and window messaging,
visibility, download, form post), `authenticator` (WebAuthn), `environment`
(online state, user agent, user activation, which workers exist), `locks`,
`broadcast`, `worker` (a constructor, so each capability module keeps Vite's
literal `new Worker(new URL(…), import.meta.url)` and its worker stays in
that capability's chunk), `serviceWorker`, `originFiles` (OPFS) and
`indexedDB`. The planned `kv`/`blobStore` ports were unnecessary: the kv
backends sit on `originFiles` and `indexedDB`. Clipboard, notifications and
inference stay in the shell or behind existing seams.

**Hosts.** `src/browser/host.ts` (Pages installs it in `src/host/boot.ts`
before anything else), `src/node/host.ts` (the CLI: file-backed local
storage, atomic writes, mode 0600) and `src/sandbox/host.ts`.
`sandbox/runtime-contract.ts` installs what a bare isolate lacks and never
replaces what it has: `crypto.subtle` (PBKDF2, HKDF, HMAC, AES-GCM, SHA-256
over `@noble/hashes` and `@noble/ciphers`), UTF-8 codecs, `atob`/`btoa` and
`URL` (whatwg-url). Entropy is the embedder's only; with none,
`getRandomValues` throws. `assertHostIntl` refuses an isolate that cannot
NFKC-normalise.

**Gates** (`pnpm quality:app-core`, `docs/validation/code-quality-gates.md`
§3). The planned portability *ledger* became a zero-violation rule: no value
use of a browser-only global outside `src/browser/**`, worker entries and
tests. The layering ledger became: no static import cycle at all (nine were
broken — barrel re-exports, a seam module the ceremony imported back, a dead
import, and the device-local Identity host now loads its local IAM routes on
first use), plus a ledger of the five lazy `import()` edges that still close
a loop, which only shrinks. `node:*` may appear only in `src/node/**`.
`no-host-import.test.ts` proves no module reads a port while it loads;
`sandbox/bare-isolate.test.ts` replays the golden vectors in an empty V8
context.

**CLI.** `opensesame-id vault verify <file>` and `vault ls <file>` read the
master password from the terminal only and print the tomb, binding,
revision and each item's path and kind. Registry entries `vault.file.verify`
and `vault.file.list` exclude every agent surface (ADR 0005).

**Duplicates removed.** One base64 (`vault-core`) instead of nine private
copies; federation's PKCE and base64url on `sdk-browser`; the drop format;
the duress attack trees, terminology and `defined` guard in
`@opensesame/contracts`; the console's claim stash on ceremony-kit's. The
claim stash was never a copy of `lib/queue.ts`, as *Context* supposed: its
storage is injected because Pages keeps claim bearers in memory only.

**Registry.** The PWA path check is on again and resolves `lib/` in the
core or the shell and `vault-core/` in the kernel. It found twenty `pwa:`
surfaces naming files deleted on 2026-09-20 (tasks, delegations, relay,
agent runs, access requests, join); they are `null`, and their operations
and tutorial mappings are gone with them. The item model's kinds are format,
not capability code — every reader must open every kind a sealed body holds.

**Known and unchanged.** `verify:capability-graph` fails on `main` as well
(355 findings: the entry statically reaches several optional capability
chunks). This work leaves that set as it found it, one finding fewer.

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
