import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { canonicalize } from "@opensesame/os-domain";
import type { Provider } from "./connections.js";
import { catalogProvider } from "./connector-catalog.js";
import { validateNativeCatalogValues } from "./native-catalog-configuration-validation.js";
import {
  type NativeCatalogConfiguration,
  nativeCatalogConfigurationContract,
} from "./native-catalog-contract.js";
import type {
  NativeDriverInput,
  NativeDriverResult,
} from "./native-connector-drivers.js";
import type { NativeProviderCleanup } from "./native-connector-lifecycle.js";
import {
  type NativeConfiguration,
  type NativeFieldClassification,
  emptyNativePrivate,
} from "./native-connector-schema.js";
import {
  type NativeConnectorRecord,
  assertNativeConnectorRevision,
  loadNativeConnectorRecord,
  saveNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import {
  type NativeProviderTransport,
  nativeProviderTransport,
} from "./native-connector-transport.js";
import { nativeConnectorView } from "./native-connector-view.js";

export type { NativeCatalogConfiguration } from "./native-catalog-contract.js";

export function nativeCatalogConfiguration(
  providerId: string,
): NativeCatalogConfiguration | null {
  const provider = catalogProvider(providerId);
  return provider ? nativeCatalogConfigurationContract(provider) : null;
}

function requiredConfiguration(providerId: string): NativeCatalogConfiguration {
  const configuration = nativeCatalogConfiguration(providerId);
  if (!configuration)
    throw new Error("This provider has no local configuration contract");
  return configuration;
}

function guard(record: NativeConnectorRecord) {
  return {
    revision: record.revision,
    fingerprint: record.configuration.fingerprint,
  };
}

function requireSaved(
  providerId: string,
  connectionId: string,
): NativeConnectorRecord {
  requiredConfiguration(providerId);
  const record = loadNativeConnectorRecord(connectionId);
  if (
    !record ||
    record.configuration.providerId !== providerId ||
    record.configuration.method !== "native-local"
  )
    throw new Error("Saved local provider configuration not found");
  return record;
}

function fingerprint(
  providerId: string,
  parameters: Record<string, string>,
): string {
  return bytesToHex(
    sha256(new TextEncoder().encode(canonicalize({ providerId, parameters }))),
  );
}

type CatalogField = NonNullable<Provider["configurationFields"]>[number];

function secretValue(
  field: CatalogField,
  input: NativeDriverInput,
  saved: NativeConnectorRecord | null,
): string {
  if (input.parameters[field.name] !== undefined)
    throw new Error(`${field.label} must remain sealed`);
  const privateValue = input.credentials[field.name];
  const retained = saved?.privateState.credentials[field.name];
  const value = privateValue?.trim() ? privateValue : (retained ?? "");
  if (field.required && !value.trim())
    throw new Error(`Enter ${field.label.toLowerCase()}`);
  return value;
}

function publicValue(field: CatalogField, input: NativeDriverInput): string {
  if (input.credentials[field.name] !== undefined)
    throw new Error(`${field.label} is not a secret field`);
  const value = input.parameters[field.name]?.trim() ?? "";
  if (field.required && !value)
    throw new Error(`Enter ${field.label.toLowerCase()}`);
  return value;
}

function validatedValue(
  field: CatalogField,
  input: NativeDriverInput,
  saved: NativeConnectorRecord | null,
) {
  const suppliedPublic = input.parameters[field.name];
  const suppliedPrivate = input.credentials[field.name];
  if (suppliedPublic !== undefined && suppliedPrivate !== undefined)
    throw new Error(`${field.label} was supplied in the wrong field`);
  return field.secret
    ? { secret: true, value: secretValue(field, input, saved) }
    : { secret: false, value: publicValue(field, input) };
}

function validatedValues(
  contract: NativeCatalogConfiguration,
  input: NativeDriverInput,
  saved: NativeConnectorRecord | null,
) {
  if (
    input.method !== "native-local" ||
    Object.keys(input.requestedScopes).length > 0 ||
    Object.keys(input.targetIds).length > 0
  )
    throw new Error("Select only this provider's local configuration fields");
  const parameters: Record<string, string> = {};
  const credentials: Record<string, string> = {};
  const supplied = new Set([
    ...Object.keys(input.parameters),
    ...Object.keys(input.credentials),
  ]);
  for (const field of contract.provider.configurationFields ?? []) {
    const { secret, value } = validatedValue(field, input, saved);
    if (value) {
      if (secret) credentials[field.name] = value;
      else parameters[field.name] = value;
    }
    supplied.delete(field.name);
  }
  if (supplied.size > 0)
    throw new Error(
      "This provider received an unsupported configuration field",
    );
  if (!input.displayName.trim() || input.displayName.trim().length > 256)
    throw new Error("Enter a valid connection name");
  return { parameters, credentials };
}

function verifiedRecord(
  input: NativeDriverInput,
  saved: NativeConnectorRecord | null,
  parameters: Record<string, string>,
  credentials: Record<string, string>,
): Omit<NativeConnectorRecord, "revision"> {
  const verifiedAt = Math.max(Date.now(), (saved?.runtime.verifiedAt ?? 0) + 1);
  const configuration: NativeConfiguration = {
    version: 1,
    providerId: input.providerId,
    method: "native-local",
    displayName: input.displayName.trim(),
    icon: input.icon ?? "",
    parameters,
    requestedScopes: {},
    targetIds: {},
    fingerprint: fingerprint(input.providerId, parameters),
  };
  const privateState = emptyNativePrivate();
  privateState.credentials = credentials;
  privateState.verification = {
    fingerprint: configuration.fingerprint,
    verifiedAt,
    kind: "configuration",
  };
  return {
    connectionId: saved?.connectionId ?? `native-local-${crypto.randomUUID()}`,
    configuration,
    privateState,
    runtime: {
      verifiedAt,
      identity: {
        id: `configuration-${configuration.fingerprint.slice(0, 16)}`,
        label: "Locally validated configuration",
        kind: "configuration",
        assurance: "credential-valid",
      },
      targets: [],
      grants: [],
    },
  };
}

export async function configureNativeCatalogConfiguration(
  input: NativeDriverInput,
  transport: NativeProviderTransport = nativeProviderTransport(),
) {
  transport.assertCurrent();
  const contract = requiredConfiguration(input.providerId);
  const saved = input.connectionId
    ? requireSaved(input.providerId, input.connectionId)
    : null;
  if (saved && saved.revision !== input.revision)
    throw new Error("Local configuration changed; reload before saving");
  const { parameters, credentials } = validatedValues(contract, input, saved);
  await validateNativeCatalogValues(contract, input, parameters, credentials);
  const next = verifiedRecord(input, saved, parameters, credentials);
  if (!saved)
    return saveNativeConnector(next, contract.classification, () =>
      transport.assertCurrent(),
    );
  await assertNativeConnectorRevision(saved.connectionId, guard(saved));
  return updateNativeConnector(
    saved.connectionId,
    guard(saved),
    contract.classification,
    () => {
      transport.assertCurrent();
      return { ...next, revision: saved.revision };
    },
    () => transport.assertCurrent(),
  );
}

function assertSavedBinding(record: NativeConnectorRecord): void {
  const {
    providerId,
    parameters,
    fingerprint: expected,
  } = record.configuration;
  if (fingerprint(providerId, parameters) !== expected)
    throw new Error("Local configuration binding changed; configure again");
}

async function validatedSavedValues(
  contract: NativeCatalogConfiguration,
  saved: NativeConnectorRecord,
) {
  const input: NativeDriverInput = {
    providerId: saved.configuration.providerId,
    connectionId: saved.connectionId,
    revision: saved.revision,
    displayName: saved.configuration.displayName,
    icon: saved.configuration.icon,
    method: "native-local",
    parameters: saved.configuration.parameters,
    credentials: saved.privateState.credentials,
    requestedScopes: {},
    targetIds: {},
  };
  const values = validatedValues(contract, input, saved);
  await validateNativeCatalogValues(
    contract,
    input,
    values.parameters,
    values.credentials,
  );
  return { input, ...values };
}

export async function verifyNativeCatalogConfiguration(
  connectionId: string,
  transport: NativeProviderTransport = nativeProviderTransport(),
) {
  transport.assertCurrent();
  const saved = requireSaved(
    loadNativeConnectorRecord(connectionId)?.configuration.providerId ?? "",
    connectionId,
  );
  const contract = requiredConfiguration(saved.configuration.providerId);
  assertSavedBinding(saved);
  await assertNativeConnectorRevision(connectionId, guard(saved));
  const { input, parameters, credentials } = await validatedSavedValues(
    contract,
    saved,
  );
  const next = verifiedRecord(input, saved, parameters, credentials);
  return updateNativeConnector(
    connectionId,
    guard(saved),
    contract.classification,
    () => {
      transport.assertCurrent();
      assertSavedBinding(saved);
      return { ...next, revision: saved.revision };
    },
    () => transport.assertCurrent(),
  );
}

export async function readNativeCatalogConfiguration(
  connectionId: string,
  input: Record<string, string>,
  transport: NativeProviderTransport = nativeProviderTransport(),
): Promise<NativeDriverResult> {
  transport.assertCurrent();
  if (Object.keys(input).length > 0)
    throw new Error("Local configuration review accepts no input");
  const saved = loadNativeConnectorRecord(connectionId);
  if (!saved) throw new Error("Saved local provider configuration not found");
  const contract = requiredConfiguration(saved.configuration.providerId);
  const owned = requireSaved(saved.configuration.providerId, connectionId);
  assertSavedBinding(owned);
  await validatedSavedValues(contract, owned);
  const view = nativeConnectorView(
    owned.connectionId,
    owned.revision,
    owned.configuration,
    owned.runtime,
    owned.privateState,
  );
  if (view.status !== "connected")
    throw new Error("Verify this local configuration before reviewing it");
  await assertNativeConnectorRevision(connectionId, guard(owned));
  transport.assertCurrent();
  return {
    label: `${contract.provider.displayName} local configuration`,
    items: [
      {
        id: "status",
        label:
          "Configuration verified locally; provider access was not checked",
      },
      ...Object.entries(owned.configuration.parameters).map(([id, value]) => ({
        id,
        label: `${contract.provider.configurationFields?.find((field) => field.name === id)?.label ?? id}: ${value}`,
      })),
    ],
  };
}

export function nativeCatalogConfigurationCleanup(
  configuration: NativeConfiguration,
): NativeFieldClassification {
  if (configuration.method !== "native-local")
    throw new Error("Local configuration cleanup belongs to another method");
  return requiredConfiguration(configuration.providerId).classification;
}

export const nativeCatalogConfigurationCleanupAdapter: NativeProviderCleanup = {
  classification: nativeCatalogConfigurationCleanup,
  credentialSlots: (configuration) =>
    nativeCatalogConfigurationCleanup(configuration).privateCredentials,
  cleanup: async (obligation, context) => {
    requiredConfiguration(context.configuration.providerId);
    if (
      context.configuration.method !== "native-local" ||
      obligation.kind !== "revoke" ||
      obligation.providerId !== context.configuration.providerId ||
      obligation.fingerprint !== context.configuration.fingerprint ||
      obligation.grant?.kind !== "native-local" ||
      obligation.grant.providerId !== obligation.providerId ||
      obligation.grant.fingerprint !== obligation.fingerprint ||
      obligation.grant.actor !== obligation.actor
    )
      throw new Error(
        "Local configuration cleanup changed; reload before removal",
      );
    return "local-credential-forgotten";
  },
};
