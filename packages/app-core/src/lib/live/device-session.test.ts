/**
 * A device joins a hosted session over the owner's NATS relay, asks for
 * authority, and uses the connections the owner picked (ADR 0195) — the
 * whole road, through the real pairing, the real sealed seat channel and the
 * real broker, with only the network faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { plainAccount } from "../account.test-support.js";
import { type ConnectionPort, bindConnectionPort } from "./connection-port.js";
import { DeviceError } from "./device-client.js";
import { DeviceJoinError, joinAsDevice } from "./device-session.js";
import type { LiveHost } from "./host.js";
import { settle } from "./live-clock.fixture.js";
import { FakeBus, FakeNet } from "./live-fakes.js";
import type { NatsSession } from "./nats-route.js";
import {
  endHosting,
  joinLive,
  leaveLive,
  liveSeams,
  startHosting,
} from "./session.js";
import type { LiveTransport } from "./transport.js";

const VAULT_SECRET = "correct horse battery staple";
const github = plainAccount("GitHub", VAULT_SECRET);

const original = { items: liveSeams.items, onLock: liveSeams.onLock };
let releasePort: (() => void) | null = null;
beforeEach(() => {
  liveSeams.items = () => [github];
  liveSeams.onLock = () => () => undefined;
});
afterEach(() => {
  releasePort?.();
  releasePort = null;
  endHosting();
  leaveLive();
  liveSeams.items = original.items;
  liveSeams.onLock = original.onLock;
});

const CONNECTION = {
  id: "c-github",
  label: "GitHub (work)",
  provider: "github",
  operations: ["provider.read", "provider.repositories.read"],
};
const OTHER = {
  id: "c-linear",
  label: "Linear",
  provider: "linear",
  operations: ["provider.read"],
};

function bindPort(invoke?: ConnectionPort["invoke"]): ConnectionPort {
  const port: ConnectionPort = {
    list: () => [CONNECTION, OTHER],
    invoke:
      invoke ??
      (async () => ({
        label: "Repositories",
        items: [
          { id: "acme/api", label: "acme/api", url: "https://x.test/acme/api" },
        ],
      })),
  };
  releasePort = bindConnectionPort(port);
  return port;
}

function profile(session?: NatsSession): LiveTransport {
  return {
    addresses: [],
    ice: [],
    relay: false,
    carriers: [
      session
        ? { kind: "nats", url: "wss://nats.example.test", session }
        : { kind: "nats", url: "wss://nats.example.test" },
    ],
  };
}

type Options = {
  admission?: "invite" | "open";
  devices?: boolean;
  routes?: LiveTransport;
};

async function host(bus: FakeBus, options: Options = {}): Promise<LiveHost> {
  const owner = await startHosting({
    title: "Team",
    scope: { kind: "none" },
    policy: "use",
    admission: options.admission ?? "open",
    minutes: 30,
    transport: new FakeNet().transports(),
    routes: options.routes ?? profile(),
    carriers: bus.factory(),
    devices: options.devices ?? true,
  });
  await settle();
  return owner;
}

async function joinDevice(owner: LiveHost, bus: FakeBus, name = "work laptop") {
  const joining = joinAsDevice({
    link: owner.link,
    code: owner.code,
    name,
    carriers: bus.factory(),
  });
  // An invite session waits for the owner to let the device in.
  for (let round = 0; round < 40; round += 1) {
    const asking = owner.state.guests.find((guest) => guest.state === "asking");
    if (asking) await owner.admit(asking.key);
    await settle(5);
  }
  return joining;
}

async function pendingRequest(owner: LiveHost) {
  for (
    let round = 0;
    round < 60 && owner.state.devices.pending.length === 0;
    round += 1
  )
    await settle(5);
  const [pending] = owner.state.devices.pending;
  if (!pending) throw new Error("the owner was never asked");
  return pending;
}

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
      owner.devices?.approve(pending.id, {
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
    session.leave();
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
    session.leave();
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
    session.leave();
  });

  it("loses its grant when the owner revokes it", async () => {
    bindPort();
    const bus = new FakeBus();
    const owner = await host(bus);
    const session = await joinDevice(owner, bus);
    const authorized = session.client.authorize();
    const pending = await pendingRequest(owner);
    owner.devices?.approve(pending.id, {
      connections: ["c-github"],
      minutes: 5,
    });
    await authorized;
    const [grant] = owner.state.devices.grants;
    owner.devices?.revoke(grant?.id ?? "");
    await expect(
      session.client.call("c-github", "provider.read"),
    ).rejects.toMatchObject({ code: "access_denied" });
    session.leave();
  });

  it("hears nothing more once the owner ends the session", async () => {
    bindPort();
    const bus = new FakeBus();
    const owner = await host(bus);
    const session = await joinDevice(owner, bus);
    const authorized = session.client.authorize();
    const pending = await pendingRequest(owner);
    owner.devices?.approve(pending.id, {
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
    owner.devices?.approve(pending.id, {
      connections: ["c-github"],
      minutes: 5,
    });
    await authorized;
    expect(owner.state.devices.grants).toHaveLength(1);
    session.leave();
    await settle();
    expect(owner.state.devices.grants).toEqual([]);
  });
});

describe("a device in an invite session", () => {
  it("waits for the owner to let it in, and for the code", async () => {
    bindPort();
    const bus = new FakeBus();
    const owner = await host(bus, { admission: "invite" });
    const session = await joinDevice(owner, bus);
    expect(owner.state.guests[0]?.state).toBe("joined");
    session.leave();
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
