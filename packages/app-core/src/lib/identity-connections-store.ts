/** Saved adapter configuration shares the atomic, device-sealed connector ledger. */
import type { Connection } from "./connections.js";
import {
  DEVICE_CONNECTOR_KEYS,
  readDeviceRows,
  readDeviceSecrets,
  removeDeviceConfigurationDurable,
} from "./device-connector-records.js";
import { deviceConnectorView } from "./device-connector-view.js";
import { saveDeviceConnectorConfigurationDurable } from "./device-connectors.js";
import {
  IDENTITY_SECRET_FIELDS,
  type IdentityConnectionDraft,
  IdentityConnectionDraftSchema,
  publicIdentityDraft,
} from "./identity-connections-schema.js";
import { kvHydrate } from "./kv.js";
const FIELD = "identity_configuration";

/** Safe for an edit form: private write-only fields are always blank. */
export function readIdentityConnection(
  connectionId: string,
): IdentityConnectionDraft | null {
  const row = readDeviceRows().find(
    (entry) => entry.connectionId === connectionId,
  );
  const raw = row?.fields[FIELD];
  if (!raw) return null;
  try {
    const parsed = IdentityConnectionDraftSchema.parse(JSON.parse(raw));
    return parsed.providerId === row?.providerId
      ? publicIdentityDraft(parsed)
      : null;
  } catch {
    return null;
  }
}
export function listIdentityConnections(): Connection[] {
  return readDeviceRows()
    .filter((row) => readIdentityConnection(row.connectionId))
    .map(deviceConnectorView);
}

/** Adapter coordinator only: credentials may be spent only at this configured target. */
export function getIdentityConnectionRuntime(
  connectionId: string,
): IdentityConnectionDraft | null {
  const draft = readIdentityConnection(connectionId);
  if (!draft) return null;
  const secrets = readDeviceSecrets()[connectionId] ?? {};
  for (const field of IDENTITY_SECRET_FIELDS)
    draft[field] = secrets[field] ?? "";
  return draft;
}
function sameTarget(
  a: IdentityConnectionDraft,
  b: IdentityConnectionDraft,
): boolean {
  const targetFields = [
    "providerId",
    "protocol",
    "issuer",
    "clientId",
    "baseUrl",
    "brokerUrl",
    "organizationId",
    "samlEntityId",
    "ldapUrl",
    "ldapBindDn",
  ] as const;
  return targetFields.every((key) => a[key] === b[key]);
}
/** Empty write-only fields keep secrets only when the credential target is unchanged. */
export function resolveIdentityConnectionSecrets(
  draft: IdentityConnectionDraft,
  existingId?: string,
): IdentityConnectionDraft {
  const previous = existingId ? getIdentityConnectionRuntime(existingId) : null;
  if (!previous || !sameTarget(previous, draft)) return { ...draft };
  const merged = { ...draft };
  for (const field of IDENTITY_SECRET_FIELDS)
    if (!merged[field]) merged[field] = previous[field];
  return merged;
}
export function writeIdentityConnection(
  draft: IdentityConnectionDraft,
  existingId?: string,
): Promise<Connection> {
  return saveDeviceConnectorConfigurationDurable(() => {
    const current = resolveIdentityConnectionSecrets(draft, existingId);
    if (existingId && !readIdentityConnection(existingId))
      throw new Error("Saved identity connection not found");
    const secrets: Record<string, string> = {};
    for (const field of IDENTITY_SECRET_FIELDS)
      if (current[field]) secrets[field] = current[field];
    return {
      providerId: current.providerId,
      displayName: current.name,
      scopes:
        current.protocol === "oidc"
          ? current.scope.split(/\s+/).filter(Boolean)
          : [],
      fields: {
        [FIELD]: JSON.stringify(publicIdentityDraft(current)),
        self_hosted_configuration: "identity-v1",
      },
      secrets,
    };
  }, existingId);
}
export function deleteIdentityConnection(
  connectionId: string,
): Promise<boolean> {
  return removeDeviceConfigurationDurable(connectionId, () => {
    if (!readIdentityConnection(connectionId))
      throw new Error("Saved identity connection not found");
  });
}

/** An explicit cold-load sign-in can use its sealed adapter before optional connector UI activates. */
export async function hydrateIdentityConnections(): Promise<void> {
  await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
}

/** An awaited provider response cannot authenticate a connection edited while it was in flight. */
export async function assertIdentityConnectionUnchanged(
  connectionId: string,
  expected: IdentityConnectionDraft,
): Promise<void> {
  await hydrateIdentityConnections();
  const current = getIdentityConnectionRuntime(connectionId);
  if (
    !current ||
    JSON.stringify(publicIdentityDraft(current)) !==
      JSON.stringify(publicIdentityDraft(expected))
  )
    throw new Error(
      "Identity configuration changed during sign-in; start again",
    );
}
