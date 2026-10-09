/** Ordinary promise ordering only; never receives a key, owner verdict or admission port. */
import { type TombWriteTurn, withTombWriteTurn } from "../vfs-write-order.js";
import type { StorePreferences } from "./store-preferences.js";
import { withBodyWriteLockOrBare } from "./vault-shared-locks.js";

export class StoreWriteQueue {
  #pending: Promise<void> = Promise.resolve();
  constructor() {
    Object.freeze(this);
  }
  pending = (): Promise<void> => this.#pending;
  assign = (pending: Promise<void>): void => {
    this.#pending = pending;
  };
  persistPreferences = (
    preferences: StorePreferences,
    tomb: string,
    currentTomb: () => string,
    completed: () => void,
  ): void => {
    this.assign(
      preferences.persist(tomb, this.pending(), currentTomb, completed),
    );
  };
  rootTurn = (
    tomb: string,
    prepare: () => Promise<void>,
    work: (turn: TombWriteTurn) => Promise<void>,
    completed: () => void,
    failed: () => void,
  ): Promise<void> =>
    this.enqueue(async () => {
      try {
        await withBodyWriteLockOrBare(tomb, () =>
          withTombWriteTurn(tomb, async (turn) => {
            await prepare();
            await work(turn);
            completed();
          }),
        );
      } catch (error) {
        failed();
        throw error;
      }
    });
  enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const run = this.#pending.then(work);
    this.#pending = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
