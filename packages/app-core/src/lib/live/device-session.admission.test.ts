/**
 * Devices in an invite session, and in a session that does not offer them
 * (ADR 0195): who is seated, and what a device is told before anything is
 * contacted.
 */
import { describe, expect, it, vi } from "vitest";
import { DeviceJoinError, joinAsDevice } from "./device-session.js";
import {
  bindPort,
  host,
  joinDevice,
  profile,
  useDeviceSession,
} from "./device-session.test-support.js";
import { settle } from "./live-clock.fixture.js";
import { FakeBus, FakeNet } from "./live-fakes.js";
import { joinLive, startHosting } from "./session.js";

useDeviceSession();

describe("a device in an invite session", () => {
  it("waits for the owner to let it in, and for the code", async () => {
    bindPort();
    const bus = new FakeBus();
    const owner = await host(bus, { admission: "invite" });
    const session = await joinDevice(owner, bus);
    expect(owner.state.guests[0]?.state).toBe("joined");
    await session.leave();
  });

  it("reads the code however the person typed it", async () => {
    bindPort();
    const bus = new FakeBus();
    const owner = await host(bus, { admission: "invite" });
    if (owner.code === null) throw new Error("an invite session has a code");
    const typed = owner.code.toLowerCase().replace("-", " ");
    const joining = joinAsDevice({
      link: owner.link,
      code: typed,
      name: "laptop",
      carriers: bus.factory(),
    });
    for (let round = 0; round < 40; round += 1) {
      const asking = owner.state.guests.find((g) => g.state === "asking");
      if (asking) await owner.admit(asking.key);
      await settle(5);
    }
    const session = await joining;
    expect(owner.state.misses).toBe(0);
    expect(owner.state.guests[0]?.state).toBe("joined");
    await session.leave();
  });

  it("refuses a code that cannot be one before anything is contacted", async () => {
    bindPort();
    const bus = new FakeBus();
    const owner = await host(bus, { admission: "invite" });
    await expect(
      joinAsDevice({
        link: owner.link,
        code: "hello",
        name: "laptop",
        carriers: bus.factory(),
      }),
    ).rejects.toMatchObject({ code: "bad_code" });
    expect(bus.specs).toHaveLength(1);
    expect(owner.state.misses).toBe(0);
  });

  it("is not seated without the right code", async () => {
    bindPort();
    const bus = new FakeBus();
    const owner = await host(bus, { admission: "invite" });
    const joining = joinAsDevice({
      link: owner.link,
      code: "BCDF-GHJK",
      name: "stranger",
      carriers: bus.factory(),
      signal: AbortSignal.timeout(50),
    });
    const aborted = expect(joining).rejects.toMatchObject({ code: "aborted" });
    await settle();
    expect(owner.state.guests).toEqual([]);
    expect(owner.state.misses).toBe(1);
    await aborted;
  });
});

describe("a session that does not offer it", () => {
  it("never seats a device when the owner did not allow devices", async () => {
    bindPort();
    const bus = new FakeBus();
    const owner = await host(bus, { devices: false });
    const joining = joinAsDevice({
      link: owner.link,
      code: owner.code,
      name: "laptop",
      carriers: bus.factory(),
      signal: AbortSignal.timeout(50),
    });
    const aborted = expect(joining).rejects.toMatchObject({ code: "aborted" });
    await settle();
    expect(owner.state.guests).toEqual([]);
    await aborted;
  });

  it("refuses a link that names no relay before contacting anything", async () => {
    bindPort();
    const bus = new FakeBus();
    const owner = await host(bus, { routes: profile("off") });
    const asked = new FakeBus();
    await expect(
      joinAsDevice({
        link: owner.link,
        code: owner.code,
        name: "laptop",
        carriers: asked.factory(),
      }),
    ).rejects.toMatchObject({ code: "no_relay" });
    expect(asked.specs).toEqual([]);
    const direct = await host(new FakeBus(), {
      routes: { addresses: [], ice: [], relay: false, carriers: [] },
    });
    const contacted = new FakeBus();
    await expect(
      joinAsDevice({
        link: direct.link,
        code: direct.code,
        name: "laptop",
        carriers: contacted.factory(),
      }),
    ).rejects.toBeInstanceOf(DeviceJoinError);
    expect(contacted.specs).toEqual([]);
  });

  it("lets a browser join the same session as it always did", async () => {
    bindPort();
    const bus = new FakeBus();
    const net = new FakeNet();
    const owner = await startHosting({
      title: "Team",
      scope: { kind: "vault" },
      policy: "read",
      admission: "open",
      minutes: 30,
      transport: net.transports(),
      routes: profile(),
      carriers: bus.factory(),
      devices: true,
    });
    await settle();
    const guest = await joinLive({
      link: owner.link,
      code: owner.code,
      name: "Ada",
      note: "",
      transport: net.transports(),
      useRoutes: true,
      carriers: bus.factory(),
    });
    for (let i = 0; i < 40 && guest.status.at !== "joined"; i += 1)
      await settle(5);
    expect(guest.status.at).toBe("joined");
    expect(owner.state.guests[0]?.kind).toBe("person");
    // And it cannot make a device's asks.
    const refused = vi.fn();
    guest.onDevice(refused);
    expect(guest.sendDevice({ t: "dev.begin", req: "b1", want: [] })).toBe(
      true,
    );
    await settle();
    expect(refused).toHaveBeenCalledWith({
      t: "dev.error",
      req: "b1",
      error: "access_denied",
    });
    expect(owner.state.devices.pending).toEqual([]);
  });
});
