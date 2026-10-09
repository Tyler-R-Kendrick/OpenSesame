/** Explicit stale-sidecar destruction data only; Store must authenticate and guard publication. */
import {
  encodeRetiredCredentialContextV2,
  parseRetiredCredentialContextV2,
} from "./context-v2.js";
import {
  RETIRED_CREDENTIAL_MATCHING_V2,
  encodeRetiredCredentialRecordsV2,
  parseRetainedRetiredCredentialRecordsV2,
} from "./records-v2.js";

export function prepareClearedStaleRetiredRecords(
  raw: string | null,
  currentWire: string,
): string {
  if (raw === null)
    throw new Error("Stale retired credential records are unavailable.");
  const current = parseRetiredCredentialContextV2(currentWire);
  const retained = parseRetainedRetiredCredentialRecordsV2(raw);
  if (
    retained.context.tomb !== current.tomb ||
    encodeRetiredCredentialContextV2(retained.context) === currentWire
  ) {
    throw new Error("Stale retired credential records are unavailable.");
  }
  // Explicitly deletes every old verifier AND local observation; never copies old hashes into current authority.
  return encodeRetiredCredentialRecordsV2(
    JSON.stringify({
      v: 2,
      context: current,
      matching: RETIRED_CREDENTIAL_MATCHING_V2,
      traps: [],
      events: [],
    }),
    currentWire,
  );
}
