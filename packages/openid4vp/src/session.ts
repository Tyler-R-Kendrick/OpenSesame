/**
 * Where a request waits for its answer.
 *
 * The store is the only mutable thing in this package, and it holds the one
 * piece of state that cannot be recomputed from the response: whether this
 * request has already been settled. Everything else a verifier checks is a
 * pure function of the bytes in front of it — signatures, digests, expiry —
 * and would give the same answer to the same VP forever. "Has this VP already
 * been spent" cannot be answered that way, so it is answered here.
 *
 * That makes {@link RequestSessionStore.consume} the load-bearing method, and
 * its contract is narrower than it looks: it must be a *compare-and-set*, not
 * a read followed by a write. Two responses for one `state` can arrive
 * concurrently — that is the cheapest way to attack a single-use rule — and a
 * store that reads `consumedAt`, finds it null, and then writes will let both
 * through. Exactly one caller may see `true`.
 *
 * The interface is injectable because the real deployment settles sessions in
 * a database where that compare-and-set is
 * `UPDATE ... WHERE state = $1 AND consumed_at IS NULL RETURNING 1`, and this
 * package must not carry a database dependency to say so. The in-memory
 * implementation below is a complete, bounded store — good enough for a single
 * process and for every test in this package — and its `consume` is atomic for
 * the boring reason that JavaScript does not preempt between two statements.
 */

import { refuse } from "./errors.js";
import type { AuthorizationRequest } from "./request.js";

/**
 * A stored request plus its settlement state.
 *
 * A consumed session is *kept*, not deleted. Deleting it would make a replayed
 * response indistinguishable from a response to a request that never existed,
 * and those two deserve different answers: one is an attack on this session,
 * the other is noise. The record is dropped when it expires, at which point a
 * late replay is `request_expired` and equally uninteresting.
 */
export interface RequestSessionRecord {
  readonly request: AuthorizationRequest;
  readonly consumedAt: Date | null;
}

export interface RequestSessionStore {
  /**
   * Store a freshly built request. Rejects a `state` that already exists —
   * silently overwriting one would let a second request cancel the first's
   * single-use property.
   */
  create(request: AuthorizationRequest): Promise<void>;

  /** The record for a `state`, or null. Does not settle anything. */
  lookup(state: string): Promise<RequestSessionRecord | null>;

  /**
   * Atomically transition open → consumed.
   *
   * `true` exactly once per session, for the caller that won. `false` for a
   * session that was already consumed and for a session that does not exist;
   * the caller has already distinguished those cases via {@link lookup} and
   * does not need this method to do it again.
   */
  consume(state: string, at: Date): Promise<boolean>;
}

/** Default ceiling: enough for a busy verifier, small enough to bound memory. */
const DEFAULT_MAX_SESSIONS = 10_000;

export interface InMemoryRequestSessionStoreOptions {
  readonly maxSessions?: number | undefined;
}

/**
 * A bounded in-memory store.
 *
 * The bound matters more than it appears to. `create` is reachable by anyone
 * who can ask this verifier to start a presentation, so an unbounded `Map`
 * keyed by a random `state` is a remote memory-exhaustion primitive with no
 * authentication in front of it. Two mechanisms keep it finite: expired
 * records are swept on every write, and when the map is still full afterwards
 * the oldest insertion is evicted.
 *
 * Eviction is a real, accepted loss: a legitimate response whose session was
 * evicted is refused as `state_unknown`. That is the correct trade — the
 * alternative is refusing *new* requests under load, which converts a memory
 * bound into a denial of service against every user at once instead of the
 * oldest one.
 */
export class InMemoryRequestSessionStore implements RequestSessionStore {
  readonly #records = new Map<string, RequestSessionRecord>();
  readonly #maxSessions: number;

  constructor(options: InMemoryRequestSessionStoreOptions = {}) {
    const max = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    if (!Number.isInteger(max) || max <= 0) {
      refuse("malformed_presentation", "request_construction");
    }
    this.#maxSessions = max;
  }

  get size(): number {
    return this.#records.size;
  }

  async create(request: AuthorizationRequest): Promise<void> {
    this.#sweep(request.createdAt);
    if (this.#records.has(request.state)) {
      refuse("presentation_replayed", "session_lookup");
    }
    while (this.#records.size >= this.#maxSessions) {
      // Map iteration is insertion-ordered, so the first key is the oldest.
      const oldest = this.#records.keys().next();
      if (oldest.done === true) break;
      this.#records.delete(oldest.value);
    }
    this.#records.set(request.state, { request, consumedAt: null });
  }

  async lookup(state: string): Promise<RequestSessionRecord | null> {
    return this.#records.get(state) ?? null;
  }

  async consume(state: string, at: Date): Promise<boolean> {
    const record = this.#records.get(state);
    if (record === undefined || record.consumedAt !== null) return false;
    // Read and write with nothing awaited between them: this is the whole of
    // the compare-and-set on a single-threaded runtime. A database-backed
    // implementation must reproduce it in one statement.
    this.#records.set(state, { request: record.request, consumedAt: at });
    return true;
  }

  #sweep(now: Date): void {
    for (const [state, record] of this.#records) {
      if (record.request.expiresAt.getTime() <= now.getTime()) {
        this.#records.delete(state);
      }
    }
  }
}
