/** Actual publisher/crypto; only returned stream slots and method.call delivery are doubled. */
import { afterEach, expect, it } from "vitest";
import { atRestReady } from "./at-rest/key.js";
import { openOriginFile, sealOriginFile } from "./at-rest/origin-files.js";
import {
  fixture,
  name,
  restoreOriginPublicationFixture,
} from "./origin-file-publication-custody.test-support.js";
import { comparePublishOriginFile } from "./origin-file-publication.js";

afterEach(restoreOriginPublicationFixture);
function gate() {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { pending, release };
}
function refuse<T>(failures: readonly T[]) {
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(
      failures,
      "Original delivery control and cleanup failed.",
    );
}
it.each([
  { slot: "write", abortFailure: undefined },
  { slot: "close", abortFailure: undefined },
  {
    slot: "write",
    abortFailure: { cause: new Error("Actual abort refused.") },
  },
  { slot: "close", abortFailure: { cause: undefined } },
])(
  "retains delivered abort through $slot capture refusal",
  async ({ slot, abortFailure }) => {
    const entered = gate();
    const released = gate();
    const workCause = new Error("Actual writable slot delivery refused.");
    const f = fixture((stream) => {
      const abort = stream.abort;
      stream.abort = async () => {
        await abort();
        entered.release();
        await released.pending;
        if (abortFailure) throw abortFailure.cause;
      };
      Object.defineProperty(stream, slot, {
        configurable: true,
        get: () => {
          throw workCause;
        },
      });
    });
    let settled = false;
    const task = comparePublishOriginFile(
      name,
      null,
      "next",
      4096,
      () => {},
      f.directory,
    );
    const outcome = task.then(
      () => {
        settled = true;
        return { status: "fulfilled" as const };
      },
      (cause: unknown) => {
        settled = true;
        return { status: "rejected" as const, cause };
      },
    );
    const failures: unknown[] = [];
    let verified = false;
    try {
      await Promise.race([
        entered.pending,
        outcome.then(() => {
          throw new Error("Actual abort never entered.");
        }),
      ]);
      expect(settled).toBe(false);
      released.release();
      const result = await outcome;
      expect(result.status).toBe("rejected");
      if (result.status !== "rejected")
        throw new Error("Actual capture unexpectedly succeeded.");
      if (abortFailure) {
        expect(result.cause).toBeInstanceOf(AggregateError);
        if (!(result.cause instanceof AggregateError))
          throw new Error("Actual paired causes missing.");
        expect(result.cause.errors).toHaveLength(2);
        expect(result.cause.errors[0]).toBe(workCause);
        expect(result.cause.errors[1]).toBe(abortFailure.cause);
      } else expect(result.cause).toBe(workCause);
      expect(f.state.aborted).toBe(1);
      expect(f.state.closed).toBe(0);
      expect(f.files.has(name)).toBe(false);
      verified = true;
    } catch (cause) {
      failures.push(cause);
    } finally {
      released.release();
      const result = await outcome;
      if (!verified && result.status === "rejected")
        failures.push(result.cause);
    }
    refuse(failures);
  },
);
function poisonCall<T extends object>(method: T, invoked: () => void) {
  const original = Object.getOwnPropertyDescriptor(method, "call");
  const restore = () => {
    if (original) Object.defineProperty(method, "call", original);
    else if (!Reflect.deleteProperty(method, "call"))
      throw new Error("Actual method.call restoration failed.");
  };
  try {
    Object.defineProperty(method, "call", {
      configurable: true,
      value: async () => {
        invoked();
        throw new Error("Forged method.call executed.");
      },
    });
  } catch (cause) {
    try {
      restore();
    } catch (cleanup) {
      throw new AggregateError(
        [cause, cleanup],
        "Actual poison setup and restoration failed.",
      );
    }
    throw cause;
  }
  return restore;
}
it.each([false, true])(
  "fixed native dispatch ignores own call poisoning (write refusal %s)",
  async (failWrite) => {
    const f = fixture();
    f.state.failWrite = failWrite;
    const key = await atRestReady();
    const before = sealOriginFile(key, name, "old");
    f.files.set(name, before);
    const poisoned = new WeakSet<object>();
    const restore: (() => void)[] = [];
    let maliciousCalls = 0;
    let poisonedMethods = 0;
    const original = () => {
      const methods = [
        f.installed.originFiles,
        f.root.getFileHandle,
        f.root.isSameEntry,
        f.root.removeEntry,
        f.state.handle?.getFile,
        f.state.handle?.createWritable,
        f.state.handle?.isSameEntry,
        f.state.file?.text,
        f.state.stream?.write,
        f.state.stream?.close,
        f.state.stream?.abort,
      ];
      for (const method of methods) {
        if (!method || poisoned.has(method)) continue;
        restore.push(
          poisonCall(method, () => {
            maliciousCalls += 1;
          }),
        );
        poisoned.add(method);
        poisonedMethods += 1;
      }
    };
    const failures: unknown[] = [];
    const task = comparePublishOriginFile(
      name,
      "old",
      "next",
      4096,
      original,
      f.directory,
    );
    const outcome = task.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (cause: unknown) => ({ status: "rejected" as const, cause }),
    );
    try {
      if (failWrite)
        await expect(task).rejects.toThrow("Actual own write refused.");
      else (await task)();
      expect(poisonedMethods).toBeGreaterThan(0);
      expect(maliciousCalls).toBe(0);
      expect(f.state.aborted).toBe(failWrite ? 1 : 0);
      expect(f.state.closed).toBe(failWrite ? 0 : 1);
      if (failWrite) expect(f.files.get(name)).toBe(before);
      else
        expect(await openOriginFile(name, f.files.get(name) ?? "")).toBe(
          "next",
        );
    } catch (cause) {
      failures.push(cause);
    } finally {
      for (const close of restore.reverse()) {
        try {
          close();
        } catch (cause) {
          failures.push(cause);
        }
      }
    }
    const result = await outcome;
    if (failures.length && result.status === "rejected")
      failures.push(result.cause);
    refuse(failures);
  },
);
