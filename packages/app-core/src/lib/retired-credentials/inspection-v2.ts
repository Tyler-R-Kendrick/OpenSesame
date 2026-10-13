/** Data-only projection. The private Store must freshly authenticate and pin the slot before returning this view. */
import {
  encodeRetiredCredentialContextV2,
  parseRetiredCredentialContextV2,
} from "./context-v2.js";
import {
  type TrapEventV2,
  parseRetainedRetiredCredentialRecordsV2,
} from "./records-v2.js";

export type RetiredCredentialSummary = Readonly<{
  id: string;
  createdAt: string;
  expiresAt: string;
  response: "reject" | "synthetic_decoy";
}>;
export type RetiredCredentialInspection = Readonly<{
  traps: readonly RetiredCredentialSummary[];
  events: readonly Readonly<TrapEventV2>[];
  stale: boolean;
}>;

/** No authentication claim, context identity, salt, verifier, root, or mutable retained object leaves this codec. */
export function projectRetiredCredentialInspection(
  raw: string | null,
  currentWire: string,
): RetiredCredentialInspection {
  const current = parseRetiredCredentialContextV2(currentWire);
  if (encodeRetiredCredentialContextV2(current) !== currentWire)
    throw new Error("Retired credential inspection is unavailable.");
  if (raw === null)
    return Object.freeze({
      traps: Object.freeze([]),
      events: Object.freeze([]),
      stale: false,
    });
  const retained = parseRetainedRetiredCredentialRecordsV2(raw);
  if (retained.context.tomb !== current.tomb)
    throw new Error("Retired credential inspection is unavailable.");
  const stale =
    encodeRetiredCredentialContextV2(retained.context) !== currentWire;
  return Object.freeze({
    traps: Object.freeze(
      stale
        ? []
        : retained.traps.map(({ id, createdAt, expiresAt, response }) =>
            Object.freeze({ id, createdAt, expiresAt, response }),
          ),
    ),
    events: Object.freeze(
      stale ? [] : retained.events.map((event) => Object.freeze({ ...event })),
    ),
    stale,
  });
}
