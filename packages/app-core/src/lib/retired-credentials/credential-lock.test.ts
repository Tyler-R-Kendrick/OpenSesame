/** Faithful ifAvailable port control; native/browser delivery is separate proof. */
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LockManagerLike } from "../../ports.js";
import {
  CREDENTIAL_LOCK_NAME,
  exclusive,
  retiredCredentialStorageSeams,
} from "./credential-lock.js";
const original = { ...retiredCredentialStorageSeams };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function lockPort() {
  let held = false;
  const requests: { name: string; options: LockOptions }[] = [];
  // Models only the exact three-argument ifAvailable form this helper uses.
  const port: LockManagerLike = {
    request: async <T>(
      name: string,
      options: LockOptions | LockGrantedCallback,
      work?: LockGrantedCallback,
    ): Promise<T> => {
      const parsed = z
        .object({ mode: z.literal("exclusive"), ifAvailable: z.literal(true) })
        .strict()
        .parse(options);
      if (!work) throw new Error("Unsupported lock request.");
      requests.push({ name, options: parsed });
      if (held) return work(null);
      held = true;
      try {
        return await work({ name, mode: "exclusive" });
      } finally {
        held = false;
      }
    },
  };
  return { port, requests, held: () => held };
}
afterEach(() => {
  Object.assign(retiredCredentialStorageSeams, original);
  vi.restoreAllMocks();
});
it("refuses absent cross-tab locking without running work, then recovers", async () => {
  retiredCredentialStorageSeams.locks = () => undefined;
  const work = vi.fn(async () => "done");
  await expect(exclusive(work)).rejects.toThrow(/Cross-tab/);
  expect(work).not.toHaveBeenCalled();
  const locks = lockPort();
  retiredCredentialStorageSeams.locks = () => locks.port;
  await expect(exclusive(work)).resolves.toBe("done");
});
it("refuses an existing external holder immediately without queueing", async () => {
  const locks = lockPort();
  retiredCredentialStorageSeams.locks = () => locks.port;
  const finish = deferred();
  const pending = locks.port.request(
    CREDENTIAL_LOCK_NAME,
    { mode: "exclusive", ifAvailable: true },
    async () => finish.promise,
  );
  const work = vi.fn(async () => {});
  try {
    await expect(exclusive(work)).rejects.toThrow(/already running/);
    expect(work).not.toHaveBeenCalled();
  } finally {
    finish.resolve();
    await pending;
  }
  await expect(exclusive(async () => "next")).resolves.toBe("next");
});
it("holds one lock across awaited refresh, collision and commit without local queueing", async () => {
  const locks = lockPort();
  retiredCredentialStorageSeams.locks = () => locks.port;
  const stages = [deferred(), deferred(), deferred()];
  const entered = [deferred(), deferred(), deferred()];
  const pending = exclusive(async () => {
    for (let i = 0; i < stages.length; i++) {
      expect(locks.held()).toBe(true);
      entered[i]?.resolve();
      await stages[i]?.promise;
    }
    return "committed";
  });
  try {
    for (let i = 0; i < stages.length; i++) {
      await entered[i]?.promise;
      await expect(exclusive(async () => "queued")).rejects.toThrow(
        /already running/,
      );
      expect(locks.requests).toHaveLength(1);
      stages[i]?.resolve();
    }
    await expect(pending).resolves.toBe("committed");
  } finally {
    for (const stage of stages) stage.resolve();
    await pending;
  }
  expect(locks.requests).toEqual([
    {
      name: CREDENTIAL_LOCK_NAME,
      options: { mode: "exclusive", ifAvailable: true },
    },
  ]);
  expect(locks.held()).toBe(false);
});
it("releases both local and cross-tab locks when refresh/check/commit work fails", async () => {
  const locks = lockPort();
  retiredCredentialStorageSeams.locks = () => locks.port;
  for (const stage of ["refresh", "collision", "durable commit"]) {
    await expect(
      exclusive(async () => {
        throw new Error(stage);
      }),
    ).rejects.toThrow(stage);
    expect(locks.held()).toBe(false);
    await expect(exclusive(async () => "recovered")).resolves.toBe("recovered");
  }
});
