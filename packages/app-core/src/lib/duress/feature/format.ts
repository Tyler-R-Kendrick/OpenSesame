/**
 * Format-version refusal (BUILD-C / INV-29).
 * Feature-off readers must not unlock enrolled vaults via legacy paths.
 */

import {
  DURESS_READER_VERSION,
  type DuressFeatureMode,
  isDuressFeatureEnabled,
} from "./types.js";

export type DuressFormatHeader = Readonly<{
  duressFormatVersion: number;
  armed: boolean;
}>;

export type FormatRefusal =
  | { ok: true }
  | { ok: false; code: "unsupported_profile_version" };

/**
 * Fail closed for:
 * - feature-off + armed enrollment (no legacy unrestricted unlock)
 * - reader version behind vault format
 * - non-positive / missing version when armed
 */
export function refuseUnsupportedDuressFormat(
  header: DuressFormatHeader | null | undefined,
  readerSupportsVersion: number = DURESS_READER_VERSION,
  mode: DuressFeatureMode = "off",
): FormatRefusal {
  if (!header || !header.armed) {
    return { ok: true };
  }

  if (!isDuressFeatureEnabled(mode)) {
    return { ok: false, code: "unsupported_profile_version" };
  }

  if (
    !Number.isFinite(header.duressFormatVersion) ||
    header.duressFormatVersion < 1
  ) {
    return { ok: false, code: "unsupported_profile_version" };
  }

  if (header.duressFormatVersion > readerSupportsVersion) {
    return { ok: false, code: "unsupported_profile_version" };
  }

  return { ok: true };
}

/** Unlock / import boundary gate. */
export function assertReadableDuressHeader(
  header: DuressFormatHeader | null | undefined,
  mode: DuressFeatureMode,
  readerSupportsVersion: number = DURESS_READER_VERSION,
): FormatRefusal {
  return refuseUnsupportedDuressFormat(header, readerSupportsVersion, mode);
}

/** Human-readable refusal detail for logs/UI (never used as an unlock bypass). */
export function explainFormatRefusal(
  header: DuressFormatHeader | null | undefined,
  mode: DuressFeatureMode,
  readerSupportsVersion: number = DURESS_READER_VERSION,
): string | null {
  const result = refuseUnsupportedDuressFormat(
    header,
    readerSupportsVersion,
    mode,
  );
  if (result.ok) return null;
  if (!header?.armed) return "unsupported_profile_version";
  if (!isDuressFeatureEnabled(mode)) {
    return "feature_off_reader_refuses_armed_vault";
  }
  if (header.duressFormatVersion > readerSupportsVersion) {
    return `reader_v${readerSupportsVersion}_cannot_read_v${header.duressFormatVersion}`;
  }
  return "unsupported_profile_version";
}
