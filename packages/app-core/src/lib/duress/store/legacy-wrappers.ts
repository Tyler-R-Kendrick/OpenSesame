import {
  type BoundaryValue,
  type JsonObject,
  type JsonValue,
  type MutableJsonObject,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
  isTypeofObject,
  overlapCast,
  readString,
} from "../json-boundary.js";
/**
 * Legacy unlock-wrapper inventory for enrollment migration (STORE-B).
 * Scans plaintext tomb headers only — never opens sealed bodies.
 */

import type { VaultHeader } from "@opensesame/vault-core";
import { readTombHeader } from "../../vault/store-header.js";
import { listTombs } from "../../vfs.js";

export type WrapperKind =
  | "password"
  | "pin"
  | "passkey"
  | "totp_second_step"
  | "recovery"
  | "remote_code"
  | "unknown";

export type WrapperInventoryEntry = Readonly<{
  tomb: string;
  wrappers: readonly WrapperKind[];
  /** True when header suggests this tomb may share wrap material with another. */
  potentiallySharedRoot: boolean;
}>;

function unlockWrappers(header: VaultHeader): WrapperKind[] {
  const unlocks = header.unlocks;
  if (!unlocks) return [];
  const out: WrapperKind[] = [];
  if (unlocks.pin) out.push("pin");
  if (unlocks.passkey) out.push("passkey");
  if (unlocks.totp) out.push("totp_second_step");
  if (unlocks.recovery) out.push("recovery");
  if (unlocks.email || unlocks.sms) out.push("remote_code");
  return out;
}

function wrappersOn(header: VaultHeader): WrapperKind[] {
  const out: WrapperKind[] = [];
  if (header.wrap && header.kdf) out.push("password");
  out.push(...unlockWrappers(header));
  if (out.length === 0) out.push("unknown");
  return out;
}

/**
 * Inventory every sealed tomb's unlock wrappers for migration planning.
 * Independent-compartment enrollment must account for alternate wrappers that
 * could bypass a claimed hold (INV alternate-wrapper).
 */
export function inventoryLegacyWrappers(
  tombs: readonly string[] = listTombs(),
): WrapperInventoryEntry[] {
  const entries: WrapperInventoryEntry[] = [];
  for (const tomb of tombs) {
    const header = readTombHeader(tomb);
    if (!header) continue;
    const wrappers = wrappersOn(header);
    entries.push({
      tomb,
      wrappers,
      potentiallySharedRoot:
        wrappers.includes("password") ||
        wrappers.includes("pin") ||
        wrappers.includes("passkey"),
    });
  }
  return entries;
}

export function alternateWrapperWarnings(
  inventory: readonly WrapperInventoryEntry[],
  heldProfileId: string,
): string[] {
  const warnings: string[] = [];
  for (const entry of inventory) {
    for (const w of entry.wrappers) {
      if (
        w === "password" ||
        w === "pin" ||
        w === "passkey" ||
        w === "recovery"
      ) {
        warnings.push(
          `tomb:${entry.tomb} wrapper:${w} may bypass hold for profile:${heldProfileId}`,
        );
      }
    }
  }
  return warnings;
}
