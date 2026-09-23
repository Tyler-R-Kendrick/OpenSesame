import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  X402AccountingUnavailableError,
  X402InsufficientAvailableError,
  type X402SettlementOutcome,
  type X402SettlementPort,
  X402_PREPARED_TTL_MS,
  executeX402Payment,
  prepareX402Payment,
} from "./adapter.js";
import type { LocalExactRuntime } from "./exact-settle.js";

/** In-memory settlement: records calls, answers with a configured outcome. */
class FakeSettlement implements X402SettlementPort {
  outcome: X402SettlementOutcome = { success: true, transaction: "0xabc" };
  calls = 0;

  readonly createPayload = async (runtime: LocalExactRuntime) => ({
    ref: "inner",
    payload: { x402Version: 2 as const, accepted: {}, payload: {} },
    requirements: {},
    runtime,
  });

  readonly settle = async () => {
    this.calls += 1;
    return this.outcome;
  };
}

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

function reservation(reservedAmount = "100") {
  const events: string[] = [];
  return {
    events,
    handle: {
      reservedAmount,
      commit: () => {
        events.push("commit");
      },
      release: () => {
        events.push("release");
      },
    },
  };
}

describe("x402 adapter reservation and expiry", () => {
  let settle = new FakeSettlement();
  const prepare = (handle: ReturnType<typeof reservation>["handle"]) =>
    prepareX402Payment({ runtime, reservation: handle, settlement: settle });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T00:00:00.000Z"));
    settle = new FakeSettlement();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("requires a reservation, and one that covers the amount", async () => {
    const missing: Parameters<typeof prepareX402Payment>[0] = JSON.parse(
      JSON.stringify({ runtime }),
    );
    await expect(prepareX402Payment(missing)).rejects.toBeInstanceOf(
      X402AccountingUnavailableError,
    );
    const short = reservation("99");
    await expect(prepare(short.handle)).rejects.toBeInstanceOf(
      X402InsufficientAvailableError,
    );
    expect(short.events).toEqual([]);
  });

  it("commits the reservation once on a confirmed settlement", async () => {
    const held = reservation();
    const prepared = await prepare(held.handle);
    expect(Date.parse(prepared.expiresAt)).toBe(
      Date.now() + X402_PREPARED_TTL_MS,
    );
    const executed = await executeX402Payment({ preparedRef: prepared.ref });
    expect(executed.status).toBe("confirmed");
    expect(held.events).toEqual(["commit"]);
    const replay = await executeX402Payment({ preparedRef: prepared.ref });
    expect(replay.status).toBe("failed");
    expect(held.events).toEqual(["commit"]);
    expect(settle.calls).toBe(1);
  });

  it("refuses execution after expiresAt and releases the hold", async () => {
    const held = reservation();
    const prepared = await prepare(held.handle);
    vi.setSystemTime(Date.parse(prepared.expiresAt));
    const executed = await executeX402Payment({ preparedRef: prepared.ref });
    expect(executed).toEqual({
      status: "failed",
      detail: "PREPARED_REF_EXPIRED",
    });
    expect(settle.calls).toBe(0);
    expect(held.events).toEqual(["release"]);
    // The expired ref is spent; it cannot be retried into a settlement.
    expect(
      (await executeX402Payment({ preparedRef: prepared.ref })).status,
    ).toBe("failed");
    expect(settle.calls).toBe(0);
  });

  it("releases the hold when settlement reports failure", async () => {
    settle.outcome = { success: false, errorReason: "insufficient_funds" };
    const held = reservation();
    const prepared = await prepare(held.handle);
    const executed = await executeX402Payment({ preparedRef: prepared.ref });
    expect(executed).toEqual({
      status: "failed",
      detail: "insufficient_funds",
    });
    expect(held.events).toEqual(["release"]);
  });

  it("settles a ref once even when executed concurrently", async () => {
    const held = reservation();
    const prepared = await prepare(held.handle);
    const [a, b] = await Promise.all([
      executeX402Payment({ preparedRef: prepared.ref }),
      executeX402Payment({ preparedRef: prepared.ref }),
    ]);
    expect([a.status, b.status].sort()).toEqual(["confirmed", "failed"]);
    expect(settle.calls).toBe(1);
    expect(held.events).toEqual(["commit"]);
  });
});
