/**
 * Web Storage held in memory: a session store for a CLI process, the only
 * store a bare isolate has, and a test double that behaves like the real one.
 */
import type { WebStorage } from "./ports.js";

export function createMemoryStorage(
  initial: Iterable<readonly [string, string]> = [],
): WebStorage {
  const entries = new Map<string, string>(initial);
  return {
    get length() {
      return entries.size;
    },
    key: (index) => [...entries.keys()][index] ?? null,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, String(value));
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}
