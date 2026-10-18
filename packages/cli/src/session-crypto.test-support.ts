/** Drain real encrypted transport work before advancing the hosted fake clock. */
import { settle } from "@opensesame/app-core/lib/live/live-clock.fixture.js";
import * as sealing from "@opensesame/app-core/lib/live/seal.js";
import { vi } from "vitest";

export function observeSessionCrypto() {
  const pending = new Set<Promise<unknown>>();
  let started = 0;
  function track<T>(operation: Promise<T>): Promise<T> {
    started += 1;
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation),
    );
    return operation;
  }
  const seal = sealing.seal;
  const unseal = sealing.unseal;
  vi.spyOn(sealing, "seal").mockImplementation((...args) =>
    track(seal(...args)),
  );
  vi.spyOn(sealing, "unseal").mockImplementation((...args) =>
    track(unseal(...args)),
  );
  return async () => {
    for (;;) {
      const generation = started;
      await Promise.all([...pending]);
      // Delivery and ordered SeatChannel continuations start further crypto.
      await settle(1);
      if (pending.size === 0 && generation === started) return;
    }
  };
}
