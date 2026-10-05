/**
 * Origin-private files, sealed (ADR 0149). `kv.ts` and travel
 * (`travel/storage.ts`) write every `opensesame-pages-*.json` file as an
 * at-rest seal bound to its file name, and read the plaintext back. The
 * binding is the file name, not the key, because travel moves files by name.
 *
 * The vault's own ciphertext is sealed twice — once under the vault key, once
 * under this — and what used to be the documented plaintext boundary (vault
 * header parameters, lockout counters, the tomb registry) is sealed once.
 */

import {
  AT_REST_OVERHEAD_BYTES,
  AT_REST_PREFIX,
  atRestBinding,
  isSealedAtRest,
  openAtRest,
  sealAtRest,
} from "./cipher.js";
import { type AtRestKey, atRestReady } from "./key.js";

function binding(name: string): Uint8Array {
  return atRestBinding("origin-file", name);
}

export function sealOriginFile(
  atRest: AtRestKey,
  name: string,
  value: string,
): string {
  return sealAtRest(atRest.key, binding(name), value);
}

/**
 * A file's plaintext. A file written before values were sealed reads as it
 * is (`origin-files-sweep.ts` seals it at the next boot); a sealed file that
 * does not open under this device's key reads as null.
 */
export async function openOriginFile(
  name: string,
  text: string,
): Promise<string | null> {
  if (!isSealedAtRest(text)) return text;
  const atRest = await atRestReady();
  return openAtRest(atRest.key, binding(name), text);
}

/** The largest sealed file a plaintext of `maxBytes` bytes can become. */
export function sealedFileBound(maxBytes: number): number {
  return (
    AT_REST_PREFIX.length +
    Math.ceil(((maxBytes + AT_REST_OVERHEAD_BYTES) * 4) / 3) +
    4
  );
}
