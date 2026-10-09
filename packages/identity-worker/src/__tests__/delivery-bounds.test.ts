import { DELIVERY_LEASE_MS, MemoryRepositories } from "@opensesame/database";
import {
  CHANNEL_CAPABILITIES,
  type NotificationDelivery,
} from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DELIVERY_CONCURRENCY,
  DELIVERY_DEADLINE_MS,
  DELIVERY_PER_PRINCIPAL,
  DeliveryDeadlineError,
  mapBounded,
  withDeadline,
  worstCasePassMs,
} from "../bounded.js";
import {
  type ChannelAdapter,
  type ChannelDeliveryOutcome,
  deliverNotifications,
  registryFromAdapters,
} from "../notifications.js";

/**
 * One receiver that never answers must not stall the queue. The dispatcher
 * awaited every send in turn, so a few black-holed subscriptions or webhooks
 * were a tax on every tenant; these pin the three bounds that replaced it.
 */

const NOW = new Date("2026-10-04T12:00:00.000Z");

afterEach(() => {
  vi.useRealTimers();
});

describe("the bounds", () => {
  it("leave the delivery lease far longer than the slowest possible pass", () => {
    expect(worstCasePassMs()).toBeLessThanOrEqual(DELIVERY_LEASE_MS / 2);
  });

  it("run at most `concurrency` at once and `perKey` per key, in order", async () => {
    let inFlight = 0;
    let peak = 0;
    const perKey = new Map<string, number>();
    let peakPerKey = 0;
    const items = ["a", "a", "a", "a", "b", "b", "c", "c", "d", "e"];
    const started: string[] = [];
    await mapBounded(
      items,
      { concurrency: 4, perKey: 2, keyOf: (item) => item },
      async (item) => {
        started.push(item);
        inFlight += 1;
        perKey.set(item, (perKey.get(item) ?? 0) + 1);
        peak = Math.max(peak, inFlight);
        peakPerKey = Math.max(peakPerKey, perKey.get(item) ?? 0);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        perKey.set(item, (perKey.get(item) ?? 1) - 1);
      },
    );
    expect(started).toHaveLength(items.length);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peakPerKey).toBeLessThanOrEqual(2);
  });

  it("runs everything and rethrows the first failure afterwards", async () => {
    const ran: number[] = [];
    await expect(
      mapBounded(
        [1, 2, 3, 4],
        { concurrency: 2, perKey: 2, keyOf: () => "k" },
        async (item) => {
          ran.push(item);
          if (item === 2) throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");
    expect(ran.sort()).toEqual([1, 2, 3, 4]);
  });

  it("gives up waiting at the deadline, and not before", async () => {
    vi.useFakeTimers();
    const never = new Promise<string>(() => undefined);
    const waiting = expect(withDeadline(never, 1_000)).rejects.toBeInstanceOf(
      DeliveryDeadlineError,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await waiting;
    await expect(withDeadline(Promise.resolve("ok"), 1_000)).resolves.toBe(
      "ok",
    );
  });
});

function delivery(id: string, principalId: string): NotificationDelivery {
  return {
    id,
    principalId,
    kind: "native_push",
    notificationClass: "authorization_request",
    eventType: "authority.invocation.requested",
    outboxEventId: `obx_${id}`,
    payload: {},
    confidentiality: "minimal",
    state: "pending",
    attempts: 0,
    nextAttemptAt: NOW,
    createdAt: NOW,
  };
}

/** An adapter whose sends for chosen principals wait until released. */
function gatedAdapter(slowFor: (principalId: string) => boolean) {
  const sent: string[] = [];
  const releases: (() => void)[] = [];
  const adapter: ChannelAdapter = {
    kind: "native_push",
    isConfigured: () => true,
    capabilities: () => CHANNEL_CAPABILITIES.native_push,
    render: () => ({}),
    deliver: async ({ delivery: row }): Promise<ChannelDeliveryOutcome> => {
      if (slowFor(row.principalId)) {
        await new Promise<void>((resolve) => releases.push(resolve));
      }
      sent.push(row.id);
      return { ok: true };
    },
  };
  return {
    adapter,
    sent,
    release: () => {
      for (const resolve of releases.splice(0)) resolve();
    },
  };
}

async function seeded(rows: NotificationDelivery[]) {
  const repos = new MemoryRepositories();
  for (const row of rows) await repos.notificationDeliveries.enqueue(row);
  return repos;
}

describe("a slow receiver in the dispatch pass", () => {
  it("cannot hold more of the pass than its share, so other principals still deliver", async () => {
    const slowRows = Array.from({ length: 12 }, (_, i) =>
      delivery(`slow_${i}`, "prn_slow"),
    );
    const fastRows = Array.from({ length: 6 }, (_, i) =>
      delivery(`fast_${i}`, `prn_fast_${i}`),
    );
    // The slow principal's rows are first in line.
    const repos = await seeded([...slowRows, ...fastRows]);
    const { adapter, sent, release } = gatedAdapter((p) => p === "prn_slow");
    const pass = deliverNotifications({
      repos,
      clock: () => NOW,
      adapters: registryFromAdapters([adapter]),
    });
    await vi.waitFor(() =>
      expect(sent.filter((id) => id.startsWith("fast_"))).toHaveLength(6),
    );
    // Everything slow is still waiting, and only its share of slots is taken.
    expect(sent.filter((id) => id.startsWith("slow_"))).toHaveLength(0);
    await vi.waitFor(() => {
      release();
      expect(sent).toHaveLength(18);
    });
    await pass;
    expect(DELIVERY_PER_PRINCIPAL).toBeLessThan(DELIVERY_CONCURRENCY);
  });

  it("is let go at the deadline and retried, not waited on forever", async () => {
    vi.useFakeTimers();
    const repos = await seeded([delivery("hang", "prn_a")]);
    const { adapter } = gatedAdapter(() => true);
    const pass = deliverNotifications({
      repos,
      clock: () => NOW,
      adapters: registryFromAdapters([adapter]),
    });
    await vi.advanceTimersByTimeAsync(DELIVERY_DEADLINE_MS);
    const result = await pass;
    expect(result).toMatchObject({ delivered: 0, failed: 1, dead: 0 });
    const all = await repos.notificationDeliveries.claimDue(
      10,
      new Date(NOW.getTime() + DELIVERY_LEASE_MS + 3_600_000),
    );
    expect(all[0]).toMatchObject({ id: "hang", attempts: 2 });
  });
});
