/**
 * The two device records a saved connector uses: public rows, and the
 * secret map that never rides on the connection the page renders.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { createItem } from "@opensesame/vault-core";
import { assertNotDecoySession } from "./decoy-session.js";
import { withDeviceConnectorMetadata } from "./device-connector-lock.js";
import { onDeviceConnectorPrincipalTransfer } from "./device-connector-principal-state.js";
import {
  activeDeviceConnectorPrincipal,
  assertDeviceConnectorPrincipal,
  requireDeviceConnectorPrincipal,
} from "./device-connector-principal.js";
import { kvFlush, kvGet, kvSetDurable } from "./kv.js";
import { vaultStore } from "./vault/store.js";

const PUBLIC_KEY = "opensesame.device-connectors.v1";

export interface StringFields {
  [key: string]: string;
}

export interface PublicRow {
  connectionId: string;
  owner?: string;
  secretItemId?: string;
  providerId: string;
  displayName: string;
  scopes: string[];
  fields: StringFields;
  createdAt: string;
  updatedAt: string;
}

interface SecretStore {
  [key: string]: StringFields;
}

export function clearDeviceConnectorStore(): Promise<void> {
  return removeDeviceConnectorRecords(
    readDeviceRows().map((row) => row.connectionId),
  );
}

export function removeDeviceConnectorRecords(
  ids: readonly string[],
): Promise<void> {
  assertNotDecoySession();
  const principal = requireDeviceConnectorPrincipal();
  return trashOwnedRecords(ids, principal);
}

async function trashOwnedRecords(
  ids: readonly string[],
  principal: ReturnType<typeof requireDeviceConnectorPrincipal>,
): Promise<void> {
  const selected = new Set(ids);
  for (const row of readDeviceRows().filter((entry) =>
    selected.has(entry.connectionId),
  )) {
    const item = vaultStore
      .getSnapshot()
      .items.find((entry) => entry.id === row.secretItemId);
    if (!item || item.kind !== "secret" || item.deletedAt) continue;
    const payload: BoundaryValue = JSON.parse(item.value);
    if (
      !isJsonObject(payload) ||
      payload.owner !== principal.id ||
      payload.connectionId !== row.connectionId
    )
      throw new Error("The connector secret belongs to another record.");
    assertDeviceConnectorPrincipal(principal);
    await vaultStore.trashItem(item.id);
    assertDeviceConnectorPrincipal(principal);
  }
  assertDeviceConnectorPrincipal(principal);
  await mutateDeviceRows((rows) =>
    rows.filter((row) => !selected.has(row.connectionId)),
  );
  await kvFlush();
  assertDeviceConnectorPrincipal(principal);
}

function rowFrom(value: BoundaryValue): PublicRow | null {
  if (!isJsonObject(value)) return null;
  if (
    !isString(value.connectionId) ||
    !isString(value.providerId) ||
    !isString(value.displayName) ||
    !isString(value.createdAt) ||
    !isString(value.updatedAt) ||
    !Array.isArray(value.scopes) ||
    !isJsonObject(value.fields)
  ) {
    return null;
  }
  const scopes: string[] = [];
  for (const scope of value.scopes) {
    if (!isString(scope)) return null;
    scopes.push(scope);
  }
  const fields: StringFields = {};
  for (const [name, entry] of Object.entries(value.fields)) {
    if (!isString(entry)) return null;
    fields[name] = entry;
  }
  const row: PublicRow = {
    connectionId: value.connectionId,
    providerId: value.providerId,
    displayName: value.displayName,
    scopes,
    fields,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
  if (isString(value.owner)) row.owner = value.owner;
  if (isString(value.secretItemId)) row.secretItemId = value.secretItemId;
  return row;
}

function storedEntries(): BoundaryValue[] {
  const raw = kvGet(PUBLIC_KEY);
  if (!raw) return [];
  const parsed: BoundaryValue = JSON.parse(raw);
  if (!Array.isArray(parsed))
    throw new Error("The connector records are unavailable.");
  return parsed;
}

function allRows(): PublicRow[] {
  try {
    return storedEntries().flatMap((entry) => {
      const row = rowFrom(entry);
      return row ? [row] : [];
    });
  } catch {
    return [];
  }
}

export function readDeviceRows(): PublicRow[] {
  const principal = activeDeviceConnectorPrincipal();
  return principal ? allRows().filter((row) => row.owner === principal.id) : [];
}

export function writeDeviceRows(rows: PublicRow[]): Promise<void> {
  assertNotDecoySession();
  requireDeviceConnectorPrincipal();
  return mutateDeviceRows(() => rows).then(() => undefined);
}

export function mutateDeviceRows(
  change: (rows: PublicRow[]) => PublicRow[],
): Promise<PublicRow[]> {
  assertNotDecoySession();
  const principal = requireDeviceConnectorPrincipal();
  return withDeviceConnectorMetadata(async () => {
    const rows = change(readDeviceRows());
    if (
      rows.some((row) => row.owner !== undefined && row.owner !== principal.id)
    )
      throw new Error("This connector belongs to another vault.");
    const retained = storedEntries().filter(
      (entry) => rowFrom(entry)?.owner !== principal.id,
    );
    const owned = rows.map((row) => ({ ...row, owner: principal.id }));
    assertDeviceConnectorPrincipal(principal);
    await kvSetDurable(PUBLIC_KEY, JSON.stringify([...retained, ...owned]));
    assertDeviceConnectorPrincipal(principal);
    return owned;
  });
}

/** Only the admitted body may supply secret fields. Legacy device maps are quarantined. */
export function readDeviceSecrets(): SecretStore {
  const principal = activeDeviceConnectorPrincipal();
  if (!principal) return {};
  const map: SecretStore = {};
  const items = vaultStore.getSnapshot().items;
  for (const row of readDeviceRows()) {
    const item = items.find(
      (entry) => entry.id === row.secretItemId && entry.kind === "secret",
    );
    if (
      !item ||
      item.kind !== "secret" ||
      item.deletedAt ||
      !isString(item.value)
    )
      continue;
    try {
      const value: BoundaryValue = JSON.parse(item.value);
      if (
        !isJsonObject(value) ||
        value.connectionId !== row.connectionId ||
        value.owner !== row.owner ||
        !isJsonObject(value.fields)
      )
        continue;
      const fields: StringFields = {};
      for (const [key, entry] of Object.entries(value.fields)) {
        if (!isString(entry)) throw new Error("Invalid connector field.");
        fields[key] = entry;
      }
      map[row.connectionId] = fields;
    } catch {
      /* Invalid or unrelated items never supply credentials. */
    }
  }
  return map;
}

export function writeDeviceSecrets(map: SecretStore): Promise<void> {
  assertNotDecoySession();
  const principal = requireDeviceConnectorPrincipal();
  return persistSecrets(map, principal);
}

async function persistSecrets(
  map: SecretStore,
  principal: ReturnType<typeof requireDeviceConnectorPrincipal>,
): Promise<void> {
  const rows = await withDeviceConnectorMetadata(async () => readDeviceRows());
  assertDeviceConnectorPrincipal(principal);
  const updated = new Map<string, string>();
  for (const row of rows) {
    const fields = map[row.connectionId];
    if (!fields) continue;
    const existing = vaultStore
      .getSnapshot()
      .items.find(
        (item) => item.id === row.secretItemId && item.kind === "secret",
      );
    if (existing?.kind === "secret") {
      const payload: BoundaryValue = JSON.parse(existing.value);
      if (
        !isJsonObject(payload) ||
        payload.owner !== principal.id ||
        payload.connectionId !== row.connectionId
      )
        throw new Error("The connector secret belongs to another record.");
    }
    const item =
      existing?.kind === "secret"
        ? { ...existing }
        : createItem("secret", `Connector · ${row.displayName}`);
    item.value = JSON.stringify({
      owner: principal.id,
      connectionId: row.connectionId,
      fields,
    });
    assertDeviceConnectorPrincipal(principal);
    await vaultStore.saveItem(item);
    assertDeviceConnectorPrincipal(principal);
    updated.set(row.connectionId, item.id);
  }
  assertDeviceConnectorPrincipal(principal);
  await mutateDeviceRows((current) => {
    if (
      [...updated.keys()].some(
        (id) => !current.some((row) => row.connectionId === id),
      )
    )
      throw new Error("A connector changed during its credential write.");
    return current.map((row) => {
      const secretItemId = updated.get(row.connectionId);
      return secretItemId ? { ...row, secretItemId } : row;
    });
  });
  await kvFlush();
  assertDeviceConnectorPrincipal(principal);
}

onDeviceConnectorPrincipalTransfer(async (from, to) => {
  assertDeviceConnectorPrincipal(to);
  const rows = await withDeviceConnectorMetadata(async () => allRows());
  for (const row of rows.filter((entry) => entry.owner === from.id)) {
    if (row.secretItemId) {
      const original = vaultStore
        .getSnapshot()
        .items.find(
          (item) => item.id === row.secretItemId && item.kind === "secret",
        );
      if (!original || original.kind !== "secret" || !isString(original.value))
        throw new Error("The carried connector secret is unavailable.");
      const payload: BoundaryValue = JSON.parse(original.value);
      if (
        !isJsonObject(payload) ||
        payload.owner !== from.id ||
        payload.connectionId !== row.connectionId
      )
        throw new Error("The carried connector secret has another owner.");
      await vaultStore.saveItem({
        ...original,
        value: JSON.stringify({ ...payload, owner: to.id }),
      });
      assertDeviceConnectorPrincipal(to);
    }
    row.owner = to.id;
  }
  assertDeviceConnectorPrincipal(to);
  await withDeviceConnectorMetadata(async () => {
    const entries = storedEntries().map((entry) => {
      const row = rowFrom(entry);
      if (row?.owner !== from.id) return entry;
      const carried = rows.find(
        (candidate) =>
          candidate.connectionId === row.connectionId &&
          candidate.owner === to.id,
      );
      if (!carried || carried.secretItemId !== row.secretItemId)
        throw new Error("The carried connector changed during promotion.");
      return { ...carried };
    });
    assertDeviceConnectorPrincipal(to);
    await kvSetDurable(PUBLIC_KEY, JSON.stringify(entries));
    assertDeviceConnectorPrincipal(to);
  });
  await kvFlush();
  assertDeviceConnectorPrincipal(to);
});
