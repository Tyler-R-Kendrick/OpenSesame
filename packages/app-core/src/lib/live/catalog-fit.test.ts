/**
 * The catalog a joiner is sent has to fit the one frame the channel carries
 * (ADR 0150 §5): a vault at the limits is cut to fit, and a frame that still
 * does not go out ends the seat instead of counting the guest in.
 */
import { overlapCast } from "@opensesame/os-domain";
import { type VaultItem, createItem } from "@opensesame/vault-core";
import { afterEach, describe, expect, it } from "vitest";
import { LiveGuest } from "./guest.js";
import { LiveHost } from "./host.js";
import { settle } from "./live-clock.fixture.js";
import { FakeNet } from "./live-fakes.js";
import type { Catalog } from "./messages.js";
import { CATALOG_BUDGET, vaultCatalog } from "./vault-share.js";

function items(count: number, fields: number, text: string, label = "Field") {
  const made: VaultItem[] = [];
  for (let at = 0; at < count; at += 1) {
    const item = createItem("account", `Item ${at}`);
    item.fields = Array.from({ length: fields }, (_, field) => ({
      id: `f${field}`,
      name: label,
      value: text,
      hidden: false,
    }));
    made.push(item);
  }
  return made;
}

function catalogOf(held: readonly VaultItem[]): Catalog {
  return vaultCatalog({
    title: "Team",
    policy: "read",
    expiresAt: 1,
    scope: { kind: "vault" },
    items: () => held,
  });
}

function weight(catalog: Catalog): number {
  return new TextEncoder().encode(JSON.stringify({ t: "catalog", catalog }))
    .length;
}

describe("a catalog at the limits", () => {
  it("is left alone when it fits", () => {
    const catalog = catalogOf(items(5, 4, "x".repeat(2000)));
    expect(catalog.items).toHaveLength(5);
    expect(catalog.items[0]?.fields[0]?.value).toHaveLength(2000);
  });

  it("has its unconcealed text clipped to fit, every item still listed", () => {
    // 8 items x 32 fields x 16 KiB is 4 MiB: far past the frame.
    const catalog = catalogOf(items(8, 32, "y".repeat(16 * 1024)));
    expect(weight(catalog)).toBeLessThanOrEqual(CATALOG_BUDGET);
    expect(catalog.items).toHaveLength(8);
    const value = catalog.items[0]?.fields[0]?.value ?? "";
    expect(value.length).toBeGreaterThan(0);
    expect(value.length).toBeLessThan(16 * 1024);
    // Cut text says so, so a copy of it is not taken for the whole value.
    expect(value.endsWith("\u2026")).toBe(true);
  });

  it("counts bytes, not characters", () => {
    // Four bytes to a character, a few thousand of them.
    const catalog = catalogOf(items(40, 8, "\u{1F511}".repeat(600)));
    expect(weight(catalog)).toBeLessThanOrEqual(CATALOG_BUDGET);
  });

  it("is worked out once for a vault as it stands", () => {
    const held = items(3, 4, "x");
    const first = vaultCatalog({
      title: "T",
      policy: "read",
      expiresAt: 1,
      scope: { kind: "vault" },
      items: () => held,
    });
    const again = vaultCatalog({
      title: "T",
      policy: "read",
      expiresAt: 1,
      scope: { kind: "vault" },
      items: () => held,
    });
    expect(again).toBe(first);
    const changed = vaultCatalog({
      title: "T",
      policy: "read",
      expiresAt: 1,
      scope: { kind: "vault" },
      items: () => [...held],
    });
    expect(changed).not.toBe(first);
  });

  it("leaves out the last items only when names alone do not fit", () => {
    const catalog = catalogOf(items(200, 32, "z", "L".repeat(120)));
    expect(weight(catalog)).toBeLessThanOrEqual(CATALOG_BUDGET);
    expect(catalog.items.length).toBeGreaterThan(0);
    expect(catalog.items.length).toBeLessThan(200);
    // In order, from the front: what is left out is the tail.
    expect(catalog.items.map((item) => item.name)).toEqual(
      Array.from({ length: catalog.items.length }, (_, at) => `Item ${at}`),
    );
  });
});

const hosts: LiveHost[] = [];
const guests: LiveGuest[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.end();
  for (const guest of guests.splice(0)) guest.leave();
});

describe("a catalog frame the channel cannot carry", () => {
  it("ends the seat; the guest is never counted as joined", async () => {
    const net = new FakeNet();
    // Hand the host a catalog over the cap, as a bug in the builder would.
    const oversize: Catalog = {
      title: "T",
      policy: "read",
      expiresAt: Date.now() + 60_000,
      items: [
        {
          id: "a",
          name: "n".repeat(2 * 1024 * 1024),
          type: "account",
          fields: [],
        },
      ],
    };
    const host = await LiveHost.start({
      admission: "open",
      expiresAt: Date.now() + 60_000,
      catalog: () => oversize,
      readField: async () => null,
      transport: net.transport(),
    });
    hosts.push(host);
    const guest = new LiveGuest({
      link: host.link,
      code: null,
      name: "Ada",
      note: "",
      transport: net.transport(),
    });
    guests.push(guest);
    const received = await host.receive(await guest.start());
    if (received.kind !== "guest") throw new Error(received.kind);
    await host.admit(received.key);
    const reply = host.state.guests.find((g) => g.key === received.key)?.reply;
    await guest.accept(reply ?? "");
    await settle();
    const seat = host.state.guests.find((g) => g.key === received.key);
    expect(seat?.state).not.toBe("joined");
    expect(guest.status.at).not.toBe("joined");
  });
});

describe("a channel send", () => {
  it("reports a refusal instead of throwing it", async () => {
    const { PeerChannel } = await import("./webrtc.js");
    const refusing = Object.assign(new EventTarget(), {
      readyState: "open" as const,
      send: () => {
        throw new TypeError("message too large");
      },
      close: () => {},
    });
    // The test double carries only what a channel reader looks at.
    const asChannel: RTCDataChannel = overlapCast(refusing);
    const channel = new PeerChannel(asChannel);
    expect(channel.send({ t: "end" })).toBe(false);
  });
});
