/** Shared duress feature types (no circular imports). */

export type DuressFeatureMode = "off" | "local_only" | "optional_peer";

/** Reader format version supported by this build. */
export const DURESS_READER_VERSION = 1;

export function isDuressFeatureEnabled(mode: DuressFeatureMode): boolean {
  return mode !== "off";
}
