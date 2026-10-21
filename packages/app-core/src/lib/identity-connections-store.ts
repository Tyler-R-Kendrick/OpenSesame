/** Saved adapter configuration shares the atomic, device-sealed connector ledger. */
import type { Connection } from "./connections.js";
import {
  DEVICE_CONNECTOR_KEYS,
  readDeviceRows,
  readDeviceSecrets,
  removeDeviceConfigurationDurable,
  updateDeviceConfigurationDurable,
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
const REVISION = "identity_configuration_revision";

/** Public lifecycle marker only: editing even identical bytes retires an initiating configuration. */
export function identityConnectionRevision(
  connectionId: string,
): string | null {
  const row = readDeviceRows().find(
    (entry) => entry.connectionId === connectionId,
  );
  return row?.fields[REVISION] ?? row?.updatedAt ?? null;
}

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
    "oidcClientType",
    "oidcOrganizationParameter",
    "oidcOrganizationClaim",
    "samlEntityId",
    "samlMetadataUrl",
    "samlSigningCertificate",
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
/** A preparation receipt identifies this write; it grants no provider or vault authority. */
export type IdentityConnectionPublication = Readonly<{
  revision: string;
  providerId: string;
  configuration: string;
}>;
function configurationInput(current: IdentityConnectionDraft) {
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
      [REVISION]: Array.from(
        crypto.getRandomValues(new Uint8Array(24)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join(""),
      self_hosted_configuration: "identity-v1",
    },
    secrets,
  };
}
export function writeIdentityConnection(
  draft: IdentityConnectionDraft,
  existingId?: string,
  beforeCommit?: () => void,
  prepared?: (publication: IdentityConnectionPublication) => void,
): Promise<Connection> {
  return saveDeviceConnectorConfigurationDurable(
    () => {
      beforeCommit?.();
      const current = resolveIdentityConnectionSecrets(draft, existingId);
      if (existingId && !readIdentityConnection(existingId))
        throw new Error("Saved identity connection not found");
      const input = configurationInput(current);
      prepared?.(
        Object.freeze({
          revision: input.fields[REVISION],
          providerId: input.providerId,
          configuration: input.fields[FIELD],
        }),
      );
      return input;
    },
    existingId,
    beforeCommit,
  );
}
function matchesPublication(
  row: ReturnType<typeof readDeviceRows>[number],
  publication: IdentityConnectionPublication,
): boolean {
  return (
    row.providerId === publication.providerId &&
    row.fields[REVISION] === publication.revision &&
    row.fields[FIELD] === publication.configuration
  );
}
export function assertIdentityConnectionPublication(
  id: string,
  publication: IdentityConnectionPublication,
): void {
  const row = readDeviceRows().find((row) => row.connectionId === id);
  if (!row || !matchesPublication(row, publication))
    throw new Error("Original saved identity publication changed");
}
/** Existing atomic record/Web Lock owns both the comparison and any replacement. */
export async function compensateIdentityConnectionPublication(
  id: string | undefined,
  publication: IdentityConnectionPublication,
  previous: IdentityConnectionDraft | null,
  retireTrust: (id: string) => Promise<void>,
): Promise<void> {
  const selected =
    id ??
    readDeviceRows().find((row) => matchesPublication(row, publication))
      ?.connectionId;
  if (!selected) return;
  let owned = false;
  const superseded = new Error("Identity publication was superseded");
  try {
    await updateDeviceConfigurationDurable(
      selected,
      async (record) => {
        if (!matchesPublication(record.row, publication)) return record;
        owned = true;
        await retireTrust(selected);
        assertIdentityConnectionPublication(selected, publication);
        if (!previous) return record;
        const input = configurationInput(previous); // Restoration receives a fresh revision; old attempts never revive.
        return {
          row: {
            ...record.row,
            displayName: input.displayName,
            scopes: input.scopes,
            fields: input.fields,
            updatedAt: new Date().toISOString(),
          },
          secrets: input.secrets,
        };
      },
      () => assertIdentityConnectionPublication(selected, publication),
    );
    if (owned && !previous)
      await removeDeviceConfigurationDurable(
        selected,
        (record) => {
          if (!matchesPublication(record.row, publication)) throw superseded;
        },
        () => assertIdentityConnectionPublication(selected, publication),
      );
  } catch (error) {
    if (error !== superseded) throw error;
  }
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
  if (!current || JSON.stringify(current) !== JSON.stringify(expected))
    throw new Error(
      "Identity configuration changed during sign-in; start again",
    );
}
