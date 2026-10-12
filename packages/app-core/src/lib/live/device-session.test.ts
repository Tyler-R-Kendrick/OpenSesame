import { describe, expect, it } from "vitest";
/**
 * A device joins a hosted session over the owner's NATS relay, asks for
 * authority, and uses the connections the owner picked (ADR 0195) — the
 * whole road, through the real pairing, the real sealed seat channel and the
 * real broker, with only the network faked.
 */
import { approveAs } from "./device-approval.test-support.js";
import { DeviceError } from "./device-client.js";
import {
  VAULT_SECRET,
  bindPort,
  github,
  host,
  joinDevice,
  pendingRequest,
  profile,
  useDeviceSession,
} from "./device-session.test-support.js";
import { settle } from "./live-clock.fixture.js";
import { FakeBus, FakeNet } from "./live-fakes.js";
import { endHosting, startHosting } from "./session.js";

useDeviceSession();

describe("a device in an open session", () => {
  it("asks, is allowed by the owner, lists and calls — and the relay sees none of it", async () => {
    bindPort();
    const bus = new FakeBus();
    const owner = await host(bus);
    const session = await joinDevice(owner, bus);
    expect(owner.state.guests[0]).toMatchObject({
      kind: "device",
      name: "work laptop",
      state: "joined",
    });

    let shown = "";
    const authorized = session.client.authorize({
      want: ["c-github"],
      onCode: (view) => {
        shown = view.userCode;
      },
    });
    const pending = await pendingRequest(owner);
    // The owner compares the code on their screen with the device's.
    expect(pending.userCode).toBe(shown);
    expect(pending.want).toEqual(["c-github"]);
    expect(
      await approveAs(owner.devices, pending.id, {
        connections: ["c-github"],
        minutes: 15,
      }),
    ).toBe("approved");
    const granted = await authorized;
    expect(granted.connections.map((entry) => entry.id)).toEqual(["c-github"]);

    expect(
      (await session.client.connections()).map((entry) => entry.id),
    ).toEqual(["c-github"]);
    const result = await session.client.call(
      "c-github",
      "provider.repositories.read",
      {},
    );
    expect(result.items).toEqual([
      { id: "acme/api", label: "acme/api", url: "https://x.test/acme/api" },
    ]);
    await expect(
      session.client.call("c-linear", "provider.read"),
    ).rejects.toMatchObject({ code: "access_denied" });

    // What the owner's screen can show of it, and nothing more.
    expect(owner.state.log.map((entry) => entry.what)).toEqual([
      "invoke",
      "denied",
    ]);
    // A relay that carries every frame sees none of the words.
    const seen = bus.seen.map(({ frame }) => frame).join("\n");
    for (const word of [
      "acme/api",
      "GitHub",
      "provider.repositories.read",
      shown,
      "work laptop",
      VAULT_SECRET,
    ])
      expect(seen).not.toContain(word);
    await session.leave();
  });

  it("shows a device nothing of the owner's vault, and gives it no value", async () => {
    bindPort();
    const bus = new FakeBus();
    const owner = await startHosting({
      title: "Team",
      scope: { kind: "vault" },
      policy: "edit",
      admission: "open",
      minutes: 30,
      transport: new FakeNet().transports(),
      routes: profile(),
      carriers: bus.factory(),
      devices: true,
    });
    await settle();
    const session = await joinDevice(owner, bus);
    const status = session.guest.status;
    expect(status.at === "joined" ? status.catalog.items : null).toEqual([]);
    expect(
      await session.guest.request("reveal", github.id, "password"),
    ).toBeNull();
    expect(await session.guest.edit(github.id, "password", "x")).toBeNull();
    await session.leave();
  });

  it("is told no, and the owner's refusal ends the wait", async () => {
    bindPort();
    const bus = new FakeBus();
    const owner = await host(bus);
    const session = await joinDevice(owner, bus);
    const authorized = session.client.authorize();
    const pending = await pendingRequest(owner);
    owner.devices?.deny(pending.id);
    await expect(authorized).rejects.toMatchObject({ code: "access_denied" });
    await expect(session.client.connections()).rejects.toMatchObject({
      code: "access_denied",
    });
    await session.leave();
  });

  it("loses its grant when the owner revokes it", async () => {
    bindPort();
    const bus = new FakeBus();
    const owner = await host(bus);
    const session = await joinDevice(owner, bus);
    const authorized = session.client.authorize();
    const pending = await pendingRequest(owner);
    await approveAs(owner.devices, pending.id, {
      connections: ["c-github"],
      minutes: 5,
    });
    await authorized;
    const [grant] = owner.state.devices.grants;
    owner.devices?.revoke(grant?.id ?? "");
    await expect(
      session.client.call("c-github", "provider.read"),
    ).rejects.toMatchObject({ code: "access_denied" });
    await session.leave();
  });

  it("hears nothing more once the owner ends the session", async () => {
    bindPort();
    const bus = new FakeBus();
    const owner = await host(bus);
    const session = await joinDevice(owner, bus);
    const authorized = session.client.authorize();
    const pending = await pendingRequest(owner);
    await approveAs(owner.devices, pending.id, {
      connections: ["c-github"],
      minutes: 5,
    });
    await authorized;
    endHosting();
    await settle();
    await expect(
      session.client.call("c-github", "provider.read"),
    ).rejects.toBeInstanceOf(DeviceError);
    expect(session.guest.status.at).toBe("ended");
  });

  it("drops the grant with the seat", async () => {
    bindPort();
    const bus = new FakeBus();
    const owner = await host(bus);
    const session = await joinDevice(owner, bus);
    const authorized = session.client.authorize();
    const pending = await pendingRequest(owner);
    await approveAs(owner.devices, pending.id, {
      connections: ["c-github"],
      minutes: 5,
    });
    await authorized;
    expect(owner.state.devices.grants).toHaveLength(1);
    await session.leave();
    await settle();
    expect(owner.state.devices.grants).toEqual([]);
  });
});
