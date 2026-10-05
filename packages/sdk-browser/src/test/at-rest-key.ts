/**
 * Vitest setup: Node has no IndexedDB, so the suite holds the origin's
 * at-rest key in memory (ADR 0149). Values then reach a test's storage
 * sealed, exactly as in a browser; `at-rest.test.ts` covers the origin
 * that can keep no key at all.
 */
import { openFromRest, useClientAtRestKeys } from "@opensesame/browser-at-rest";

import { FIXTURE_ROOT } from "./storage-fixture.js";
const key = crypto.subtle.importKey("raw", FIXTURE_ROOT, "AES-GCM", false, [
  "encrypt",
  "decrypt",
]);
useClientAtRestKeys(() => key);

/** A stored value as the client wrote it, opened (null when absent). */
export async function opened(
  storage: { getItem(key: string): string | null },
  key: string,
  scope = JSON.stringify([
    "sdk-browser",
    "http://127.0.0.1:8788",
    "opensesame-browser",
  ]),
): Promise<string | null> {
  const raw = storage.getItem(key);
  return raw === null ? null : openFromRest(scope, key, raw);
}
