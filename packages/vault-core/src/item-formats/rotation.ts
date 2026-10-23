/** Rotation capabilities for item types, kept apart from synthetic generation. */
import { itemFormatCoverage } from "./registry.js";

/** Every supported rotation starts on the same schedule (product default). */
export const DEFAULT_ROTATION_INTERVAL_DAYS = 30;

/**
 * Types whose provider path can change the credential without inventing a
 * value locally. Today that is the web login: ADR 0076 rotates the password
 * at the relying party through the Host runner. A type absent here has no
 * verified provider path, even when its format has a generator.
 */
const AUTOMATIC_ROTATION_TYPE_IDS: ReadonlySet<string> = new Set(["account"]);

export type ItemRotationMode = "automatic" | "manual" | "none";

/**
 * `automatic` means a provider path exists; `manual` means the format can
 * generate a synthetic value but cannot rotate it at a provider; `none` means
 * there is neither.
 */
export function itemRotationMode(typeId: string): ItemRotationMode {
  if (AUTOMATIC_ROTATION_TYPE_IDS.has(typeId)) return "automatic";
  return itemFormatCoverage(typeId).status === "parser+generator"
    ? "manual"
    : "none";
}

/** Whether the type has any rotation action, automatic or generator-backed. */
export function itemHasGenerator(typeId: string): boolean {
  return itemRotationMode(typeId) !== "none";
}

/**
 * The honest sentence a generator-backed type carries when no provider path
 * can confirm that a rotation reached the issuer.
 */
export function itemRotationWarning(typeId: string): string | null {
  if (itemRotationMode(typeId) !== "manual") return null;
  return "Automatic rotation couldn't verify this item type. Its generator makes a test-shaped value, not a provider change.";
}
