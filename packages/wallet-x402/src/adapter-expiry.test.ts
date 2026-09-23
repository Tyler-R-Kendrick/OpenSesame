import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  X402PreparedCapacityError,
  type X402SettlementPort,
  X402_MAX_PREPARED_SLOTS,
  X402_PREPARED_TTL_MS,
  executeX402Payment,
  prepareX402Payment,
  sweepExpiredX402Payments,
} from "./adapter.js";
import type { LocalExactRuntime } from "./exact-settle.js";

const settlement: X402SettlementPort = {
  createPayload: async (runtime) => ({
    ref: "inner",
    payload: { x402Version: 2 as const, accepted: {}, payload: {} },
    requirements: {},
    runtime,
  }),
  settle: async () => ({ success: true, transaction: "0xabc" }),
};

const runtime: LocalExactRuntime = {
  rpcUrl: "http://127.0.0.1:8545",
  chainId: 31337,
  payerPrivateKey: "0x01",
  facilitatorPrivateKey: "0x02",
  asset: "0x03",
  payTo: "0x04",
  amount: "100",
  network: "eip155:31337",
};

function hold() {
  const events: string[] = [];
  return {
    events,
    handle: {
      reservedAmount: "100",
      commit: () => {
        events.push("commit");
      },
      release: () => {
        events.push("release");
      },
    },
  };
}

const prepare = (handle: ReturnType<typeof hold>["handle"]) =>
  prepareX402Payment({ runtime, reservation: handle, settlement });

/** Let the fire-and-forget releases a sweep schedules run. */
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe("x402 prepared refs that are never executed", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T00:00:00.000Z"));
    // Module state outlives a test; start every test from an empty table.
    sweepExpiredX402Payments(Number.POSITIVE_INFINITY);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("releases the hold once when the expiry timer fires", async () => {
    const held = hold();
    await prepare(held.handle);
    await vi.advanceTimersByTimeAsync(X402_PREPARED_TTL_MS - 1);
    expect(held.events).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(held.events).toEqual(["release"]);
    // A later sweep, and a later prepare's sweep, find nothing left to release.
    expect(sweepExpiredX402Payments()).toBe(0);
    await prepare(hold().handle);
    await drain();
    expect(held.events).toEqual(["release"]);
  });

  it("releases the hold once when a later prepare sweeps it", async () => {
    const held = hold();
    const prepared = await prepare(held.handle);
    // The clock moves without the timer firing (a suspended process).
    vi.setSystemTime(Date.parse(prepared.expiresAt) + 1);
    await prepare(hold().handle);
    await drain();
    expect(held.events).toEqual(["release"]);
    const late = await executeX402Payment({ preparedRef: prepared.ref });
    expect(late.status).toBe("failed");
    await vi.runAllTimersAsync();
    expect(held.events).toEqual(["release"]);
  });

  it("never releases twice when execute races the sweep", async () => {
    const held = hold();
    const prepared = await prepare(held.handle);
    vi.setSystemTime(Date.parse(prepared.expiresAt));
    const [executed] = await Promise.all([
      executeX402Payment({ preparedRef: prepared.ref }),
      Promise.resolve().then(() => sweepExpiredX402Payments()),
    ]);
    await vi.runAllTimersAsync();
    await drain();
    expect(executed).toEqual({
      status: "failed",
      detail: "PREPARED_REF_EXPIRED",
    });
    expect(held.events).toEqual(["release"]);
  });

  it("never releases a ref that executed before it expired", async () => {
    const held = hold();
    const prepared = await prepare(held.handle);
    await executeX402Payment({ preparedRef: prepared.ref });
    await vi.advanceTimersByTimeAsync(X402_PREPARED_TTL_MS * 2);
    expect(sweepExpiredX402Payments()).toBe(0);
    expect(held.events).toEqual(["commit"]);
  });

  it("refuses new prepares past the cap until expired refs are swept", async () => {
    for (let i = 0; i < X402_MAX_PREPARED_SLOTS; i += 1) {
      await prepare(hold().handle);
    }
    const refused = hold();
    await expect(prepare(refused.handle)).rejects.toBeInstanceOf(
      X402PreparedCapacityError,
    );
    // Prepare threw, so the hold is still the caller's: untouched here.
    expect(refused.events).toEqual([]);
    await vi.advanceTimersByTimeAsync(X402_PREPARED_TTL_MS);
    await expect(prepare(hold().handle)).resolves.toHaveProperty("ref");
  });
});
