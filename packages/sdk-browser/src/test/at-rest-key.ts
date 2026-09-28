/**
 * Vitest setup: Node has no IndexedDB, so the suite holds the origin's
 * at-rest key in memory (ADR 0148). Values then reach a test's storage
 * sealed, exactly as in a browser; `at-rest.test.ts` covers the origin
 * that can keep no key at all.
 */
import { openFromRest, useClientAtRestKeys } from "@opensesame/browser-at-rest";

const key = crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
  "encrypt",
  "decrypt",
]);
useClientAtRestKeys(() => key);

/** A stored value as the client wrote it, opened (null when absent). */
export async function opened(
  storage: { getItem(key: string): string | null },
  key: string,
): Promise<string | null> {
  const raw = storage.getItem(key);
  return raw === null ? null : openFromRest("sdk-browser", key, raw);
}
