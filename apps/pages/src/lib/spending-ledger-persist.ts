/**
 * localStorage wire format for the browser spending ledger (ADR 0123).
 */
import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import type {
  AmountUnits,
  AttemptState,
  BudgetNodeRef,
  BudgetSnapshot,
  JournalEntry,
  NodeState,
} from "@opensesame/wallet-budget";

import { emitActivity } from "./activity-log.js";
import { readWalletStorage, walletStorageKey } from "./wallet-storage-scope.js";

export const SPENDING_LEDGER_STORAGE_KEY = "opensesame.wallet.budget.v1";

type PersistedSnapshot = {
  readonly version: 1;
  readonly journal: readonly JsonObject[];
  readonly nodes: readonly JsonObject[];
  readonly attempts: readonly JsonObject[];
};

function amountToWire(value: AmountUnits): string {
  return value.toString(10);
}

function parseAmount(value: BoundaryValue, label: string): AmountUnits {
  if (!isString(value) || !/^[0-9]+$/u.test(value)) {
    throw new Error(`${label} must be a non-negative decimal integer string`);
  }
  return BigInt(value);
}

function nodeToWire(node: NodeState): JsonObject {
  return {
    id: node.id,
    parentId: node.parentId,
    strategy: node.strategy,
    ceiling: amountToWire(node.ceiling),
    postedSpending: amountToWire(node.postedSpending),
    unresolvedExternalExposure: amountToWire(node.unresolvedExternalExposure),
    reservedToChildren: amountToWire(node.reservedToChildren),
    locallyAvailable: amountToWire(node.locallyAvailable),
  };
}

function parseNode(value: JsonObject): NodeState {
  const strategy = value.strategy;
  if (strategy !== "shared_counter" && strategy !== "exclusive_allocation") {
    throw new Error("invalid allocation strategy");
  }
  if (!isString(value.id)) throw new Error("node id required");
  const parentId =
    value.parentId === null
      ? null
      : isString(value.parentId)
        ? value.parentId
        : (() => {
            throw new Error("invalid parentId");
          })();
  return {
    id: value.id,
    parentId,
    strategy,
    ceiling: parseAmount(value.ceiling, "ceiling"),
    postedSpending: parseAmount(value.postedSpending, "postedSpending"),
    unresolvedExternalExposure: parseAmount(
      value.unresolvedExternalExposure,
      "unresolvedExternalExposure",
    ),
    reservedToChildren: parseAmount(
      value.reservedToChildren,
      "reservedToChildren",
    ),
    locallyAvailable: parseAmount(value.locallyAvailable, "locallyAvailable"),
  };
}

function attemptToWire(attempt: AttemptState): JsonObject {
  return {
    attemptId: attempt.attemptId,
    nodeId: attempt.nodeId,
    amount: amountToWire(attempt.amount),
    state: attempt.state,
    path: [...attempt.path],
    holds: attempt.holds.map((h) => ({
      nodeId: h.nodeId,
      amount: amountToWire(h.amount),
    })),
  };
}

function parseAttempt(value: JsonObject): AttemptState {
  if (!isString(value.attemptId) || !isString(value.nodeId)) {
    throw new Error("attempt ids required");
  }
  const state = value.state;
  if (state !== "reserved" && state !== "committed" && state !== "released") {
    throw new Error("invalid reservation state");
  }
  if (!Array.isArray(value.path) || !Array.isArray(value.holds)) {
    throw new Error("attempt path/holds required");
  }
  const path: string[] = [];
  for (const entry of value.path) {
    if (!isString(entry)) throw new Error("invalid path entry");
    path.push(entry);
  }
  const holds: { nodeId: string; amount: AmountUnits }[] = [];
  for (const hold of value.holds) {
    if (!isJsonObject(hold) || !isString(hold.nodeId)) {
      throw new Error("invalid hold");
    }
    holds.push({
      nodeId: hold.nodeId,
      amount: parseAmount(hold.amount, "hold.amount"),
    });
  }
  return {
    attemptId: value.attemptId,
    nodeId: value.nodeId,
    amount: parseAmount(value.amount, "amount"),
    state,
    path,
    holds,
  };
}

function journalToWire(entry: JournalEntry): JsonObject {
  switch (entry.kind) {
    case "node_opened":
      return {
        kind: entry.kind,
        nodeId: entry.nodeId,
        parentId: entry.parentId,
        ceiling: amountToWire(entry.ceiling),
        strategy: entry.strategy,
      };
    case "exclusive_allocated":
      return {
        kind: entry.kind,
        parentId: entry.parentId,
        childId: entry.childId,
        amount: amountToWire(entry.amount),
      };
    case "reserved":
      return {
        kind: entry.kind,
        attemptId: entry.attemptId,
        nodeId: entry.nodeId,
        amount: amountToWire(entry.amount),
        path: [...entry.path],
        holds: entry.holds.map((h) => ({
          nodeId: h.nodeId,
          amount: amountToWire(h.amount),
        })),
      };
    case "committed":
    case "released":
      return { kind: entry.kind, attemptId: entry.attemptId };
    case "ceiling_set":
      return {
        kind: entry.kind,
        nodeId: entry.nodeId,
        ceiling: amountToWire(entry.ceiling),
      };
    case "node_closed":
      return { kind: entry.kind, nodeId: entry.nodeId };
  }
}

function parseClosedOrCeiling(
  value: JsonObject,
  kind: BoundaryValue,
): JournalEntry | null {
  if (kind === "node_closed") {
    if (!isString(value.nodeId)) throw new Error("nodeId required");
    return { kind, nodeId: value.nodeId };
  }
  if (kind === "ceiling_set") {
    if (!isString(value.nodeId)) throw new Error("nodeId required");
    return {
      kind,
      nodeId: value.nodeId,
      ceiling: parseAmount(value.ceiling, "ceiling"),
    };
  }
  return null;
}

function parseJournalEntry(value: JsonObject): JournalEntry {
  const kind = value.kind;
  const lifecycle = parseClosedOrCeiling(value, kind);
  if (lifecycle) return lifecycle;
  if (kind === "committed" || kind === "released") {
    if (!isString(value.attemptId)) throw new Error("attemptId required");
    return { kind, attemptId: value.attemptId };
  }
  if (kind === "node_opened") {
    if (!isString(value.nodeId)) throw new Error("nodeId required");
    const strategy = value.strategy;
    if (strategy !== "shared_counter" && strategy !== "exclusive_allocation") {
      throw new Error("invalid strategy");
    }
    const parentId =
      value.parentId === null
        ? null
        : isString(value.parentId)
          ? value.parentId
          : (() => {
              throw new Error("invalid parentId");
            })();
    return {
      kind,
      nodeId: value.nodeId,
      parentId,
      ceiling: parseAmount(value.ceiling, "ceiling"),
      strategy,
    };
  }
  if (kind === "exclusive_allocated") {
    if (!isString(value.parentId) || !isString(value.childId)) {
      throw new Error("allocation ids required");
    }
    return {
      kind,
      parentId: value.parentId,
      childId: value.childId,
      amount: parseAmount(value.amount, "amount"),
    };
  }
  if (kind === "reserved") {
    return {
      kind,
      ...parseAttempt({
        ...value,
        state: "reserved",
      }),
    };
  }
  throw new Error("unknown journal kind");
}

function snapshotToPersisted(snapshot: BudgetSnapshot): PersistedSnapshot {
  return {
    version: 1,
    journal: snapshot.journal.map(journalToWire),
    nodes: [...snapshot.nodes.values()].map(nodeToWire),
    attempts: [...snapshot.attempts.values()].map(attemptToWire),
  };
}

function persistedToSnapshot(raw: PersistedSnapshot): BudgetSnapshot {
  const nodes = new Map<BudgetNodeRef, NodeState>();
  for (const entry of raw.nodes) {
    const node = parseNode(entry);
    nodes.set(node.id, node);
  }
  const attempts = new Map<string, AttemptState>();
  for (const entry of raw.attempts) {
    const attempt = parseAttempt(entry);
    attempts.set(attempt.attemptId, attempt);
  }
  return {
    nodes,
    attempts,
    journal: raw.journal.map(parseJournalEntry),
  };
}

function readJsonObjectArray(value: BoundaryValue): JsonObject[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: JsonObject[] = [];
  for (const entry of value) {
    if (!isJsonObject(entry)) return undefined;
    out.push(entry);
  }
  return out;
}

export function readPersisted(): BudgetSnapshot | undefined {
  const text = readWalletStorage(SPENDING_LEDGER_STORAGE_KEY);
  if (text === null || text === "") return undefined;
  try {
    const parsed: BoundaryValue = overlapCast(JSON.parse(text));
    if (!isJsonObject(parsed) || parsed.version !== 1) return undefined;
    const journal = readJsonObjectArray(parsed.journal);
    const nodes = readJsonObjectArray(parsed.nodes);
    const attempts = readJsonObjectArray(parsed.attempts);
    if (
      journal === undefined ||
      nodes === undefined ||
      attempts === undefined
    ) {
      return undefined;
    }
    return persistedToSnapshot({ version: 1, journal, nodes, attempts });
  } catch {
    return undefined;
  }
}

export function writePersisted(snapshot: BudgetSnapshot): void {
  emitActivity({
    category: "wallet", type: "wallet.budget.updated",
    summary: "Wallet budget updated", outcome: "succeeded",
  });
  try {
    localStorage.setItem(
      walletStorageKey(SPENDING_LEDGER_STORAGE_KEY),
      JSON.stringify(snapshotToPersisted(snapshot)),
    );
  } catch {
    // Quota / private mode — keep in-memory ledger; do not invent persistence.
  }
}
