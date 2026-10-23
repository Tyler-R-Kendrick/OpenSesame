import { createItem } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { kvGet, kvSeams } from "../kv.js";
import {
  ROTATION_EVENT_KEY,
  ROTATION_SCHEDULE_KEY,
  accountWebLoginOrigin,
  clearRotationQueue,
  enqueueManualRotation,
  loadRotationEvents,
  loadRotationSchedules,
  setRotationEnabled,
  syncRotationSchedules,
  tickRotationSchedules,
} from "./rotation-queue.js";
import { processRotationQueue, rotationSeams } from "./rotation-relay.js";

function account() {
  const item = createItem("account", "Private mail");
  item.username = "me@example.test";
  item.uris = [{ id: "u1", uri: "https://mail.example.test", match: "domain" }];
  return item;
}

beforeEach(() => {
  clearRotationQueue();
});

afterEach(() => {
  rotationSeams.relay = null;
  clearRotationQueue();
});

describe("rotation schedules", () => {
  it("targets only a credential-free https site", () => {
    const login = account();
    expect(accountWebLoginOrigin(login)).toBe("https://mail.example.test");
    login.uris = [
      { id: "u1", uri: "http://mail.example.test", match: "domain" },
    ];
    expect(accountWebLoginOrigin(login)).toBeNull();
    login.uris = [{ id: "u1", uri: "https://*.example.test", match: "domain" }];
    expect(accountWebLoginOrigin(login)).toBeNull();
  });

  it("gives automatic types a thirty-day schedule and leaves manual types alone", () => {
    const login = account();
    const card = createItem("card", "Test card");
    syncRotationSchedules(
      [login, card],
      "personal",
      new Date("2026-01-01T00:00:00Z"),
    );

    expect(loadRotationSchedules()).toEqual([
      expect.objectContaining({
        scope: "personal",
        itemId: login.id,
        typeId: "account",
        enabled: true,
        intervalDays: 30,
        lastRotatedAt: "2026-01-01T00:00:00.000Z",
        nextDueAt: "2026-01-31T00:00:00.000Z",
      }),
    ]);
  });

  it("keeps a disabled choice and prunes a deleted item", () => {
    const login = account();
    syncRotationSchedules(
      [login],
      "personal",
      new Date("2026-01-01T00:00:00Z"),
    );
    setRotationEnabled("personal", login.id, false);
    expect(loadRotationSchedules()[0]?.enabled).toBe(false);

    syncRotationSchedules([], "personal", new Date("2026-02-01T00:00:00Z"));
    expect(loadRotationSchedules()).toEqual([]);
  });
});

describe("the queue while locked", () => {
  it("queues one rolled-up event when a schedule is due", () => {
    const login = account();
    syncRotationSchedules(
      [login],
      "personal",
      new Date("2026-01-01T00:00:00Z"),
    );

    const first = tickRotationSchedules(new Date("2026-02-01T00:00:00Z"));
    const second = tickRotationSchedules(new Date("2026-02-02T00:00:00Z"));

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]?.id).toBe(first[0]?.id);
    expect(loadRotationEvents()).toHaveLength(1);
  });

  it("does not queue a disabled schedule", () => {
    const login = account();
    syncRotationSchedules(
      [login],
      "personal",
      new Date("2026-01-01T00:00:00Z"),
    );
    setRotationEnabled("personal", login.id, false);
    expect(tickRotationSchedules(new Date("2026-03-01T00:00:00Z"))).toEqual([]);
  });

  it("queues a manual rotation for any generator-backed type", () => {
    const card = createItem("card", "Test card");
    const event = enqueueManualRotation(
      card,
      "personal",
      new Date("2026-02-01T00:00:00Z"),
    );
    expect(event).toMatchObject({ itemId: card.id, reason: "manual" });
    expect(loadRotationEvents()).toHaveLength(1);
  });

  it("marks an event out of sync when no relay exists", async () => {
    const login = account();
    syncRotationSchedules(
      [login],
      "personal",
      new Date("2026-01-01T00:00:00Z"),
    );
    tickRotationSchedules(new Date("2026-02-01T00:00:00Z"));

    const remaining = await processRotationQueue(
      "personal",
      new Date("2026-02-01T00:00:00Z"),
    );
    expect(remaining[0]).toMatchObject({
      itemId: login.id,
      state: "out-of-sync",
    });
    expect(remaining[0]?.detail).toMatch(/relay/u);
  });

  it("completes the event and advances the schedule through a relay", async () => {
    const login = account();
    syncRotationSchedules(
      [login],
      "personal",
      new Date("2026-01-01T00:00:00Z"),
    );
    tickRotationSchedules(new Date("2026-02-01T00:00:00Z"));
    rotationSeams.relay = async () => ({ ok: true });

    const remaining = await processRotationQueue(
      "personal",
      new Date("2026-03-03T00:00:00Z"),
    );
    expect(remaining).toEqual([]);
    expect(loadRotationSchedules()[0]).toMatchObject({
      lastRotatedAt: "2026-03-03T00:00:00.000Z",
      nextDueAt: "2026-04-02T00:00:00.000Z",
    });
  });

  it("does not consume the event when the schedule write cannot land", async () => {
    const login = account();
    syncRotationSchedules(
      [login],
      "personal",
      new Date("2026-01-01T00:00:00Z"),
    );
    tickRotationSchedules(new Date("2026-02-01T00:00:00Z"));
    rotationSeams.relay = async () => ({ ok: true });
    const original = kvSeams.kvSetDurable;
    kvSeams.kvSetDurable = async (key, value) => {
      if (key === ROTATION_SCHEDULE_KEY) throw new Error("disk full");
      return original(key, value);
    };
    try {
      const remaining = await processRotationQueue(
        "personal",
        new Date("2026-03-03T00:00:00Z"),
      );
      // The write failed, so the event is retained as out-of-sync rather
      // than being reported as a completed rotation.
      expect(remaining).toEqual([
        expect.objectContaining({ state: "out-of-sync" }),
      ]);
      expect(loadRotationEvents()).toHaveLength(1);
    } finally {
      kvSeams.kvSetDurable = original;
    }
  });

  it("keeps another vault's schedule and queues each due event", async () => {
    const first = account();
    const second = account();
    syncRotationSchedules([first], "vault-a", new Date("2026-01-01T00:00:00Z"));
    syncRotationSchedules(
      [second],
      "vault-b",
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(loadRotationSchedules().map((entry) => entry.scope)).toEqual([
      "vault-a",
      "vault-b",
    ]);

    tickRotationSchedules(new Date("2026-02-01T00:00:00Z"));
    await processRotationQueue("vault-a", new Date("2026-02-01T00:00:00Z"));

    const events = loadRotationEvents();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: second.id,
          scope: "vault-b",
          state: "queued",
        }),
        expect.objectContaining({
          itemId: first.id,
          scope: "vault-a",
          state: "out-of-sync",
        }),
      ]),
    );
  });

  it("keys schedules and events by vault scope as well as item id", async () => {
    const login = account();
    syncRotationSchedules([login], "vault-a", new Date("2026-01-01T00:00:00Z"));
    syncRotationSchedules([login], "vault-b", new Date("2026-01-01T00:00:00Z"));

    expect(loadRotationSchedules()).toHaveLength(2);
    setRotationEnabled("vault-a", login.id, false);
    expect(
      loadRotationSchedules().find((row) => row.scope === "vault-a")?.enabled,
    ).toBe(false);
    expect(
      loadRotationSchedules().find((row) => row.scope === "vault-b")?.enabled,
    ).toBe(true);

    tickRotationSchedules(new Date("2026-02-01T00:00:00Z"));
    expect(loadRotationEvents().map((row) => row.scope)).toEqual(["vault-b"]);
  });

  it("drops a scheduled event when the account loses its https origin", () => {
    const login = account();
    syncRotationSchedules(
      [login],
      "personal",
      new Date("2026-01-01T00:00:00Z"),
    );
    tickRotationSchedules(new Date("2026-02-01T00:00:00Z"));
    expect(loadRotationEvents()).toHaveLength(1);

    login.uris = [];
    syncRotationSchedules(
      [login],
      "personal",
      new Date("2026-02-02T00:00:00Z"),
    );
    expect(loadRotationEvents()).toEqual([]);
  });

  it("keeps an event enqueued while the relay is awaiting", async () => {
    const first = account();
    const second = account();
    syncRotationSchedules(
      [first],
      "personal",
      new Date("2026-01-01T00:00:00Z"),
    );
    tickRotationSchedules(new Date("2026-02-01T00:00:00Z"));
    let release: (() => void) | undefined;
    let entered!: () => void;
    const awaited = new Promise<void>((resolve) => {
      entered = resolve;
    });
    rotationSeams.relay = async (event) => {
      if (event.itemId === first.id) {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return { ok: true };
    };

    const running = processRotationQueue(
      "personal",
      new Date("2026-03-03T00:00:00Z"),
    );
    await awaited;
    enqueueManualRotation(second, "personal", new Date("2026-03-03T00:00:00Z"));
    release?.();
    await running;
    expect(loadRotationEvents()).toEqual([
      expect.objectContaining({ itemId: second.id, reason: "manual" }),
    ]);
  });

  it("persists only metadata, never an item value", () => {
    const login = account();
    const method = login.methods[0];
    if (method?.type === "password") {
      login.methods = [{ ...method, secret: "hunter2-not-queued" }];
    }
    syncRotationSchedules(
      [login],
      "personal",
      new Date("2026-01-01T00:00:00Z"),
    );
    tickRotationSchedules(new Date("2026-02-01T00:00:00Z"));

    const stored = [
      kvGet(ROTATION_EVENT_KEY) ?? "",
      kvGet(ROTATION_SCHEDULE_KEY) ?? "",
    ].join(" ");
    expect(stored).not.toContain("hunter2-not-queued");
    expect(stored).not.toContain("Private mail");
  });
});
