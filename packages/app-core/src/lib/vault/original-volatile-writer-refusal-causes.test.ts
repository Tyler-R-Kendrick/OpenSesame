/** Genuine RAM/no-lock writer callbacks; these controls exercise refusal behavior, never grant authority. */
import { expect, it } from "vitest";
import { runOriginalVolatileWriterRequestData } from "./original-volatile-writer-request-data.js";

it.each([Number.NaN, -0, 0])(
  "preserves the exact original numeric rejection cause %s after accepted work drain",
  async (cause) => {
    const accepted = runOriginalVolatileWriterRequestData(
      undefined,
      undefined,
      "original-ram-refusal",
      () => {},
      () => Promise.reject(cause),
    );
    await expect(accepted).rejects.toBe(cause);
  },
);

it("retains the original object refusal identity rather than wrapping duplicate accepted failure", async () => {
  const cause = new Error("Original accepted work refused.");
  await expect(
    runOriginalVolatileWriterRequestData(
      undefined,
      undefined,
      "original-ram-refusal",
      () => {},
      () => Promise.reject(cause),
    ),
  ).rejects.toBe(cause);
});

it("successful work still refuses when its exact original delivery retires", async () => {
  const cause = new Error("Original callback retired.");
  let live = true;
  const original = () => {
    if (!live) throw cause;
  };
  await expect(
    runOriginalVolatileWriterRequestData(
      undefined,
      undefined,
      "original-ram-refusal",
      original,
      async () => {
        live = false;
        return "unusable-result";
      },
    ),
  ).rejects.toBe(cause);
});

it("refuses a shared lease before any original callback or work enters", async () => {
  let originalEntered = false;
  let workEntered = false;
  await expect(
    runOriginalVolatileWriterRequestData(
      undefined,
      undefined,
      "original-ram-refusal",
      () => {
        originalEntered = true;
      },
      async () => {
        workEntered = true;
      },
      { mode: "shared" },
    ),
  ).rejects.toThrow("Original writer requires an exclusive lease.");
  expect(originalEntered).toBe(false);
  expect(workEntered).toBe(false);
});

// This typed provider callback delivery is doubled; no browser lease or Root authority is asserted.
it.each([
  { child: 0, provider: -0 },
  { child: -0, provider: 0 },
])(
  "retains distinct signed-zero child $child and provider $provider refusals",
  async ({ child, provider }) => {
    const observed = { entered: false, settled: false };
    let observedChild: ErrorOptions | undefined;
    const locks: import("../../ports.js").LockManagerLike = {
      async request<T>(
        name: string,
        _options: LockOptions | LockGrantedCallback<T>,
        callback?: LockGrantedCallback<T>,
      ) {
        if (!callback) throw new Error("Original callback delivery missing.");
        try {
          await callback({ name, mode: "exclusive" });
        } catch (cause) {
          observedChild = { cause };
        } finally {
          observed.settled = true;
        }
        // Independent provider refusal follows the actual original callback settlement.
        throw provider;
      },
    };
    const accepted = runOriginalVolatileWriterRequestData(
      locks,
      locks.request,
      "original-signed-zero-refusal",
      () => {},
      () => {
        observed.entered = true;
        return Promise.reject(child);
      },
    );
    const outcome = await accepted.then(
      () => ({ status: "fulfilled" as const }),
      (cause: unknown) => ({ status: "rejected" as const, cause }),
    );
    expect(observed.entered).toBe(true);
    expect(observed.settled).toBe(true);
    expect(Object.is(observedChild?.cause, child)).toBe(true);
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected")
      throw new Error("Original independent failures missing.");
    expect(outcome.cause).toBeInstanceOf(AggregateError);
    if (!(outcome.cause instanceof AggregateError))
      throw new Error("Original signed-zero causes collapsed.");
    expect(outcome.cause.errors).toHaveLength(2);
    expect(Object.is(outcome.cause.errors[0], provider)).toBe(true);
    expect(Object.is(outcome.cause.errors[1], child)).toBe(true);
  },
);
