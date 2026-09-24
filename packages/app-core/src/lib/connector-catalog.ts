/**
 * The one integration catalog, as every target sees it.
 *
 * `spec/connectors/catalog.json` is the only list of integrations; the Host
 * API projects each row into a provider view (`GET /api/v1/providers`), and
 * `connector-catalog.generated.ts` embeds exactly those views for the client
 * plane. So a provider's name, category, auth kind, scopes, egress and fields
 * are identical in the native binary and here, and nothing in this package
 * re-derives them. Resolve a provider through this module; do not keep a
 * second list (ADR 0139).
 */
import { ProviderSchema } from "@opensesame/contracts";
import type { BoundaryValue } from "@opensesame/os-domain";
import type { Provider } from "./connections.js";
import {
  CATALOG_ALIASES,
  CATALOG_REVISION,
  CATALOG_ROW_JSON,
} from "./connector-catalog.generated.js";

export { CATALOG_REVISION };

/** A provider view as the Host API serves it, mapped to the app's shape. */
export function providerFromView(value: BoundaryValue): Provider {
  const raw = ProviderSchema.parse(value);
  return {
    id: raw.id,
    displayName: raw.display_name,
    category: raw.category,
    docsUrl: raw.docs_url,
    authKind: raw.auth_kind,
    supportsRefresh: raw.supports_refresh,
    configured: raw.configured,
    autoConfigurable: raw.auto_configurable,
    missingConfig: raw.missing_config,
    callbackUrl: raw.callback_url,
    scopes: raw.scopes,
    egress: {
      scheme: raw.egress.scheme,
      authorities: raw.egress.authorities,
      pathPrefixes: raw.egress.path_prefixes,
    },
    operations: raw.operations,
    configurationFields: raw.connection_configuration_fields.map((field) => ({
      ...field,
      label: field.name
        .replaceAll("_", " ")
        .replace(/^./, (letter) => letter.toUpperCase()),
    })),
  };
}

let rows: readonly Provider[] | null = null;

/** Every catalog row, in catalog order. */
export function catalogProviders(): readonly Provider[] {
  rows ??= CATALOG_ROW_JSON.map((json) => providerFromView(JSON.parse(json)));
  return rows;
}

/** The catalog id an id or alias names, or `undefined` for neither. */
export function canonicalProviderId(idOrAlias: string): string | undefined {
  const id = CATALOG_ALIASES[idOrAlias] ?? idOrAlias;
  return catalogProviders().some((provider) => provider.id === id)
    ? id
    : undefined;
}

/**
 * A fresh copy of the row an id or alias names. Callers may adjust their copy
 * (a device's `configured` flag, labelled fields) without touching the
 * catalog.
 */
export function catalogProvider(idOrAlias: string): Provider | undefined {
  const id = canonicalProviderId(idOrAlias);
  const row = catalogProviders().find((provider) => provider.id === id);
  return row ? structuredClone(row) : undefined;
}
