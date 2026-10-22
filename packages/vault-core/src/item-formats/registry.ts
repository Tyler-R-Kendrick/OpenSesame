/** Detection, exact-type parsing, synthetic generation, and explicit coverage. */
import type { FieldValues } from "@opensesame/vault-item-types";
import { DETECTED_FORMATS, formatsForType } from "./formats.js";
import { Random } from "./random.js";
import type {
  GenerateItemFormatOptions,
  GeneratedItemFormat,
  ItemFormat,
  ItemFormatMatch,
} from "./types.js";

/** Types whose general shape is not a single standard value. */
const UNSUPPORTED_REASONS = new Map<string, string>([
  [
    "account",
    "A login combines a site, an account name and one or more methods.",
  ],
  ["address", "Postal addresses have no universal serialised form."],
  ["contact", "A contact combines independent names, addresses and numbers."],
  [
    "combination-lock",
    "A combination is an arbitrary sequence, not an issuer format.",
  ],
  [
    "drivers-license",
    "Licence numbers are jurisdiction-specific and have no common checksum.",
  ],
  ["drop", "A drop is a sealed transfer, never a parseable credential value."],
  [
    "environment",
    "An environment is a schema plus bindings, not one secret value.",
  ],
  ["file", "A file is bytes with a manifest, not a textual credential format."],
  [
    "guardian-share",
    "A recovery share is a quorum fragment with a bespoke envelope.",
  ],
  ["health-insurance", "Member and group identifiers are payer-specific."],
  [
    "membership",
    "Membership numbers are issuer-specific with no common checksum.",
  ],
  ["note", "A note is free prose."],
  [
    "oauth-client",
    "Client ids and secrets are opaque and have no common issuer shape.",
  ],
  ["person-name", "A name has no serialised secret format."],
  [
    "trusted-circle",
    "A trusted circle is a policy record, not a secret value.",
  ],
]);

/** The preferred format for a type when the caller does not name one. */
const DEFAULT_FORMAT = new Map<string, string>([
  ["api-key", "api-key:generic-api-key"],
  ["api-credential", "api-credential:generic-api-key"],
]);

function normalise(value: string): string {
  return value.trim();
}

function matchOf(format: ItemFormat, value: string): ItemFormatMatch | null {
  try {
    const values = format.parse(value);
    if (values === null) return null;
    return {
      formatId: format.id,
      typeId: format.typeId,
      label: format.label,
      specificity: format.specificity,
      values,
      canonical: value,
    };
  } catch {
    // A malformed URL escape or decoder must be a non-match, not a page error.
    return null;
  }
}

/** Every format that accepts this one value, strongest first. */
export function detectItemFormats(value: string): readonly ItemFormatMatch[] {
  const raw = normalise(value);
  if (raw === "") return [];
  const seen = new Set<string>();
  const matches: ItemFormatMatch[] = [];
  for (const format of DETECTED_FORMATS) {
    if (seen.has(`${format.typeId}:${format.id}`)) continue;
    const match = matchOf(format, raw);
    if (!match) continue;
    seen.add(`${format.typeId}:${format.id}`);
    matches.push(match);
  }
  return matches.sort((left, right) => right.specificity - left.specificity);
}

/** The strongest match, or null when no registered format accepts the value. */
export function bestItemFormat(value: string): ItemFormatMatch | null {
  return detectItemFormats(value)[0] ?? null;
}

/** Parse one value as a named item type, optionally through one format. */
export function parseItemFormat(
  typeId: string,
  value: string,
  formatId?: string,
): ItemFormatMatch | null {
  if (value.trim() === "") return null;
  const formats = formatsForType(typeId).filter(
    (format) => formatId === undefined || format.id === formatId,
  );
  for (const format of formats) {
    // Exact parsing preserves a secret's leading/trailing whitespace; only
    // detection normalises the candidate.
    const match = matchOf(format, value);
    if (match) return match;
  }
  return null;
}

/**
 * Produce a synthetic, structurally valid value for an item type.
 *
 * The output is test-shaped: it uses `.test` domains, test key prefixes, and
 * amounts or identifiers that never belonged to a person. It is not a live
 * credential and no provider was consulted.
 */
export function generateItemFormat(
  typeId: string,
  options: GenerateItemFormatOptions = {},
): GeneratedItemFormat | null {
  const formats = formatsForType(typeId).filter(
    (format) => format.generate !== undefined,
  );
  if (formats.length === 0) return null;
  const preferred = options.formatId ?? DEFAULT_FORMAT.get(typeId);
  const format =
    formats.find((entry) => entry.id === preferred) ??
    (options.formatId === undefined ? formats[0] : undefined);
  if (!format?.generate) return null;
  const random = options.random ?? new Random();
  const context = {
    random,
    now: options.now ?? new Date(),
  };
  const values = format.generate(context);
  return {
    formatId: format.id,
    typeId: format.typeId,
    label: format.label,
    specificity: format.specificity,
    values,
    canonical: format.canonical?.(values) ?? null,
  };
}

/** Convenience for callers that only want the generated field values. */
export function generateItemValues(
  typeId: string,
  options: GenerateItemFormatOptions = {},
): FieldValues | null {
  return generateItemFormat(typeId, options)?.values ?? null;
}

export type ItemFormatCoverage =
  | {
      readonly status: "parser+generator" | "parser";
      readonly formats: readonly string[];
    }
  | {
      readonly status: "unsupported";
      readonly reason: string;
    };

/** What this build can honestly do for an item type. */
export function itemFormatCoverage(typeId: string): ItemFormatCoverage {
  const formats = formatsForType(typeId);
  if (formats.length === 0) {
    return {
      status: "unsupported",
      reason:
        UNSUPPORTED_REASONS.get(typeId) ??
        "No canonical secret format is registered for this type.",
    };
  }
  return {
    status: formats.some((format) => format.generate !== undefined)
      ? "parser+generator"
      : "parser",
    formats: formats.map((format) => format.id),
  };
}

/** The known built-in and optional ids; a test holds coverage to this list. */
export const FORMAT_ITEM_TYPE_IDS: readonly string[] = [
  "account",
  "address",
  "api-credential",
  "api-key",
  "authenticator",
  "backup-codes",
  "bank-account",
  "card",
  "certificate",
  "combination-lock",
  "contact",
  "crypto-wallet",
  "database",
  "drivers-license",
  "drop",
  "email-account",
  "environment",
  "file",
  "gift-card",
  "guardian-share",
  "health-insurance",
  "identity-document",
  "membership",
  "note",
  "oauth-client",
  "passkey",
  "passport",
  "password",
  "secret",
  "server",
  "software-license",
  "ssh-key",
  "token",
  "trusted-circle",
  "vehicle",
  "wifi",
].sort((left, right) => left.localeCompare(right));
