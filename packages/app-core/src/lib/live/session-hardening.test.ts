import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
/**
 * Sessions across time and across a lock (ADR 0150 §2, §6): a joiner who
 * waits for an owner keeps hearing the carriers, and a vault that locks while
 * a session is still being built never leaves it live.
 */
import { plainAccount } from "../account.test-support.js";
import type { LiveHost } from "./host.js";
import { FAKE_CLOCK, settle } from "./live-clock.fixture.js";
import { FakeBus, FakeNet } from "./live-fakes.js";
import {
  currentHost,
  currentHostCarriers,
  endHosting,
  joinLive,
  leaveLive,
  liveSeams,
  noteDocumentLeft,
  notePersistedRestore,
  onLiveSessionChange,
  startHosting,
} from "./session.js";
import type { LiveTransport } from "./transport.js";

const github = plainAccount("GitHub", "correct horse battery staple");

const PROFILE: LiveTransport = {
  addresses: [],
  ice: [],
  relay: false,
  carriers: [{ kind: "nostr", url: "wss://relay.example.ts.net" }],
};

const original = { items: liveSeams.items, onLock: liveSeams.onLock };
const lockHandlers = new Set<() => void>();

beforeEach(() => {
  lockHandlers.clear();
  liveSeams.items = () => [github];
  liveSeams.onLock = (handler) => {
    lockHandlers.add(handler);
    return () => lockHandlers.delete(handler);
  };
});
afterEach(() => {
  endHosting();
  leaveLive();
  liveSeams.items = original.items;
  liveSeams.onLock = original.onLock;
  vi.useRealTimers();
});

function hostInput(net: FakeNet, bus: FakeBus) {
  return {
    title: "Team",
    scope: { kind: "vault" as const },
    policy: "read" as const,
    admission: "invite" as const,
    minutes: 30,
    transport: net.transports(),
    routes: PROFILE,
    carriers: bus.factory(),
  };
}

describe("a joiner who waits", () => {
  it("still hears the owner's reply on the carriers after the reposts have stopped", async () => {
    vi.useFakeTimers(FAKE_CLOCK);
    const net = new FakeNet();
    const bus = new FakeBus();
    const owner = await startHosting(hostInput(net, bus));
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
    await settle();
    expect(owner.state.guests[0]?.state).toBe("asking");
    // Past the last repost (thirty, twenty seconds apart), the owner is
    // still deciding.
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    const posted = bus.seen.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(bus.seen.length).toBe(posted);
    expect(guest.status.at).toBe("request");
    await owner.admit(owner.state.guests[0]?.key ?? "");
    await settle();
    expect(guest.status.at).toBe("joined");
  });
});

describe("a vault that locks while a session is being built", () => {
  it("never leaves a live session over it", async () => {
    const net = new FakeNet();
    const pending = startHosting(hostInput(net, new FakeBus()));
    // The lock arrives while `startHosting` is still awaiting.
    for (const handler of [...lockHandlers]) handler();
    const host = await pending;
    expect(host.state.status).toBe("ended");
    expect(currentHost()).toBeNull();
    expect(lockHandlers.size).toBe(0);
  });

  it("ends the session it built when the vault locks afterwards, and forgets the watch", async () => {
    const net = new FakeNet();
    const host = await startHosting(hostInput(net, new FakeBus()));
    expect(currentHost()).toBe(host);
    expect(host.state.status).toBe("live");
    expect(lockHandlers.size).toBe(1);
    for (const handler of [...lockHandlers]) handler();
    expect(host.state.status).toBe("ended");
    expect(currentHost()).toBeNull();
    expect(lockHandlers.size).toBe(0);
  });
});

describe("a start that fails leaves nothing behind", () => {
  function nothingLeft() {
    expect(currentHost()).toBeNull();
    expect(currentHostCarriers()).toBeNull();
    expect(lockHandlers.size).toBe(0);
  }

  it("routes too long for a link: rejected, and no session, carrier or lock watch", async () => {
    const long = (letter: string) => letter.repeat(500);
    const heavy: LiveTransport = {
      ...PROFILE,
      carriers: Array.from({ length: 6 }, () => ({
        kind: "nostr" as const,
        url: `wss://${long("a")}.example.com`,
        username: long("u"),
        password: long("p"),
        token: long("t"),
      })),
    };
    const start = startHosting({
      ...hostInput(new FakeNet(), new FakeBus()),
      routes: heavy,
    });
    await expect(start).rejects.toThrow(/too long/);
    nothingLeft();
  });

  it("opening the carriers throws after the host exists: that host ends", async () => {
    const input = hostInput(new FakeNet(), new FakeBus());
    const seen: LiveHost[] = [];
    Object.defineProperty(input, "carriers", {
      get() {
        // Read once the host is installed as the current session.
        const current = currentHost();
        if (current) seen.push(current);
        throw new Error("no carrier client");
      },
    });
    await expect(startHosting(input)).rejects.toThrow("no carrier client");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.state.status).toBe("ended");
    nothingLeft();
  });

  it("a listener that throws when the session is announced: torn down, then rejected", async () => {
    const unlisten = onLiveSessionChange(() => {
      throw new Error("listener");
    });
    await expect(
      startHosting(hostInput(new FakeNet(), new FakeBus())),
    ).rejects.toThrow("listener");
    unlisten();
    nothingLeft();
    // And the next start is an ordinary one.
    const host = await startHosting(hostInput(new FakeNet(), new FakeBus()));
    expect(currentHost()).toBe(host);
  });
});

describe("a document that leaves and comes back", () => {
  it("drops a live session when the document navigates away", async () => {
    const host = await startHosting(hostInput(new FakeNet(), new FakeBus()));
    expect(currentHost()).toBe(host);
    noteDocumentLeft();
    expect(host.state.status).toBe("ended");
    expect(currentHost()).toBeNull();
  });

  it("refuses a persisted restore of a session that was still live, and does not revive an idle one", async () => {
    const host = await startHosting(hostInput(new FakeNet(), new FakeBus()));
    notePersistedRestore(false);
    expect(currentHost()).toBe(host);
    notePersistedRestore(true);
    expect(host.state.status).toBe("ended");
    expect(currentHost()).toBeNull();
    notePersistedRestore(true);
    expect(currentHost()).toBeNull();
  });
});
