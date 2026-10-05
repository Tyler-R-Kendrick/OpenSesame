/**
 * Return: put items back into the open vault from their bundle and return
 * code (ADR 0171).
 *
 * `openItemsReturn` opens the bundle and says, item by item, what would
 * happen; `completeItemsReturn` does it, in one sealed mutation that writes
 * no activity line. Items come back under their own ids, times, folders and
 * trash state, so returning twice never doubles anything. A bundle that
 * belongs to another vault, that does not open, or that names an id the vault
 * already holds with other content, changes nothing.
 */

import { ItemDepartureError, itemText } from "../vault/item-departure.js";
import {
  TravelBundleError,
  type TravelBundleErrorCode,
} from "./bundle-format.js";
import { type TravelGateRefusal, travelGate } from "./depart.js";
import { type ItemsPayload, openItemsBundle } from "./items-bundle.js";
import type { ItemsDeps } from "./items-depart.js";
import { ReturnCodeError, parseReturnCode } from "./return-code.js";

export type ItemReturnStatus =
  /** Not in the vault: it will be added. */
  | "returns"
  /** In the vault already, content for content. */
  | "already_back"
  /** The vault holds this id with other content; nothing is written. */
  | "occupied";

export type ReturningItem = Readonly<{
  id: string;
  label: string;
  kind: string;
  status: ItemReturnStatus;
}>;

export type ItemsReturnPreview = Readonly<{
  bundleId: string;
  hiddenAt: string;
  items: readonly ReturningItem[];
}>;

export type OpenedItemsReturn = Readonly<{
  preview: ItemsReturnPreview;
  payload: ItemsPayload;
}>;

export type ItemsReturnRefusal =
  | TravelBundleErrorCode
  | TravelGateRefusal
  | "code_malformed"
  /** The bundle was made from another vault. */
  | "other_vault";

export type OpenItemsReturnOutcome =
  | { ok: true; opened: OpenedItemsReturn }
  | { ok: false; code: ItemsReturnRefusal; message: string };

export type ItemsReturnReceipt = Readonly<{
  returned: readonly string[];
  alreadyBack: readonly string[];
}>;

export type CompleteItemsReturnOutcome =
  | { ok: true; receipt: ItemsReturnReceipt }
  | {
      ok: false;
      code: TravelGateRefusal | "other_vault" | "occupied";
      ids: readonly string[];
    };

const GATE_MESSAGE = {
  owner_not_present: "Open one of your own vaults first.",
  duress_active: "Not while a duress response holds this device.",
  storage_not_durable: "This browser is not keeping files for this site.",
} satisfies Record<TravelGateRefusal, string>;

function statuses(
  payload: ItemsPayload,
  held: ReadonlyMap<string, string>,
): ReturningItem[] {
  return payload.items.map((item) => {
    const there = held.get(item.id);
    const status: ItemReturnStatus =
      there === undefined
        ? "returns"
        : there === itemText(item)
          ? "already_back"
          : "occupied";
    return {
      id: item.id,
      label: item.name.trim() === "" ? "Untitled" : item.name.trim(),
      kind: item.kind,
      status,
    };
  });
}

function heldTexts(deps: ItemsDeps): Map<string, string> | null {
  const vault = deps.vault();
  return vault
    ? new Map(vault.items.map((item) => [item.id, itemText(item)]))
    : null;
}

function fromThisVault(deps: ItemsDeps, payload: ItemsPayload): boolean {
  const vault = deps.vault();
  return (
    vault !== null &&
    vault.tomb === payload.vault.tomb &&
    vault.createdAt === payload.vault.createdAt
  );
}

/** Open a bundle with its code and preview the return. Writes nothing. */
export async function openItemsReturn(
  deps: ItemsDeps,
  input: { bundleJson: string; returnCode: string },
): Promise<OpenItemsReturnOutcome> {
  const gate = await travelGate(deps);
  if (gate) return { ok: false, code: gate, message: GATE_MESSAGE[gate] };
  let payload: ItemsPayload;
  try {
    const secret = await parseReturnCode(input.returnCode);
    payload = await openItemsBundle(input.bundleJson, secret);
  } catch (error) {
    if (
      error instanceof ReturnCodeError ||
      error instanceof TravelBundleError
    ) {
      return { ok: false, code: error.code, message: error.message };
    }
    throw error;
  }
  const held = heldTexts(deps);
  if (!held || !fromThisVault(deps, payload)) {
    return {
      ok: false,
      code: "other_vault",
      message: "These items were left home by a different vault.",
    };
  }
  return {
    ok: true,
    opened: {
      payload,
      preview: {
        bundleId: payload.bundleId,
        hiddenAt: payload.hiddenAt,
        items: statuses(payload, held),
      },
    },
  };
}

/**
 * Put the items back. The preview is not trusted: the gates and the vault
 * are read again, and the mutation itself refuses an occupied id before it
 * changes anything.
 */
export function completeItemsReturn(
  deps: ItemsDeps,
  opened: OpenedItemsReturn,
): Promise<CompleteItemsReturnOutcome> {
  return deps.exclusive(async () => {
    const gate = await travelGate(deps);
    if (gate) return { ok: false, code: gate, ids: [] };
    const { payload } = opened;
    const held = heldTexts(deps);
    if (!held || !fromThisVault(deps, payload)) {
      return { ok: false, code: "other_vault", ids: [] };
    }
    const now = statuses(payload, held);
    const occupied = now.filter((row) => row.status === "occupied");
    if (occupied.length > 0) {
      return { ok: false, code: "occupied", ids: occupied.map((r) => r.id) };
    }
    try {
      await deps.restore({ items: payload.items, folders: payload.folders });
    } catch (error) {
      if (error instanceof ItemDepartureError) {
        return { ok: false, code: "occupied", ids: error.ids };
      }
      throw error;
    }
    return {
      ok: true,
      receipt: {
        returned: now.filter((r) => r.status === "returns").map((r) => r.id),
        alreadyBack: now
          .filter((r) => r.status === "already_back")
          .map((r) => r.id),
      },
    };
  });
}
