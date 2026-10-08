/**
 * Web Storage persisted to one JSON file (ADR 0133 §5): the CLI's
 * `localStorage`. Every write replaces the file atomically — written beside
 * it, flushed, then renamed over it — and the file is created readable by its
 * owner only (0600), because what it holds is what a browser's local storage
 * holds: values sealed under the at-rest key (`at-rest-key-file.ts`,
 * ADR 0149), never one in the clear.
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
import { isString } from "@opensesame/os-domain";
import { z } from "zod";
import { createMemoryStorage } from "../memory-storage.js";
import type { WebStorage } from "../ports.js";

function readEntries(path: string): [string, string][] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (z.object({ code: z.literal("ENOENT") }).safeParse(error).success)
      return [];
    throw error;
  }
  const parsed: Record<string, string> = JSON.parse(text);
  return Object.entries(parsed).filter((entry): entry is [string, string] =>
    isString(entry[1]),
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
  // Each synchronous operation reads the current file. Compound read/merge/write
  // operations across processes still require the caller's Host operation lock.
  const current = () => createMemoryStorage(readEntries(path));
  current();
  const persist = (memory: WebStorage) => {
    const snapshot: Record<string, string> = {};
    for (let index = 0; index < memory.length; index += 1) {
      const key = memory.key(index);
      if (key !== null) snapshot[key] = memory.getItem(key) ?? "";
    }
    writeAtomically(path, `${JSON.stringify(snapshot)}\n`);
  };
  return {
    get length() {
      return current().length;
    },
    key: (index) => current().key(index),
    getItem: (key) => current().getItem(key),
    setItem: (key, value) => {
      const memory = current();
      memory.setItem(key, value);
      persist(memory);
    },
    removeItem: (key) => {
      const memory = current();
      memory.removeItem(key);
      persist(memory);
    },
  };
}
