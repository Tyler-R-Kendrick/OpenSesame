/**
 * The whole road over a real WebSocket: the owner's session and the terminal
 * both reach the same NATS-protocol server through the official client, with
 * no carriers injected into the command. Only the server is a stand-in
 * (`MiniNats`, not nats-server).
 */
import { approveAs } from "@opensesame/app-core/lib/live/device-approval.test-support.js";
import { settle } from "@opensesame/app-core/lib/live/live-clock.fixture.js";
import { endHosting } from "@opensesame/app-core/lib/live/session.js";
import { describe, expect, it, vi } from "vitest";
import { natsNodeCarriers } from "./live-nats.js";
import { MiniNats } from "./mini-nats.test-support.js";
import {
  VAULT_SECRET,
  execute,
  host,
  linkOf,
  useSessionWorld,
} from "./session-hosted.test-support.js";

const world = useSessionWorld();

describe("session over a real relay connection", () => {
  it("lists the connections, and the seat is gone from the owner's tab when it returns", async () => {
    world.bind();
    const server = await MiniNats.start();
    const ownerCarriers = natsNodeCarriers(undefined, 0);
    try {
      const owner = await host(ownerCarriers, {
        routes: {
          addresses: [],
          ice: [],
          relay: false,
          carriers: [{ kind: "nats", url: server.url }],
        },
      });
      // No carriers injected: the command opens the link's relay itself.
      const running = execute(
        world,
        ["session", linkOf(owner), "list", "--timeout", "20"],
        {},
      );
      await vi.waitFor(
        () => expect(owner.state.devices.pending).toHaveLength(1),
        { timeout: 10_000 },
      );
      const [pending] = owner.state.devices.pending;
      expect(owner.state.guests[0]).toMatchObject({
        kind: "device",
        state: "joined",
      });
      await approveAs(owner.devices, pending?.id ?? "", {
        connections: ["c-github"],
        minutes: 5,
      });
      const ran = await running;
      expect(ran.code).toBe(0);
      expect(ran.out).toContain("c-github");
      expect(ran.err).toContain(pending?.userCode ?? "no code");
      // The command waited for its goodbye to reach the relay.
      await vi.waitFor(() => expect(owner.state.devices.grants).toEqual([]), {
        timeout: 5_000,
      });
      // What the relay carried is sealed: none of the words, no secret.
      const wire = server.published.map((entry) => entry.text).join("\n");
      expect(server.published.length).toBeGreaterThan(3);
      for (const word of [
        "c-github",
        "GitHub",
        "provider.read",
        pending?.userCode ?? "no code",
        VAULT_SECRET,
      ])
        expect(wire).not.toContain(word);
    } finally {
      endHosting();
      await settle(5);
      await ownerCarriers.settled();
      await server.stop();
    }
  });
});
