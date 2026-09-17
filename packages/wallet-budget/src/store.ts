/**
 * In-memory transactional store. One writer at a time: `transact` serializes
 * mutations so concurrent callers cannot both take the same remainder.
 */

import type { JournalEntry } from "./journal.js";
import {
  type AttemptState,
  type BudgetSnapshot,
  type NodeState,
  cloneAttempt,
  cloneNode,
} from "./state.js";
import type { BudgetNodeRef, PaymentAttemptId } from "./types.js";

export type BudgetTx = {
  readonly journal: readonly JournalEntry[];
  getNode(id: BudgetNodeRef): NodeState | undefined;
  getAttempt(id: PaymentAttemptId): AttemptState | undefined;
  listNodes(): readonly NodeState[];
  listAttempts(): readonly AttemptState[];
  /** Replace or insert a node clone owned by this transaction. */
  putNode(node: NodeState): void;
  deleteNode(id: BudgetNodeRef): void;
  putAttempt(attempt: AttemptState): void;
  append(entry: JournalEntry): void;
};

export type BudgetStore = {
  /** Run `body` atomically. On throw, no mutation is published. */
  transact<T>(body: (tx: BudgetTx) => T): T;
  snapshot(): BudgetSnapshot;
};

class MemoryTx implements BudgetTx {
  readonly journal: JournalEntry[];
  private readonly nodes: Map<BudgetNodeRef, NodeState>;
  private readonly attempts: Map<PaymentAttemptId, AttemptState>;

  constructor(
    journal: readonly JournalEntry[],
    nodes: ReadonlyMap<BudgetNodeRef, NodeState>,
    attempts: ReadonlyMap<PaymentAttemptId, AttemptState>,
  ) {
    this.journal = [...journal];
    this.nodes = new Map();
    for (const [id, node] of nodes) {
      this.nodes.set(id, cloneNode(node));
    }
    this.attempts = new Map();
    for (const [id, attempt] of attempts) {
      this.attempts.set(id, cloneAttempt(attempt));
    }
  }

  getNode(id: BudgetNodeRef): NodeState | undefined {
    return this.nodes.get(id);
  }

  getAttempt(id: PaymentAttemptId): AttemptState | undefined {
    return this.attempts.get(id);
  }

  listNodes(): readonly NodeState[] {
    return [...this.nodes.values()];
  }

  listAttempts(): readonly AttemptState[] {
    return [...this.attempts.values()];
  }

  putNode(node: NodeState): void {
    this.nodes.set(node.id, node);
  }

  deleteNode(id: BudgetNodeRef): void {
    this.nodes.delete(id);
  }

  putAttempt(attempt: AttemptState): void {
    this.attempts.set(attempt.attemptId, attempt);
  }

  append(entry: JournalEntry): void {
    this.journal.push(entry);
  }

  publish() {
    return {
      journal: this.journal,
      nodes: this.nodes,
      attempts: this.attempts,
    } satisfies {
      journal: JournalEntry[];
      nodes: Map<BudgetNodeRef, NodeState>;
      attempts: Map<PaymentAttemptId, AttemptState>;
    };
  }
}

/**
 * Single-threaded in-memory ledger. Nested `transact` calls are forbidden so
 * callers cannot accidentally nest partial commits.
 */
export class InMemoryBudgetStore implements BudgetStore {
  private journal: JournalEntry[] = [];
  private nodes = new Map<BudgetNodeRef, NodeState>();
  private attempts = new Map<PaymentAttemptId, AttemptState>();
  private locked = false;

  constructor(initial?: BudgetSnapshot) {
    if (initial === undefined) return;
    this.journal = [...initial.journal];
    for (const [id, node] of initial.nodes) {
      this.nodes.set(id, cloneNode(node));
    }
    for (const [id, attempt] of initial.attempts) {
      this.attempts.set(id, cloneAttempt(attempt));
    }
  }

  transact<T>(body: (tx: BudgetTx) => T): T {
    if (this.locked) {
      throw new Error("Budget store transaction is already open");
    }
    this.locked = true;
    const tx = new MemoryTx(this.journal, this.nodes, this.attempts);
    try {
      const result = body(tx);
      const published = tx.publish();
      this.journal = published.journal;
      this.nodes = published.nodes;
      this.attempts = published.attempts;
      return result;
    } finally {
      this.locked = false;
    }
  }

  snapshot(): BudgetSnapshot {
    return {
      nodes: new Map(
        [...this.nodes.entries()].map(([id, node]) => [id, cloneNode(node)]),
      ),
      attempts: new Map(
        [...this.attempts.entries()].map(([id, attempt]) => [
          id,
          cloneAttempt(attempt),
        ]),
      ),
      journal: [...this.journal],
    };
  }
}

export function createInMemoryBudgetStore(
  initial?: BudgetSnapshot,
): BudgetStore {
  return new InMemoryBudgetStore(initial);
}
