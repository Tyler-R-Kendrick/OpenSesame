/**
 * `opensesame-id session` when it does not go well: refusals made before a
 * socket opens, the owner saying no, silence, a lapsed request, Ctrl-C, a
 * relay that is down — each a plain sentence and a nonzero exit, with the
 * device always leaving and no bearer in anything printed.
 */
import { approveAs } from "@opensesame/app-core/lib/live/device-approval.test-support.js";
import {
  FAKE_CLOCK,
  settle,
} from "@opensesame/app-core/lib/live/live-clock.fixture.js";
import { FakeBus } from "@opensesame/app-core/lib/live/live-fakes.js";
import { describe, expect, it, vi } from "vitest";
import {
  execute,
  host,
  linkOf,
  pendingRequest,
  profile,
  useSessionWorld,
} from "./session-hosted.test-support.js";

const world = useSessionWorld();

/** Start the command against `owner`, as a device that has not been answered. */
function start(argv: string[], bus: FakeBus) {
  return execute(world, argv, { sessionCarriers: bus.factory() });
}

describe("refusals made before anything is contacted", () => {
  it.each([
    ["is not a link", "not-a-link", /not a live-session link/],
    [
      "is a link without the session",
      "https://app.example.test/#x=1",
      /not a live/,
    ],
  ])("a link that %s", async (_why, link, message) => {
    world.bind();
    const bus = new FakeBus();
    const ran = await start(["session", link, "list"], bus);
    expect(ran.code).toBe(1);
    expect(ran.err).toMatch(message);
    expect(ran.out).toBe("");
    expect(bus.specs).toEqual([]);
  });

  it("a session that names no NATS relay", async () => {
    world.bind();
    const owner = await host(new FakeBus(), { routes: profile("off") });
    const direct = await host(new FakeBus(), {
      routes: { addresses: [], ice: [], relay: false, carriers: [] },
    });
    for (const target of [owner, direct]) {
      const asked = new FakeBus();
      const link = linkOf(target);
      const ran = await start(["session", link, "list"], asked);
      expect(ran.code).toBe(1);
      expect(ran.err).toContain(
        "This session names no NATS relay; a terminal can only join over one.",
      );
      expect(ran.err).not.toContain(link);
      expect(asked.specs).toEqual([]);
    }
  });

  it("an invite session when no code was given", async () => {
    world.bind();
    const owner = await host(new FakeBus(), { admission: "invite" });
    const asked = new FakeBus();
    const ran = await start(["session", linkOf(owner), "list"], asked);
    expect(ran.code).toBe(1);
    expect(ran.err).toContain("--code or OPENSESAME_LIVE_CODE");
    expect(asked.specs).toEqual([]);
  });

  it("an invite code that cannot be one", async () => {
    world.bind();
    const owner = await host(new FakeBus(), { admission: "invite" });
    const asked = new FakeBus();
    const ran = await start(
      ["session", linkOf(owner), "list", "--code", "hello"],
      asked,
    );
    expect(ran.code).toBe(1);
    expect(ran.err).toContain("not an invite code");
    expect(ran.err).not.toContain("hello");
    expect(asked.specs).toEqual([]);
    expect(owner.state.misses).toBe(0);
  });

  it("a name the host could not show", async () => {
    world.bind();
    const owner = await host(new FakeBus());
    const asked = new FakeBus();
    const ran = await start(
      ["session", linkOf(owner), "list", "--name", "​ ​"],
      asked,
    );
    expect(ran.code).toBe(1);
    expect(ran.err).toContain("pass --name LABEL");
    expect(asked.specs).toEqual([]);
  });

  it("says the same in JSON, as one document", async () => {
    world.bind();
    const ran = await start(
      ["session", "nope", "list", "--json"],
      new FakeBus(),
    );
    expect(ran.code).toBe(1);
    expect(JSON.parse(ran.out)).toEqual({
      ok: false,
      error: "bad_link",
      message: expect.stringContaining("not a live-session link"),
    });
    expect(ran.err).toContain("not a live-session link");
  });
});

describe("the host's answer", () => {
  it("declined: says so, exits nonzero and leaves", async () => {
    world.bind();
    const bus = new FakeBus();
    const owner = await host(bus);
    const running = start(["session", linkOf(owner), "list"], bus);
    const pending = await pendingRequest(owner);
    owner.devices?.deny(pending.id);
    const ran = await running;
    expect(ran.code).toBe(1);
    expect(ran.err).toContain("The host declined this device.");
    expect(ran.out).toBe("");
    await settle();
    expect(owner.state.devices.pending).toEqual([]);
    expect(owner.state.guests.some((guest) => guest.state === "joined")).toBe(
      false,
    );
  });

  it("declined, with --json: one document with the code, none of the link", async () => {
    world.bind();
    const bus = new FakeBus();
    const owner = await host(bus);
    const running = start(["session", linkOf(owner), "list", "--json"], bus);
    owner.devices?.deny((await pendingRequest(owner)).id);
    const ran = await running;
    expect(ran.code).toBe(1);
    expect(JSON.parse(ran.out)).toEqual({
      ok: false,
      error: "access_denied",
      message: "The host declined this device.",
    });
  });

  it("unanswered: stops at --timeout and says no one approved in time", async () => {
    world.bind();
    const bus = new FakeBus();
    const owner = await host(bus);
    const ran = await start(
      ["session", linkOf(owner), "list", "--timeout", "0.4"],
      bus,
    );
    expect(ran.code).toBe(1);
    expect(ran.err).toContain(
      "No answer from the host within 0.4 seconds; the request was not approved in time.",
    );
    await settle();
    expect(owner.state.devices.pending).toEqual([]);
  });

  it("not seated: says what to check when the host never lets a device in", async () => {
    world.bind();
    const bus = new FakeBus();
    const owner = await host(bus, { devices: false });
    const ran = await start(
      ["session", linkOf(owner), "list", "--timeout", "0.4"],
      bus,
    );
    expect(ran.code).toBe(1);
    expect(ran.err).toContain(
      "No answer from the host within 0.4 seconds; was the session started to let devices use connections, and with a NATS relay?",
    );
    expect(owner.state.guests).toEqual([]);
  });

  it("a wrong invite code is not seated, and the timeout says to check it", async () => {
    world.bind();
    const bus = new FakeBus();
    const owner = await host(bus, { admission: "invite" });
    const ran = await start(
      [
        "session",
        linkOf(owner),
        "list",
        "--code",
        "BCDF-GHJK",
        "--timeout",
        "0.4",
      ],
      bus,
    );
    expect(ran.code).toBe(1);
    expect(ran.err).toContain("An invite session also needs the right code.");
    expect(owner.state.guests).toEqual([]);
  });

  it("lapsed: says the request ran out before the host answered", async () => {
    vi.useFakeTimers(FAKE_CLOCK);
    world.bind();
    const bus = new FakeBus();
    const owner = await host(bus);
    const running = start(["session", linkOf(owner), "list"], bus);
    await pendingRequest(owner);
    // Ten minutes is a request's life; the command's own limit is fifteen.
    for (let step = 0; step < 130; step += 1) {
      await vi.advanceTimersByTimeAsync(5000);
      await settle(3);
    }
    const ran = await running;
    expect(ran.code).toBe(1);
    expect(ran.err).toContain("The request lapsed before the host answered.");
  });

  it("interrupted: Ctrl-C leaves the session and lets go of the signal", async () => {
    world.bind();
    const bus = new FakeBus();
    const owner = await host(bus);
    const before = process.listeners("SIGINT");
    const running = start(["session", linkOf(owner), "list"], bus);
    await pendingRequest(owner);
    const mine = process.listeners("SIGINT").find((l) => !before.includes(l));
    expect(mine).toBeDefined();
    mine?.("SIGINT");
    const ran = await running;
    expect(ran.code).toBe(1);
    expect(ran.err).toContain("Interrupted.");
    expect(process.listeners("SIGINT")).toEqual(before);
    await settle();
    expect(owner.state.devices.pending).toEqual([]);
  });
});

describe("the road to the host", () => {
  it("a relay that is down is a failure to reach the host, not a hang", async () => {
    world.bind();
    const owner = await host(new FakeBus());
    const down = new FakeBus();
    down.down = true;
    const ran = await start(
      ["session", linkOf(owner), "list", "--timeout", "0.5"],
      down,
    );
    expect(ran.code).toBe(1);
    expect(ran.err).toContain("Could not reach the session's NATS relay");
    expect(ran.err).not.toContain("No answer");
  });

  it("waits for the carriers to finish closing before it returns", async () => {
    world.bind();
    const bus = new FakeBus();
    const owner = await host(bus);
    const settled = vi.fn(async () => undefined);
    const running = execute(world, ["session", linkOf(owner), "list"], {
      sessionCarriers: Object.assign(bus.factory(), { settled }),
    });
    const pending = await pendingRequest(owner);
    expect(settled).not.toHaveBeenCalled();
    await approveAs(owner.devices, pending.id, {
      connections: ["c-github"],
      minutes: 5,
    });
    expect((await running).code).toBe(0);
    expect(settled).toHaveBeenCalledOnce();
  });

  it("needs no app-core host of its own, as a terminal has none", async () => {
    world.bind();
    const bus = new FakeBus();
    const owner = await host(bus);
    const installed = globalThis.__opensesameAppCoreHost;
    globalThis.__opensesameAppCoreHost = undefined;
    try {
      const running = start(["session", linkOf(owner), "list"], bus);
      const pending = await pendingRequest(owner);
      // The owner's tab is a browser, and has its host; only the terminal has none.
      globalThis.__opensesameAppCoreHost = installed;
      await approveAs(owner.devices, pending.id, {
        connections: ["c-github"],
        minutes: 5,
      });
      globalThis.__opensesameAppCoreHost = undefined;
      expect((await running).code).toBe(0);
    } finally {
      globalThis.__opensesameAppCoreHost = installed;
    }
  });
});
