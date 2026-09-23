/**
 * Web Storage persisted to one JSON file (ADR 0133 §5): the CLI's
 * `localStorage`. Every write replaces the file atomically — written beside
 * it, flushed, then renamed over it — and the file is created readable by its
 * owner only (0600), because what it holds is what a browser's local storage
 * holds: sealed vault state and settings, never a plaintext secret.
 */
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { createMemoryStorage } from "../memory-storage.js";
import type { WebStorage } from "../ports.js";

function readEntries(path: string): [string, string][] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const parsed: Record<string, string> = JSON.parse(text);
  return Object.entries(parsed).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
}

function writeAtomically(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  const fd = openSync(temp, "w", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}

export function createFileStorage(path: string): WebStorage {
  const memory = createMemoryStorage(readEntries(path));
  const persist = () => {
    const snapshot: Record<string, string> = {};
    for (let index = 0; index < memory.length; index += 1) {
      const key = memory.key(index);
      if (key !== null) snapshot[key] = memory.getItem(key) ?? "";
    }
    writeAtomically(path, `${JSON.stringify(snapshot)}\n`);
  };
  return {
    get length() {
      return memory.length;
    },
    key: (index) => memory.key(index),
    getItem: (key) => memory.getItem(key),
    setItem: (key, value) => {
      memory.setItem(key, value);
      persist();
    },
    removeItem: (key) => {
      memory.removeItem(key);
      persist();
    },
  };
}
