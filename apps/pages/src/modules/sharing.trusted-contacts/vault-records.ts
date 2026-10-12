/**
 * The durable records of Settings › Trusted contacts, kept as items of the two
 * optional item types in the open vault (ADR 0187 §10): a `trusted-circle` for
 * a circle the person owns, a `guardian-share` for what they hold for someone
 * else. `records.ts` in app-core maps the engine's documents to an item's
 * values and back; this is the `RecordStore` the desk runs against.
 *
 * The owner's signing key, a wrapped share and a receiving key stay in the
 * item's concealed values and in no other place: never a list line, a log, a
 * message or a thrown error.
 */

import {
  DeskError,
  type OwnedRecord,
  type RecordStore,
} from "@opensesame/app-core/lib/quorum/desk/ports.js";
import { ensureQuorumTypes } from "@opensesame/app-core/lib/quorum/item-types.js";
import { PolicyError } from "@opensesame/app-core/lib/quorum/policy.js";
import {
  type CircleState,
  GUARDIAN_SHARE_TYPE,
  type HeldRecord,
  TRUSTED_CIRCLE_TYPE,
  circleValues,
  readCircleRecord,
  readHeldRecord,
  seatValues,
  shareValues,
} from "@opensesame/app-core/lib/quorum/records.js";
import type { VaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { isString } from "@opensesame/os-domain";
import {
  type TypedItem,
  type VaultItem,
  activeItems,
  createTypedItem,
  itemTypeRegistry,
} from "@opensesame/vault-core";
import type { FieldValues } from "@opensesame/vault-item-types";

/** What the records need of the vault store; the real one by default. */
export type RecordsVault = Pick<
  VaultStore,
  "getSnapshot" | "saveItem" | "purgeItem" | "installItemTypeDefinition"
>;

/**
 * A record that is in the vault and cannot be used: its signed policy no
 * longer verifies, or it does not read at all. A screen marks the row; it
 * carries the item's name and ids, never a value, and never the error text
 * (a parser's message can quote the text it choked on).
 */
export type UnreadableRecord = Readonly<{
  /** The vault item, so a row can point at it. */
  itemId: string;
  type: "owned" | "held";
  /** The circle's name as it was saved. */
  name: string;
  circleId: string | null;
  /** `policy`: the signed policy does not verify. `format`: it does not read. */
  reason: "policy" | "format";
}>;

export type VaultRecordStore = RecordStore &
  Readonly<{
    /** The records `owned()` and `held()` had to leave out, owned first. */
    unreadable(): Promise<readonly UnreadableRecord[]>;
  }>;

type Scan<R> = Readonly<{
  records: readonly R[];
  unreadable: readonly UnreadableRecord[];
}>;

const CIRCLE_STATES = [
  "inviting",
  "armed",
  "recovering",
  "retired",
] as const satisfies readonly CircleState[];

function text(value: FieldValues[string] | undefined): string {
  return isString(value) ? value : "";
}

function circleState(value: FieldValues[string] | undefined): CircleState {
  const found = text(value);
  for (const state of CIRCLE_STATES) {
    if (state === found) return state;
  }
  throw new Error("not a circle state");
}

function readOwned(values: FieldValues): OwnedRecord {
  const { signedPolicy, ownerSecretKey } = readCircleRecord(values);
  return { signedPolicy, ownerSecretKey, state: circleState(values.status) };
}

function typed(items: readonly VaultItem[], typeId: string): TypedItem[] {
  return items.filter(
    (item): item is TypedItem =>
      item.kind === "typed" && item.typeId === typeId,
  );
}

function scan<R>(
  items: readonly VaultItem[],
  typeId: string,
  type: UnreadableRecord["type"],
  read: (values: FieldValues) => R,
): Scan<R> {
  const records: R[] = [];
  const unreadable: UnreadableRecord[] = [];
  for (const item of typed(activeItems([...items]), typeId)) {
    try {
      records.push(read(item.values));
    } catch (error) {
      const circleId = text(item.values.circleId);
      unreadable.push({
        itemId: item.id,
        type,
        name: item.name,
        circleId: circleId === "" ? null : circleId,
        reason: error instanceof PolicyError ? "policy" : "format",
      });
    }
  }
  return { records, unreadable };
}

/** The circles in a vault's items, and the circle items that cannot be read. */
export const scanOwned = (items: readonly VaultItem[]) =>
  scan(items, TRUSTED_CIRCLE_TYPE, "owned", readOwned);

/** The shares and seats in a vault's items, and the items that cannot be read. */
export const scanHeld = (items: readonly VaultItem[]) =>
  scan(items, GUARDIAN_SHARE_TYPE, "held", readHeldRecord);

/** Every record in the items that is there and cannot be used. */
export function unreadableRecords(
  items: readonly VaultItem[],
): readonly UnreadableRecord[] {
  return [...scanOwned(items).unreadable, ...scanHeld(items).unreadable];
}

/** The items of one circle, trashed ones too: a removal must reach them. */
function itemsOf(
  items: readonly VaultItem[],
  typeId: string,
  circleId: string,
): TypedItem[] {
  return typed(items, typeId).filter(
    (item) => text(item.values.circleId) === circleId,
  );
}

/** One record to keep as the item of its circle. */
type Upsert = Readonly<{
  typeId: string;
  circleId: string;
  name: string;
  /** The item's values, given the item already there if there is one. */
  values: (existing: TypedItem | undefined) => FieldValues;
}>;

/**
 * Save a record as the item of its circle: update it where there is one,
 * make it where there is not. The store refuses an update when another tab
 * changed the item since it was read, so a failure is tried once more against
 * the items as they are by then.
 */
async function upsert(store: RecordsVault, input: Upsert): Promise<void> {
  await ensureQuorumTypes(store);
  const definition = itemTypeRegistry().get(input.typeId);
  if (!definition) throw new Error(`${input.typeId} is not installed`);
  for (let attempt = 0; ; attempt += 1) {
    const [existing] = itemsOf(
      activeItems([...store.getSnapshot().items]),
      input.typeId,
      input.circleId,
    );
    const values = input.values(existing);
    const item = existing
      ? { ...existing, name: input.name, values }
      : createTypedItem(definition, values, input.name);
    try {
      await store.saveItem(item);
      return;
    } catch (error) {
      if (attempt > 0) throw error;
    }
  }
}

/** A removal is a purge: a retired key must not wait in a trash. */
async function purge(
  store: RecordsVault,
  typeId: string,
  circleId: string,
): Promise<void> {
  for (const item of itemsOf(store.getSnapshot().items, typeId, circleId)) {
    await store.purgeItem(item.id);
  }
}

function heldValues(
  record: HeldRecord,
  existing: TypedItem | undefined,
): FieldValues {
  const signedPolicy = record.holding
    ? record.holding.signedPolicy
    : record.seat.signedPolicy;
  // A name the person gave in the item editor outlives the next save.
  const heldFor = text(existing?.values.owner) || signedPolicy.policy.label;
  const receivingKey = record.receivingKey ?? undefined;
  return record.holding
    ? shareValues({
        holding: record.holding,
        heldFor,
        receivingKey,
        state: record.state,
      })
    : seatValues({
        signedPolicy,
        guardianId: record.seat.guardianId,
        heldFor,
        receivingKey,
        state: record.state,
      });
}

/** The records of the open vault, kept as typed items of `store`. */
export function vaultRecordStore(store: RecordsVault): VaultRecordStore {
  const items = () => store.getSnapshot().items;
  return {
    owned: async () => scanOwned(items()).records,
    unreadable: async () => unreadableRecords(items()),
    held: async () => scanHeld(items()).records,

    async saveOwned(record) {
      const { policy } = record.signedPolicy;
      await upsert(store, {
        typeId: TRUSTED_CIRCLE_TYPE,
        circleId: policy.circleId,
        name: policy.label,
        values: () => circleValues(record),
      });
    },

    async saveHeld(record) {
      const circleId = record.seat.signedPolicy.policy.circleId;
      if (record.holding && record.holding.wrapped.circleId !== circleId) {
        throw new DeskError("mismatch", "that share belongs to another circle");
      }
      await upsert(store, {
        typeId: GUARDIAN_SHARE_TYPE,
        circleId,
        name: record.seat.signedPolicy.policy.label,
        values: (existing) => heldValues(record, existing),
      });
    },

    removeOwned: (circleId) => purge(store, TRUSTED_CIRCLE_TYPE, circleId),
    removeHeld: (circleId) => purge(store, GUARDIAN_SHARE_TYPE, circleId),
  };
}
