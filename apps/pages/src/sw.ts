/// <reference lib="webworker" />

/**
 * The core-only service worker (`sw.js`, ownership.md §4.7).
 *
 * What this file does: install the core worker over this scope. What it saves
 * at install: the shell (`index.html`) into
 * `opensesame-pages:<scopePath>:<releaseId>:core-only`, and nothing else from
 * the manifest. Every other offline asset arrives by a `PLAN_ASSETS` message
 * naming approved module ids, resolved through the release's
 * `capability-graph.json` (`src/sw/plan-assets.ts`).
 *
 * What this file does not do: push. A service worker cannot `import()` and
 * cannot load an unknown script after install, so the push handlers are a
 * second generated script, `sw-push.js` (`src/sw-push.ts`), registered only
 * when the plan requires that variant. Nothing here imports `lib/push.ts`.
 */

import { overlapCast } from "@opensesame/os-domain";
import { installCoreWorker } from "./sw/core.js";
import { manifestFromBoundary } from "./sw/release.js";

// SAFETY: this file is a service worker; globalThis is ServiceWorkerGlobalScope
// at runtime, but the TS lib types do not overlap.
const sw: ServiceWorkerGlobalScope = overlapCast(globalThis);

installCoreWorker(sw, {
  variant: "core-only",
  // vite-plugin-pwa replaces `self.__WB_MANIFEST` in the built script. Only
  // the shell entry is read from it (`src/sw/release.ts`): its revision is
  // the release id, and its URL is the one file precached at install.
  // @ts-expect-error replaced by vite-plugin-pwa during the service-worker build
  manifest: manifestFromBoundary(self.__WB_MANIFEST),
});
