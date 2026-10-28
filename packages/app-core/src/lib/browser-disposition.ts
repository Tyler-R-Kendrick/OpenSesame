/**
 * Why a provider has no browser connection, said once and with its evidence
 * (ADR 0197).
 *
 * `spec/connectors/browser-dispositions.json` holds a row for every provider
 * where OpenSesame can state something specific and back it: a documented
 * limit, a dated probe of the provider's own servers from the audited origin,
 * or a fact about this product. For every other provider without a connection
 * road, the statement is derived and says only what OpenSesame itself lacks —
 * never a claim about the provider that nothing supports.
 *
 * The one thing this module never produces is a catch-all: "this browser
 * cannot run that companion" for a provider whose API a browser can reach, or
 * "Desktop app required" for one that no desktop app would help.
 */
import { z } from "zod";
import { BROWSER_DISPOSITIONS_JSON } from "./browser-dispositions.generated.js";
import type { Provider } from "./connections.js";
import {
  canonicalProviderId,
  catalogProvenanceUrl,
} from "./connector-catalog.js";
import { isFnoxLink } from "./doc-link.js";
import { nativeCatalogConfigurationContract } from "./native-catalog-contract.js";

/** Why a browser has no road to a provider, as a closed set. */
export type BrowserUnavailableKind =
  /** This vault already does what the integration is for. */
  | "built-in"
  /** Reached only through a native client or process. */
  | "companion"
  /** The provider's own servers answer this origin without admitting it. */
  | "refuses-browser"
  /** The provider answers this origin; OpenSesame has not built the connection. */
  | "driver-pending"
  /** The compiled connection exists, but its owning feature is not active. */
  | "runtime-inactive"
  /** The provider answers this origin, but nothing the catalog names can prove a key. */
  | "no-key-check"
  /** OpenSesame has no browser contract for it, and nothing more is established. */
  | "no-contract"
  /** Refused by OpenSesame's own rules. */
  | "policy"
  /** OAuth needs a confidential client, whose secret a browser cannot hold. */
  | "needs-client-secret"
  /** The provider publishes no complete public browser authorization contract. */
  | "no-public-contract";

/** A short name for each reason, for a tile's tooltip and its accessible name. */
export const UNAVAILABLE_LABEL = {
  "built-in": "Built in",
  companion: "Desktop app required",
  "refuses-browser": "Provider blocks browsers",
  "driver-pending": "Not built yet",
  "runtime-inactive": "Connection not active",
  "no-key-check": "No way to check a key",
  "no-contract": "No browser connection",
  policy: "Not offered",
  "needs-client-secret": "Needs a client secret",
  "no-public-contract": "No public browser contract",
} as const satisfies Record<BrowserUnavailableKind, string>;

/** When a provider has several unavailable roads, the reason a person is told first. */
export const UNAVAILABLE_PRIORITY: readonly BrowserUnavailableKind[] = [
  "built-in",
  "companion",
  "refuses-browser",
  "needs-client-secret",
  "no-public-contract",
  "no-key-check",
  "runtime-inactive",
  "driver-pending",
  "no-contract",
  "policy",
];

/** The kind to tell about, among several. */
export function leadingUnavailableKind(
  kinds: readonly (BrowserUnavailableKind | undefined)[],
): BrowserUnavailableKind {
  const present = kinds.filter(
    (kind): kind is BrowserUnavailableKind => kind !== undefined,
  );
  return (
    UNAVAILABLE_PRIORITY.find((kind) => present.includes(kind)) ??
    present[0] ??
    "no-contract"
  );
}

export const AUTHORED_KINDS = [
  "built-in",
  "companion",
  "refuses-browser",
  "driver-pending",
  "no-key-check",
  "policy",
] as const satisfies readonly BrowserUnavailableKind[];

const linkSchema = z
  .object({ label: z.string().min(1), url: z.string().url() })
  .strict();

/** Where a person can go instead, inside this app. */
export const DISPOSITION_ROUTES = [
  "/vault?f=all",
  "/settings/security",
  "/settings/vaults",
] as const;
export type DispositionRoute = (typeof DISPOSITION_ROUTES)[number];

const dispositionSchema = z
  .object({
    provider_id: z.string().min(1),
    kind: z.enum(AUTHORED_KINDS),
    summary: z.string().min(1),
    sources: z.array(linkSchema),
    alternative: z
      .object({ label: z.string().min(1), to: z.enum(DISPOSITION_ROUTES) })
      .strict()
      .optional(),
  })
  .strict();

const sourceSchema = z
  .object({
    schema_version: z.literal(1),
    audited_origin: z.string().url(),
    checked_date: z.string(),
    dispositions: z.array(dispositionSchema),
  })
  .strict();

export type DispositionLink = z.infer<typeof linkSchema>;
export type AuthoredDisposition = z.infer<typeof dispositionSchema>;

export type BrowserDisposition = {
  kind: BrowserUnavailableKind;
  /** The honest statement a person reads. */
  summary: string;
  /** Pages that back the statement (documentation, never a stand-in for it). */
  sources: readonly DispositionLink[];
  alternative: { label: string; to: DispositionRoute } | null;
  /** True when a row was authored with evidence; false when the statement is derived. */
  authored: boolean;
};

let parsed: z.infer<typeof sourceSchema> | null = null;

/** The authored spec, validated the first time it is asked for. */
export function browserDispositionSpec() {
  parsed ??= sourceSchema.parse(JSON.parse(BROWSER_DISPOSITIONS_JSON));
  return parsed;
}

/** The origin every probe in the spec was made from. */
export function auditedOrigin(): string {
  return browserDispositionSpec().audited_origin;
}

/** Providers with an authored row, by id. */
export function authoredDispositionIds(): readonly string[] {
  return browserDispositionSpec().dispositions.map((row) => row.provider_id);
}

/** The authored row for a provider, by the id the app was asked for or its catalog id. */
export function authoredDisposition(
  providerId: string,
): AuthoredDisposition | undefined {
  return authored(providerId);
}

function authored(providerId: string): AuthoredDisposition | undefined {
  // The app keeps the alias it was asked for; the row is the catalog's.
  const id = canonicalProviderId(providerId) ?? providerId;
  return browserDispositionSpec().dispositions.find(
    (row) => row.provider_id === id,
  );
}

function authorities(provider: Provider): string {
  return provider.egress.authorities.length
    ? provider.egress.authorities.join(", ")
    : "an HTTPS API";
}

/**
 * What OpenSesame can truthfully say with no authored evidence: only what its
 * own catalog does and does not contain.
 */
function derivedSummary(provider: Provider): string {
  if (nativeCatalogConfigurationContract(provider))
    return `${provider.displayName} configuration is validated and sealed locally. No provider request or provider-access verification occurs.`;
  const lead = `OpenSesame has no browser connection for ${provider.displayName}.`;
  if (provider.category === "wallet")
    return `${provider.displayName} provisioning is unavailable under this product's wallet connection policy. This browser has no wallet driver and does not collect signing or issuer credentials.`;
  if (provider.modelApi && !provider.modelApi.baseUrl)
    return `${lead} Where its models are served depends on your account, so the catalog has no address to call.`;
  if (provider.egress.scheme === "none") {
    const provenance = catalogProvenanceUrl(provider.id);
    return provenance && isFnoxLink(provenance)
      ? `${lead} Its catalog entry is configuration for fnox's ${provider.id} provider and names no HTTPS API a browser could call.`
      : `${lead} Its catalog entry names no HTTPS API a browser could call.`;
  }
  return `${lead} Its catalog entry names ${authorities(provider)} but defines no key check or verified operation for a browser to run, and no probe of that service from this site has been recorded.`;
}

/**
 * The disposition of a provider that has no browser connection road. Callers
 * resolve the road first; this answers only "why not".
 */
export function browserDisposition(provider: Provider): BrowserDisposition {
  const row = authored(provider.id);
  if (row)
    return {
      kind: row.kind,
      summary: row.summary,
      sources: row.sources,
      alternative: row.alternative ?? null,
      authored: true,
    };
  return {
    kind: nativeCatalogConfigurationContract(provider)
      ? "built-in"
      : provider.category === "wallet"
        ? "policy"
        : "no-contract",
    summary: derivedSummary(provider),
    sources: [],
    alternative: null,
    authored: false,
  };
}
