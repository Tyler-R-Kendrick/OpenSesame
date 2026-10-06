/** Deliberate real-owner recovery of selected, formerly unbound device credentials. */
import { z } from "zod";
import { assertNotDecoySession } from "./decoy-session.js";
import {
  LEGACY_CONNECTOR_PUBLIC_KEY as PUBLIC_KEY,
  LEGACY_CONNECTOR_SECRET_KEY as SECRET_KEY,
  hasUnresolvedLegacyConnectorSecrets,
  legacyConnectorRowSchema,
  legacyConnectorSecretsSchema,
} from "./device-connector-legacy-storage.js";
import { withDeviceConnectorMetadata } from "./device-connector-lock.js";
import {
  activeDeviceConnectorPrincipal,
  assertDeviceConnectorPrincipal,
  requireDeviceConnectorPrincipal,
} from "./device-connector-principal.js";
import {
  type PublicRow,
  readDeviceRows,
  readDeviceSecrets,
  writeDeviceRows,
  writeDeviceSecrets,
} from "./device-connector-records.js";
import { kvFlush, kvGet, kvRefresh, kvSetDurable } from "./kv.js";
import { exclusive } from "./retired-credentials/credential-lock.js";
import {
  authenticateRetiredCredentialOwner,
  retiredCredentialEnrollmentSupported,
} from "./retired-credentials/owner-auth.js";
import { authenticationHeaderWitness } from "./vault/store-auth-header.js";
import { readTombHeader } from "./vault/store-header.js";
const inputSchema = z
  .object({
    tomb: z.string().min(1),
    currentPassword: z.string().min(1).max(1024),
    connectionIds: z.array(z.string().min(1).max(256)).min(1).max(16),
    decision: z.enum(["import", "discard"]),
    acknowledgeOwnershipAmbiguity: z.literal(true),
  })
  .strict();
function records() {
  const rows = z
    .array(legacyConnectorRowSchema)
    .max(512)
    .parse(JSON.parse(kvGet(PUBLIC_KEY) ?? "[]"));
  const secrets = legacyConnectorSecretsSchema.parse(
    JSON.parse(kvGet(SECRET_KEY) ?? "{}"),
  );
  return { rows, secrets };
}
export function legacyDeviceConnectorStatus() {
  const principal = activeDeviceConnectorPrincipal();
  const pending = hasUnresolvedLegacyConnectorSecrets();
  const available =
    principal?.kind === "member" &&
    retiredCredentialEnrollmentSupported(principal.tomb);
  if (!available) return { pending, available: false, records: [] };
  if (!pending) return { pending: false, available: true, records: [] };
  try {
    const data = records();
    return {
      pending,
      available: true,
      records: Object.keys(data.secrets)
        .filter((id) => Object.keys(data.secrets[id] ?? {}).length > 0)
        .map((connectionId) => {
          const row = data.rows.find(
            (entry) => !entry.owner && entry.connectionId === connectionId,
          );
          return {
            connectionId,
            providerId: row?.providerId ?? "unbound",
            displayName: row?.displayName ?? "Unidentified legacy connector",
          };
        }),
    };
  } catch {
    return { pending: true, available: false, records: [] };
  }
}
/** Review reads disk, so another process cannot hide pending device-key records. */
export function refreshLegacyDeviceConnectorStatus(tomb: string) {
  const principal = requireDeviceConnectorPrincipal();
  if (principal.kind !== "member" || principal.tomb !== tomb)
    throw new Error(
      "Unlock the original member vault to review legacy connectors.",
    );
  return exclusive(async () => {
    try {
      await Promise.all([
        kvRefresh(PUBLIC_KEY, 262144),
        kvRefresh(SECRET_KEY, 262144),
      ]);
    } catch {
      assertDeviceConnectorPrincipal(principal);
      return { pending: true, available: false, records: [] };
    }
    assertDeviceConnectorPrincipal(principal);
    return legacyDeviceConnectorStatus();
  });
}

export type LegacyDeviceConnectorResolution = z.infer<typeof inputSchema>;
type LegacyConnectorOwnerProof = Pick<
  LegacyDeviceConnectorResolution,
  "tomb" | "currentPassword"
>;
function withLegacyOwner<T>(
  input: LegacyConnectorOwnerProof,
  work: (
    check: () => void,
    principal: ReturnType<typeof requireDeviceConnectorPrincipal>,
  ) => Promise<T>,
): Promise<T> {
  const principal = requireDeviceConnectorPrincipal();
  if (principal.kind !== "member" || principal.tomb !== input.tomb)
    throw new Error(
      "Authenticate the original member vault to resolve legacy connectors.",
    );
  const generation = assertNotDecoySession();
  return exclusive(async () => {
    await authenticateRetiredCredentialOwner(input.tomb, input.currentPassword);
    assertDeviceConnectorPrincipal(principal);
    const witness = authenticationHeaderWitness(readTombHeader(input.tomb));
    const check = () => {
      assertNotDecoySession(generation);
      assertDeviceConnectorPrincipal(principal);
      if (authenticationHeaderWitness(readTombHeader(input.tomb)) !== witness)
        throw new Error("Vault authentication changed during legacy recovery.");
    };
    check();
    const result = await work(check, principal);
    check();
    return result;
  });
}

function metadata(row: z.infer<typeof legacyConnectorRowSchema>): string {
  const { owner: _owner, secretItemId: _secret, ...value } = row;
  return JSON.stringify(value);
}

async function importLegacy(
  connectionId: string,
  original: ReturnType<typeof records>,
  check: () => void,
  principal: ReturnType<typeof requireDeviceConnectorPrincipal>,
): Promise<void> {
  const owned = readDeviceRows().find(
    (entry) => entry.connectionId === connectionId,
  );
  const row = original.rows.find(
    (entry) => !entry.owner && entry.connectionId === connectionId,
  );
  const fields = original.secrets[connectionId] ?? {};
  if (!row) {
    if (
      owned &&
      JSON.stringify(readDeviceSecrets()[connectionId]) ===
        JSON.stringify(fields)
    )
      return;
    throw new Error(
      "This legacy credential has no recoverable configuration; choose discard.",
    );
  }
  if (
    original.rows.some(
      (entry) =>
        entry.owner &&
        entry.owner !== principal.id &&
        entry.connectionId === connectionId,
    )
  )
    throw new Error("This legacy connector conflicts with an owned record.");
  if (
    owned &&
    (metadata(owned) !== metadata(row) ||
      (owned.secretItemId &&
        JSON.stringify(readDeviceSecrets()[connectionId]) !==
          JSON.stringify(fields)))
  )
    throw new Error("This legacy connector conflicts with an owned record.");
  if (!owned) {
    const imported: PublicRow = {
      connectionId: row.connectionId,
      providerId: row.providerId,
      displayName: row.displayName,
      scopes: row.scopes,
      fields: row.fields,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      owner: principal.id,
    };
    await writeDeviceRows([...readDeviceRows(), imported]);
    check();
  }
  check();
  await writeDeviceSecrets({ [connectionId]: fields });
  check();
  await kvFlush();
  check();
}

export function resolveLegacyDeviceConnectors(
  input: LegacyDeviceConnectorResolution,
): Promise<void> {
  const parsed = inputSchema.parse(input);
  return withLegacyOwner(parsed, async (check, principal) => {
    await Promise.all([
      kvRefresh(PUBLIC_KEY, 262144),
      kvRefresh(SECRET_KEY, 262144),
    ]);
    check();
    const original = records();
    const selected = new Set(parsed.connectionIds);
    if (selected.size !== parsed.connectionIds.length)
      throw new Error("Select each legacy connector once.");
    for (const connectionId of selected) {
      const fields = original.secrets[connectionId];
      if (!fields || Object.keys(fields).length === 0)
        throw new Error("A selected legacy connector is unavailable.");
      check();
      if (parsed.decision === "import")
        await importLegacy(connectionId, original, check, principal);
      check();
      const current = await withDeviceConnectorMetadata(async () => {
        await kvRefresh(SECRET_KEY, 262144);
        check();
        const latest = records();
        if (
          JSON.stringify(latest.secrets[connectionId]) !==
          JSON.stringify(original.secrets[connectionId])
        )
          throw new Error("Legacy credentials changed during recovery.");
        const remaining = latest.rows.filter(
          (entry) => entry.owner || entry.connectionId !== connectionId,
        );
        check();
        await kvSetDurable(PUBLIC_KEY, JSON.stringify(remaining));
        check();
        return latest;
      });
      check();
      delete current.secrets[connectionId];
      await kvSetDurable(SECRET_KEY, JSON.stringify(current.secrets));
      check();
    }
  });
}

const discardSchema = z
  .object({
    tomb: z.string().min(1),
    currentPassword: z.string().min(1).max(1024),
    acknowledgeIrrecoverableLegacyDiscard: z.literal(true),
  })
  .strict();
/** Explicit recovery also handles unreadable/oversized legacy secret maps; owned records are untouched. */
export function discardIrrecoverableLegacyConnectorSecrets(
  input: z.infer<typeof discardSchema>,
): Promise<void> {
  const parsed = discardSchema.parse(input);
  return withLegacyOwner(parsed, async (check) => {
    check();
    await kvSetDurable(SECRET_KEY, "{}");
    check();
  });
}
