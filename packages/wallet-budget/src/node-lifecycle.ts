/**
 * Open-node companions: change a root ceiling, or close a node that is idle.
 */

import { BudgetError, fail } from "./errors.js";
import { projectNode } from "./state.js";
import type { BudgetTx } from "./store.js";
import {
  type AmountUnits,
  type BudgetNodeRef,
  type BudgetProjection,
  assertAmountUnits,
} from "./types.js";

function requireId(value: string, label: string): string {
  if (value.length === 0) {
    throw new BudgetError(
      "invalid_amount",
      `${label} must be a non-empty reference`,
    );
  }
  return value;
}

export type SetCeilingInput = {
  readonly nodeId: BudgetNodeRef;
  readonly ceiling: AmountUnits;
};

export function setCeilingInTx(
  tx: BudgetTx,
  input: SetCeilingInput,
): BudgetProjection {
  const nodeId = requireId(input.nodeId, "nodeId");
  const ceiling = assertAmountUnits(input.ceiling, "ceiling");
  const node = tx.getNode(nodeId);
  if (node === undefined) fail("node_not_found");
  if (node.parentId !== null) fail("wrong_strategy");
  const used =
    node.postedSpending +
    node.unresolvedExternalExposure +
    node.reservedToChildren;
  if (ceiling < used) fail("insufficient_available");
  node.ceiling = ceiling;
  node.locallyAvailable = ceiling - used;
  tx.putNode(node);
  tx.append({ kind: "ceiling_set", nodeId, ceiling });
  return projectNode(node);
}

export function closeNodeInTx(
  tx: BudgetTx,
  nodeId: BudgetNodeRef,
): BudgetProjection {
  const id = requireId(nodeId, "nodeId");
  const node = tx.getNode(id);
  if (node === undefined) fail("node_not_found");
  for (const other of tx.listNodes()) {
    if (other.parentId === id) fail("node_has_children");
  }
  if (
    node.unresolvedExternalExposure > 0n ||
    node.reservedToChildren > 0n ||
    (node.parentId === null && node.postedSpending > 0n)
  ) {
    fail("node_in_use");
  }
  for (const attempt of tx.listAttempts()) {
    if (attempt.state !== "reserved") continue;
    if (attempt.nodeId === id || attempt.path.includes(id)) fail("node_in_use");
  }
  if (node.parentId !== null) {
    const parent = tx.getNode(node.parentId);
    if (parent === undefined) fail("orphan_parent");
    parent.reservedToChildren -= node.ceiling;
    parent.locallyAvailable += node.locallyAvailable;
    parent.postedSpending += node.postedSpending;
    parent.unresolvedExternalExposure += node.unresolvedExternalExposure;
    tx.putNode(parent);
  }
  const closed = projectNode(node);
  tx.deleteNode(id);
  tx.append({ kind: "node_closed", nodeId: id });
  return closed;
}
