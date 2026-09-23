/**
 * Runtime capability facts for the Formats panel (B13, UX-01).
 *
 * These are derived by exercising the real executable path, not declared:
 * `sopsCapability()` asks the engine to parse and inspect a tiny document
 * and to reach its primitives, so the panel cannot advertise a format the
 * shipped bundle could not actually handle. There is no native runtime to
 * detect and no environment variable to read.
 */

import { gcm } from "@noble/ciphers/aes";
import { SopsEngine } from "./engine.js";
import type { VerifiedDocument } from "./engine.js";
import { HandleRegistry } from "./handles.js";
import { SOPS_PROFILE } from "./inspect.js";

export type FormatCapability =
  | {
      available: true;
      runtime: "browser";
      read: true;
      write: true;
      profile: string;
    }
  | {
      available: false;
      runtime: "unavailable";
      read: boolean;
      write: boolean;
      reason: string;
    };

/** A parse the engine must manage, and one AES-GCM call under a 32-byte nonce. */
function enginePathWorks(): boolean {
  try {
    const probe = new SopsEngine(new HandleRegistry<VerifiedDocument>(() => 0));
    if (probe.inspect("probe: value\n", "yaml").encrypted) return false;
    if (probe.inspect('{"probe":"value"}', "json").encrypted) return false;
    const key = new Uint8Array(32);
    const nonce = new Uint8Array(32);
    const sealed = gcm(key, nonce, new Uint8Array(0)).encrypt(
      new Uint8Array([1, 2, 3]),
    );
    return gcm(key, nonce, new Uint8Array(0)).decrypt(sealed).byteLength === 3;
  } catch {
    return false;
  }
}

let cached: FormatCapability | null = null;

/** SOPS YAML/JSON with local age identities, entirely in this browser. */
export function sopsCapability(): FormatCapability {
  if (cached) return cached;
  cached = enginePathWorks()
    ? {
        available: true,
        runtime: "browser",
        read: true,
        write: true,
        profile: SOPS_PROFILE,
      }
    : {
        available: false,
        runtime: "unavailable",
        read: false,
        write: false,
        reason: "This browser could not run the bundled SOPS engine.",
      };
  return cached;
}
