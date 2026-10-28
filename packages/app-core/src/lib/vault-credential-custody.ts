/** Integration metadata names credentials; only the actual open vault holds their values. */
import {
  type CredentialItem,
  createCredential,
  isRetired,
} from "@opensesame/vault-core";
import { z } from "zod";
import { FIELD_LIMITS } from "./vault/field-limits.js";
import { itemText } from "./vault/item-departure.js";
import type { VaultStore } from "./vault/store.js";

const MARKER_FIELD_ID = "opensesame-integration-binding";
const Field = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,99}$/);
const Reference = z
  .object({
    v: z.literal(1),
    revision: z.string().uuid(),
    entries: z
      .array(z.object({ field: Field, id: z.string().uuid() }).strict())
      .max(32),
  })
  .strict();
const Marker = z
  .object({
    format: z.literal("opensesame-vault-credential"),
    v: z.literal(1),
    revision: z.string().uuid(),
    field: Field,
    targetBinding: z.string().max(100_000),
  })
  .strict();
type CustodyPort = Pick<
  VaultStore,
  "getSnapshot" | "saveItems" | "withdrawItems"
>;
let vault: CustodyPort | undefined;
export type VaultCredentialCapture = Readonly<{
  reference: string;
  items: readonly CredentialItem[];
}>;
export type VaultCredentialRead = Readonly<{
  fields: ReadonlyMap<string, string>;
  items: readonly CredentialItem[];
}>;
export type VaultCredentialInput = Readonly<{
  name: string;
  targetBinding: string;
  fields: readonly Readonly<{
    field: string;
    label: string;
    value: string;
    /** Protocol-owned metadata is sealed with this exact staged credential. */
    metadata?: readonly CredentialItem["fields"][number][];
  }>[];
}>;
export class VaultCredentialCustodyError extends Error {
  constructor(
    readonly code: "locked" | "invalid_reference",
    message: string,
  ) {
    super(message);
    this.name = "VaultCredentialCustodyError";
  }
}
export async function initializeVaultCredentialCustody(): Promise<void> {
  vault = (await import("./vault/store.js")).vaultStore;
}
function unavailable(): never {
  throw new VaultCredentialCustodyError(
    "invalid_reference",
    "The vault credentials are missing or changed. Enter the credentials and save again.",
  );
}
function currentVault(tomb: string): CustodyPort {
  if (!vault) return unavailable();
  const state = vault.getSnapshot();
  if (
    state.status !== "unlocked" ||
    state.guest ||
    state.awaitingSecondStep ||
    state.tomb !== tomb
  )
    throw new VaultCredentialCustodyError(
      "locked",
      "Unlock the vault that owns these credentials.",
    );
  return vault;
}
function credentialItem(id: string, tomb: string): CredentialItem {
  const item = currentVault(tomb)
    .getSnapshot()
    .items.find((candidate) => candidate.id === id);
  if (
    !item ||
    item.kind !== "credential" ||
    item.accountId !== null ||
    item.deletedAt !== null ||
    isRetired(item)
  )
    return unavailable();
  if (item.method.type !== "token" || item.method.id !== id)
    return unavailable();
  return item;
}
function checkedReference(raw: string, allowedFields: readonly string[]) {
  const reference = Reference.parse(JSON.parse(raw));
  const fields = new Set<string>();
  const ids = new Set<string>();
  for (const entry of reference.entries) {
    if (
      !allowedFields.includes(entry.field) ||
      fields.has(entry.field) ||
      ids.has(entry.id)
    )
      return unavailable();
    fields.add(entry.field);
    ids.add(entry.id);
  }
  return reference;
}
/** Parsed role metadata only; admission still requires readVaultCredentials and its exact reference. */
export function vaultCredentialField(item: CredentialItem): string | null {
  try {
    const fields = item.fields.filter((field) => field.id === MARKER_FIELD_ID);
    const binding = fields[0];
    if (fields.length !== 1 || !binding?.hidden) return null;
    return Marker.parse(JSON.parse(binding.value)).field;
  } catch {
    return null;
  }
}
/** The caller declares its fields; another target and arbitrary token items are refused. */
export function readVaultCredentials(
  rawReference: string,
  targetBinding: string,
  allowedFields: readonly string[],
  tomb: string,
): VaultCredentialRead {
  const reference = checkedReference(rawReference, allowedFields);
  currentVault(tomb);
  const fields = new Map<string, string>();
  const items: CredentialItem[] = [];
  for (const entry of reference.entries) {
    const item = credentialItem(entry.id, tomb);
    const bindings = item.fields.filter(
      (field) => field.id === MARKER_FIELD_ID,
    );
    const binding = bindings[0];
    if (bindings.length !== 1 || !binding?.hidden) return unavailable();
    const marker = Marker.parse(JSON.parse(binding.value));
    if (
      marker.revision !== reference.revision ||
      marker.field !== entry.field ||
      marker.targetBinding !== targetBinding
    )
      return unavailable();
    if (item.method.type === "token")
      fields.set(entry.field, item.method.token);
    items.push(structuredClone(item));
  }
  return { fields, items };
}
/** Stage immutable item versions; the caller atomically publishes only this reference. */
export async function stageVaultCredentials(
  input: VaultCredentialInput,
  tomb: string,
  check: () => void,
): Promise<VaultCredentialCapture> {
  check();
  await initializeVaultCredentialCustody();
  check();
  const port = currentVault(tomb);
  const reference: z.infer<typeof Reference> = {
    v: 1,
    revision: crypto.randomUUID(),
    entries: [],
  };
  const items: CredentialItem[] = [];
  for (const field of input.fields) {
    Field.parse(field.field);
    if (!field.value) continue;
    if (reference.entries.some((entry) => entry.field === field.field))
      return unavailable();
    const id = crypto.randomUUID();
    const item = createCredential(
      { id, type: "token", token: field.value, expiresAt: "" },
      `${field.label} · ${input.name}`.slice(0, FIELD_LIMITS.name),
    );
    for (const metadata of field.metadata ?? []) {
      if (
        metadata.id === MARKER_FIELD_ID ||
        item.fields.some((existing) => existing.id === metadata.id)
      )
        return unavailable();
      item.fields.push(structuredClone(metadata));
    }
    const binding = JSON.stringify(
      Marker.parse({
        format: "opensesame-vault-credential",
        v: 1,
        revision: reference.revision,
        field: field.field,
        targetBinding: input.targetBinding,
      }),
    );
    item.fields.push({
      id: MARKER_FIELD_ID,
      name: "Connection binding",
      hidden: true,
      value: binding,
    });
    reference.entries.push({ field: field.field, id });
    items.push(item);
  }
  Reference.parse(reference);
  if (items.length) await port.saveItems(items, undefined, check);
  check();
  const serialized = JSON.stringify(reference);
  const saved = readVaultCredentials(
    serialized,
    input.targetBinding,
    input.fields.map((field) => field.field),
    tomb,
  );
  for (const field of input.fields)
    if (field.value && saved.fields.get(field.field) !== field.value)
      return unavailable();
  return { reference: serialized, items: saved.items };
}
/** Compose into metadata's final publication guard so an edited staged item is never admitted. */
export function assertVaultCredentials(
  capture: Pick<VaultCredentialCapture, "items">,
  tomb: string,
  check: () => void,
): void {
  check();
  currentVault(tomb);
  for (const expected of capture.items)
    if (itemText(credentialItem(expected.id, tomb)) !== itemText(expected))
      unavailable();
}
export function readVaultCredentialsForWithdrawal(
  rawReference: string,
  targetBinding: string,
  allowedFields: readonly string[],
  tomb: string,
): VaultCredentialRead | null {
  const reference = checkedReference(rawReference, allowedFields);
  const port = currentVault(tomb);
  const active = reference.entries.some((entry) => {
    const item = port
      .getSnapshot()
      .items.find((candidate) => candidate.id === entry.id);
    return item && item.deletedAt === null && !isRetired(item);
  });
  return active
    ? readVaultCredentials(rawReference, targetBinding, allowedFields, tomb)
    : null;
}

/** Expected bytes are checked again inside the vault's queued sealed mutation. */
export async function discardVaultCredentials(
  capture: Pick<VaultCredentialCapture, "items">,
  tomb: string,
  check: () => void,
): Promise<void> {
  if (!capture.items.length) return;
  check();
  const port = currentVault(tomb);
  const expected = Object.fromEntries(
    capture.items.map((item) => [item.id, itemText(item)]),
  );
  await port.withdrawItems({ items: expected, folderIds: [] });
  check();
}

export async function discardUnpublishedVaultCredentials(
  capture: Pick<VaultCredentialCapture, "items">,
  tomb: string,
  published: () => boolean,
  check: () => void,
): Promise<void> {
  if (!published()) await discardVaultCredentials(capture, tomb, check);
}
