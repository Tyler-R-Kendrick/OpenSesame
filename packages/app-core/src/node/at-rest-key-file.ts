/**
 * The CLI's at-rest key (ADR 0148): 32 random bytes in a file of their own,
 * readable by its owner only (0600) and kept apart from the storage file
 * it seals, so that file never holds a value in the clear. Linked into place
 * whole, so two processes starting at once agree on one key.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { b64ToBytes, bytesToB64 } from "@opensesame/vault-core";
import { AT_REST_KEY_BYTES } from "../lib/at-rest/cipher.js";
import type { AtRestKeyPort } from "../ports.js";

function readKey(path: string): Uint8Array | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const key = b64ToBytes(text.trim());
  if (key.length !== AT_REST_KEY_BYTES) {
    throw new Error(`${path} does not hold an at-rest key`);
  }
  return key;
}

function createKey(path: string): Uint8Array | null {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const key = crypto.getRandomValues(new Uint8Array(AT_REST_KEY_BYTES));
  // Written whole beside it, then linked into place: the name never exists
  // without its key, and a link to a name that exists fails.
  const temp = `${path}.${process.pid}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, `${bytesToB64(key)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temp, path);
  } catch (error) {
    // Another process linked its key first: theirs is the key.
    if (existsSync(path)) return null;
    throw error;
  } finally {
    unlinkSync(temp);
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
