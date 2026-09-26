import {
  type BoundaryValue,
  isBoolean,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import {
  BUNDLED_CATALOG_IDS,
  isDeviceKeyProtector,
} from "./bundled-provider-ids.js";
import type { Provider } from "./connections.js";
import { CATALOG_REVISION, catalogProvider } from "./connector-catalog.js";
import { FIELDS } from "./embedded-catalog-data.js";
import { bundledGitProvider } from "./embedded-git.js";

/** A cached catalog from another revision is discarded, never merged. */
export const BUNDLED_REVISION = CATALOG_REVISION;

const AUTO_CONFIGURABLE = new Set(["plain", "sealed-local", "webcrypto"]);

/**
 * The catalog row for `id`, as this app shows it before a Host answers. The
 * row's data is the catalog's; the app keeps the id it asked for (an alias
 * such as `aws-secrets-manager` stays the id stored connections use), whether
 * the row is ready without setup, and its own field labels.
 */
function bundled(id: string, configured = false): Provider {
  const provider = catalogProvider(id);
  if (!provider) {
    throw new Error(`${id} is not a row of spec/connectors/catalog.json`);
  }
  provider.id = id;
  provider.configured = configured || AUTO_CONFIGURABLE.has(id);
  provider.autoConfigurable = AUTO_CONFIGURABLE.has(id);
  provider.configurationFields = FIELDS.get(id) ?? provider.configurationFields;
  return provider;
}

export const bundledProviders: Provider[] = BUNDLED_CATALOG_IDS.map((id) =>
  bundled(id, isDeviceKeyProtector(id)),
);

function validProvider(value: BoundaryValue): value is Provider {
  if (!isJsonObject(value)) return false;
  const item = value;
  return (
    isString(item.id) &&
    isString(item.displayName) &&
    isString(item.category) &&
    isString(item.docsUrl) &&
    isString(item.authKind) &&
    isBoolean(item.configured) &&
    isBoolean(item.autoConfigurable) &&
    Array.isArray(item.missingConfig) &&
    Array.isArray(item.scopes) &&
    Array.isArray(item.operations)
  );
}

export function decodeEmbeddedProviders(value: string): Provider[] | null {
  let parsed: BoundaryValue;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (
    !isJsonObject(parsed) ||
    parsed.revision !== BUNDLED_REVISION ||
    !Array.isArray(parsed.providers)
  ) {
    return null;
  }
  const providers = parsed.providers;
  return providers.length > 0 && providers.every(validProvider)
    ? providers
    : null;
}

async function readEmbeddedProvidersDefault(): Promise<Provider[]> {
  return getBundledProviders();
}

async function writeEmbeddedProvidersDefault(
  _providers: Provider[],
): Promise<void> {}

export const embeddedCatalogSeams = {
  bundledProviders,
  readEmbeddedProviders: readEmbeddedProvidersDefault,
  writeEmbeddedProviders: writeEmbeddedProvidersDefault,
};

export function getBundledProviders(): Provider[] {
  return [bundledGitProvider(), ...embeddedCatalogSeams.bundledProviders];
}

export async function readEmbeddedProviders(): Promise<Provider[]> {
  return embeddedCatalogSeams.readEmbeddedProviders();
}

export async function writeEmbeddedProviders(
  providers: Provider[],
): Promise<void> {
  return embeddedCatalogSeams.writeEmbeddedProviders(providers);
}
