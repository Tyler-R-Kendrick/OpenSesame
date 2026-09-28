/**
 * The CLI's at-rest key (ADR 0148): 32 random bytes in a file of their own,
 * readable by its owner only (0600) and kept apart from the storage file
 * it seals, so that file never holds a value in the clear. Created with an
 * exclusive open, so two processes starting at once agree on one key.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { b64ToBytes, bytesToB64 } from "@opensesame/vault-core";
import { AT_REST_KEY_BYTES } from "../lib/at-rest/cipher.js";
import type { AtRestKeyPort } from "../ports.js";

function readKey(path: string): Uint8Array | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const key = b64ToBytes(text.trim());
  if (key.length !== AT_REST_KEY_BYTES) {
    throw new Error(`${path} does not hold an at-rest key`);
  }
  return key;
}

function createKey(path: string): Uint8Array | null {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const key = crypto.getRandomValues(new Uint8Array(AT_REST_KEY_BYTES));
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  try {
    writeSync(fd, `${bytesToB64(key)}\n`);
  } finally {
    closeSync(fd);
  }
  return key;
}

export function loadAtRestKeyFile(path: string): Uint8Array {
  const key = readKey(path) ?? createKey(path) ?? readKey(path);
  if (!key) throw new Error(`could not keep an at-rest key at ${path}`);
  return key;
}

export function fileAtRestKeys(path: string): AtRestKeyPort {
  return {
    loadSync: () => loadAtRestKeyFile(path),
    load: async () => loadAtRestKeyFile(path),
  };
}
