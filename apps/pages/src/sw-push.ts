/// <reference lib="webworker" />

/**
 * The push-capable service worker (`sw-push.js`, ownership.md §4.7).
 *
 * The same core worker as `sw.ts` — shell precache, plan-driven offline
 * assets, owned caches under the `push` variant name — plus the Web Push
 * handlers (ADR 0084). Built by `scripts/build-workers.mjs` only when the
 * distribution includes `notifications.web-push`; registered by the worker
 * controller only when the plan requires this variant and the installation
 * accepted that capability.
 */

import { overlapCast } from "@opensesame/os-domain";
import { installCoreWorker } from "./sw/core.js";
import { installPushHandlers } from "./sw/push-handlers.js";
import { manifestFromBoundary } from "./sw/release.js";

// SAFETY: this file is a service worker; globalThis is ServiceWorkerGlobalScope
// at runtime, but the TS lib types do not overlap.
const sw: ServiceWorkerGlobalScope = overlapCast(globalThis);

installCoreWorker(sw, {
  variant: "push",
  // `scripts/build-workers.mjs` defines `self.__WB_MANIFEST` for this build
  // with the same shell entry and revision vite-plugin-pwa injects into
  // `sw.js`, so both variants of one build agree on the release id.
  // @ts-expect-error defined by scripts/build-workers.mjs during the push-worker build
  manifest: manifestFromBoundary(self.__WB_MANIFEST),
});

installPushHandlers(sw);
