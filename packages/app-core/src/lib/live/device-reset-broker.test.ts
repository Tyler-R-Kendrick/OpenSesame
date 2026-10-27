import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unlockTomb } from "../vfs.js";
import type { DeviceReply } from "./device-messages.js";
import { allowDeviceReset } from "./device-reset-allow.js";
import { DeviceResetBroker } from "./device-reset-broker.js";
import {
  type DeviceResetRequest,
  type ResetAction,
  type ResetRequestDetails,
  resetRequestDigest,
} from "./device-reset-messages.js";
import { FAKE_CLOCK } from "./live-clock.fixture.js";

const ORIGIN = "https://accounts.example.test";
const OTHER = "https://other.example.test";
const NOW = 1_800_000_000_000;
const items = [
  { id: "item-1", name: "Example account", origins: [ORIGIN] },
  { id: "item-2", name: "Other account", origins: [OTHER] },
];

function details(action: ResetAction, item = "item-1"): ResetRequestDetails {
  return {
    origin: ORIGIN,
    item,
    runtime: "agent-browser",
    model: "decision-model",
    expiresAt: NOW + 60_000,
    actions: [action],
  };
}

async function request(
  req: string,
  action: ResetAction,
  item?: string,
): Promise<DeviceResetRequest> {
  const detail = details(action, item);
  return {
    t: "dev.reset",
    req,
    ...detail,
    digest: await resetRequestDigest(detail),
  };
}

function setup() {
  const replies: DeviceReply[] = [];
  const broker = new DeviceResetBroker({
    items: () => items,
    expiresAt: NOW + 120_000,
    now: () => NOW,
    changed: () => undefined,
  });
  const seat = broker.seat({ key: "seat-1", name: "Agent terminal" }, (reply) =>
    replies.push(reply),
  );
  const approve = async () => {
    const pending = broker.state.pending.at(-1);
    if (!pending) throw new Error("No pending reset approval");
    const tomb = `reset-approval-${crypto.randomUUID()}`;
    unlockTomb(tomb, (await mintVaultKey()).vaultKey);
    return allowDeviceReset(broker, tomb, pending.id);
  };
  return { broker, seat, replies, approve };
}

beforeEach(() => vi.useFakeTimers({ ...FAKE_CLOCK, now: NOW }));
afterEach(() => vi.useRealTimers());

describe("password reset device broker", () => {
  it("returns only domain-matching names and metadata before exact item grants", async () => {
    const world = setup();
    await world.seat.handle(
      await request(
        "metadata-request",
        "password_reset.domain_metadata.list",
        "metadata",
      ),
    );
    await expect(world.approve()).resolves.toBe("approved");
    const grant = world.replies.at(-1);
    expect(grant).toMatchObject({
      t: "dev.reset.grant",
      grant: "reset-metadata-request",
      items: [{ id: "item-1", name: "Example account", origins: [ORIGIN] }],
    });
    expect(JSON.stringify(grant)).not.toContain("item-2");

    await world.seat.handle(
      await request("item-request", "password_reset.item.use"),
    );
    await expect(world.approve()).resolves.toBe("approved");
    expect(world.broker.state.grants).toHaveLength(2);
    expect(world.replies.at(-1)).toMatchObject({
      grant: "reset-item-request",
      item: "item-1",
    });
    expect(world.replies.at(-1)).not.toHaveProperty("items");
    world.broker.end();
  });

  it("uses the existing domain rules for scoped metadata and exact item checks", async () => {
    items.push({
      id: "item-3",
      name: "Domain account",
      origins: ["example.test"],
    });
    try {
      const world = setup();
      await world.seat.handle(
        await request(
          "domain-request",
          "password_reset.domain_metadata.list",
          "metadata",
        ),
      );
      await expect(world.approve()).resolves.toBe("approved");
      expect(world.replies.at(-1)).toMatchObject({
        items: [
          { id: "item-1", origins: [ORIGIN] },
          { id: "item-3", origins: ["example.test"] },
        ],
      });
      expect(JSON.stringify(world.replies.at(-1))).not.toContain("item-2");
      await world.seat.handle(
        await request(
          "domain-item-request",
          "password_reset.item.use",
          "item-3",
        ),
      );
      await expect(world.approve()).resolves.toBe("approved");
      world.broker.end();
    } finally {
      items.pop();
    }
  });

  it("refuses unscoped or sibling item use and supports independent revocations", async () => {
    const world = setup();
    await world.seat.handle(
      await request("wrong-item", "password_reset.item.use", "item-2"),
    );
    expect(world.replies.at(-1)).toMatchObject({
      t: "dev.error",
      error: "access_denied",
    });
    expect(world.broker.state.pending).toHaveLength(0);

    for (const [req, action] of [
      ["browser-request", "password_reset.browser.drive"],
      ["runtime-request", "password_reset.runtime.execute"],
    ] as const) {
      await world.seat.handle(await request(req, action));
      await world.approve();
    }
    expect(world.broker.state.grants.map((grant) => grant.id)).toEqual([
      "reset-browser-request",
      "reset-runtime-request",
    ]);
    expect(world.broker.revoke("reset-browser-request")).toBe(true);
    expect(world.broker.state.grants.map((grant) => grant.id)).toEqual([
      "reset-runtime-request",
    ]);
    world.broker.end();
  });

  it("records human status without carrying a challenge value", async () => {
    const world = setup();
    await world.seat.handle(
      await request("human-request", "password_reset.human.takeover"),
    );
    await world.approve();
    await world.seat.handle({
      t: "dev.reset.status",
      req: "human-status",
      grant: "reset-human-request",
      status: "takeover_requested",
    });
    expect(world.replies.at(-1)).toEqual({
      t: "dev.reset.ack",
      req: "human-status",
    });
    expect(world.broker.state.grants[0]?.humanStatus).toBe(
      "takeover_requested",
    );
    expect(JSON.stringify(world.broker.state)).not.toContain("challenge-value");
    world.broker.end();
  });
});
