/**
 * Device authorization from the owner's side (ADR 0195): the request and its
 * codes, RFC 8628's polling rules, the owner's answer, and what a grant lets a
 * device do — and nothing else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionPort, SessionConnection } from "./connection-port.js";
import { DeviceBroker } from "./device-broker.js";
import type { DeviceReply } from "./device-messages.js";
import {
  CALLS_PER_MINUTE,
  DEVICE_CODE_TTL_MS,
  type DeviceLog,
  MAX_IN_FLIGHT,
  MAX_PENDING,
  POLL_SECONDS,
} from "./device-types.js";
import { FAKE_CLOCK, deferred } from "./live-clock.fixture.js";

const GITHUB: SessionConnection = {
  id: "c-github",
  label: "GitHub",
  provider: "github",
  operations: ["provider.read", "provider.repositories.read"],
};
const VAULT: SessionConnection = {
  id: "c-vault",
  label: "Vault",
  provider: "vault",
  operations: ["provider.read", "provider.secret.read"],
};
const LINEAR: SessionConnection = {
  id: "c-linear",
  label: "Linear",
  provider: "linear",
  operations: ["provider.read"],
};

const SESSION_MS = 4 * 60 * 60 * 1000;
const START = 1_800_000_000_000;

type Held = { connections: SessionConnection[]; port: ConnectionPort | null };

function setup(
  invoke: ConnectionPort["invoke"] = async () => ({
    label: "Repositories",
    items: [{ id: "r1", label: "opensesame" }],
  }),
  connections: SessionConnection[] = [GITHUB, VAULT, LINEAR],
) {
  const held: Held = { connections, port: null };
  held.port = { list: () => held.connections, invoke };
  const log: DeviceLog[] = [];
  const broker = new DeviceBroker({
    port: () => held.port,
    expiresAt: START + SESSION_MS,
    onLog: (entry) => log.push(entry),
  });
  return { broker, held, log };
}

function seatOf(broker: DeviceBroker, key = "s1", name = "my laptop") {
  const replies: DeviceReply[] = [];
  const seat = broker.seat({ key, name }, (reply) => replies.push(reply));
  return { seat, replies, last: () => replies[replies.length - 1] };
}

async function begin(
  broker: DeviceBroker,
  seat: ReturnType<typeof seatOf>,
  want: string[] = [],
) {
  await seat.seat.handle({ t: "dev.begin", req: "b1", want });
  const code = seat.replies.find((reply) => reply.t === "dev.code");
  if (code?.t !== "dev.code") throw new Error("no code");
  const pending = broker.state.pending.find((entry) => entry.seat === "s1");
  if (!pending) throw new Error("not pending");
  return { code, pending };
}

beforeEach(() => {
  vi.useFakeTimers({ ...FAKE_CLOCK, now: START });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("asking for authority", () => {
  it("hands the device two codes and shows the owner one of them", async () => {
    const { broker } = setup();
    const device = seatOf(broker);
    const { code, pending } = await begin(broker, device, ["c-github"]);
    expect(code.userCode).toMatch(
      /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/,
    );
    expect(code.deviceCode).toHaveLength(22);
    expect(code.interval).toBe(POLL_SECONDS);
    expect(code.expiresIn).toBe(DEVICE_CODE_TTL_MS / 1000);
    // The owner sees the user code and the hint, never the device code.
    expect(pending.userCode).toBe(code.userCode);
    expect(pending.want).toEqual(["c-github"]);
    expect(JSON.stringify(broker.state)).not.toContain(code.deviceCode);
    expect(pending.name).toBe("my laptop");
  });

  it("never gives two requests the same user code", async () => {
    const { broker } = setup();
    const codes = new Set<string>();
    for (let seat = 0; seat < MAX_PENDING; seat += 1) {
      const device = seatOf(broker, `s${seat}`);
      await device.seat.handle({ t: "dev.begin", req: "b1", want: [] });
      const code = device.replies.find((reply) => reply.t === "dev.code");
      if (code?.t === "dev.code") codes.add(code.userCode);
    }
    expect(codes.size).toBe(MAX_PENDING);
  });

  it("refuses when there is nothing to grant", async () => {
    const { broker, held } = setup();
    held.connections = [];
    const device = seatOf(broker);
    await device.seat.handle({ t: "dev.begin", req: "b1", want: [] });
    expect(device.last()).toEqual({
      t: "dev.error",
      req: "b1",
      error: "temporarily_unavailable",
    });
    held.port = null;
    await device.seat.handle({ t: "dev.begin", req: "b2", want: [] });
    expect(device.last()).toMatchObject({ error: "temporarily_unavailable" });
    expect(broker.state.pending).toEqual([]);
  });

  it("holds the session to a few requests at once", async () => {
    const { broker } = setup();
    for (let seat = 0; seat < MAX_PENDING; seat += 1)
      await seatOf(broker, `s${seat}`).seat.handle({
        t: "dev.begin",
        req: "b1",
        want: [],
      });
    const extra = seatOf(broker, "extra");
    await extra.seat.handle({ t: "dev.begin", req: "b1", want: [] });
    expect(extra.last()).toMatchObject({
      t: "dev.error",
      error: "temporarily_unavailable",
    });
    expect(broker.state.pending).toHaveLength(MAX_PENDING);
  });

  it("lets a seat hold one question: a new one replaces the old", async () => {
    const { broker } = setup();
    const device = seatOf(broker);
    const first = await begin(broker, device);
    await device.seat.handle({ t: "dev.begin", req: "b2", want: [] });
    const [pending] = broker.state.pending;
    expect(broker.state.pending).toHaveLength(1);
    expect(pending?.userCode).not.toBe(first.code.userCode);
    // The old device code no longer answers.
    await device.seat.handle({
      t: "dev.poll",
      req: "p1",
      deviceCode: first.code.deviceCode,
    });
    expect(device.last()).toEqual({
      t: "dev.error",
      req: "p1",
      error: "invalid_request",
    });
  });
});

describe("polling (RFC 8628 §3.5)", () => {
  it("answers pending, and slow_down with a longer wait when asked too soon", async () => {
    const { broker } = setup();
    const device = seatOf(broker);
    const { code } = await begin(broker, device);
    const poll = (req: string) =>
      device.seat.handle({ t: "dev.poll", req, deviceCode: code.deviceCode });
    await poll("p1");
    expect(device.last()).toEqual({
      t: "dev.auth",
      req: "p1",
      state: "slow_down",
      interval: POLL_SECONDS + 5,
    });
    await vi.advanceTimersByTimeAsync((POLL_SECONDS + 5) * 1000);
    await poll("p2");
    expect(device.last()).toEqual({
      t: "dev.auth",
      req: "p2",
      state: "authorization_pending",
    });
    await poll("p3");
    expect(device.last()).toMatchObject({ state: "slow_down", interval: 15 });
  });

  it("caps the longer wait", async () => {
    const { broker } = setup();
    const device = seatOf(broker);
    const { code } = await begin(broker, device);
    for (let i = 0; i < 20; i += 1)
      await device.seat.handle({
        t: "dev.poll",
        req: `p${i}`,
        deviceCode: code.deviceCode,
      });
    expect(device.last()).toMatchObject({ state: "slow_down", interval: 60 });
  });

  it("does not answer a poll that holds the wrong code", async () => {
    const { broker } = setup();
    const device = seatOf(broker);
    await begin(broker, device);
    await device.seat.handle({
      t: "dev.poll",
      req: "p1",
      deviceCode: "A".repeat(22),
    });
    expect(device.last()).toEqual({
      t: "dev.error",
      req: "p1",
      error: "invalid_request",
    });
  });

  it("expires a request the owner never answered", async () => {
    const { broker } = setup();
    const device = seatOf(broker);
    const { code } = await begin(broker, device);
    await vi.advanceTimersByTimeAsync(DEVICE_CODE_TTL_MS);
    expect(broker.state.pending).toEqual([]);
    await device.seat.handle({
      t: "dev.poll",
      req: "p1",
      deviceCode: code.deviceCode,
    });
    expect(device.last()).toEqual({
      t: "dev.auth",
      req: "p1",
      state: "expired_token",
    });
    expect(
      broker.approve("nope", { connections: ["c-github"], minutes: 5 }),
    ).toBe("unknown");
  });

  it("never lets a request outlive the session", async () => {
    const { broker } = setup();
    const device = seatOf(broker);
    await vi.advanceTimersByTimeAsync(SESSION_MS - 60_000);
    const { code } = await begin(broker, device);
    expect(code.expiresIn).toBe(60);
  });
});

describe("the owner's answer", () => {
  it("grants the connections the owner picked, and tells the device at once", async () => {
    const { broker } = setup();
    const device = seatOf(broker);
    const { pending } = await begin(broker, device, ["c-vault"]);
    const result = broker.approve(pending.id, {
      connections: ["c-github"],
      minutes: 30,
    });
    expect(result).toBe("approved");
    const granted = device.last();
    expect(granted).toMatchObject({
      t: "dev.auth",
      req: "b1",
      state: "granted",
      expiresAt: START + 30 * 60_000,
    });
    // Only what the owner picked, whatever the device asked for, and no
    // secret-reading operation even though the port listed one.
    expect(granted?.t === "dev.auth" ? granted.connections : []).toEqual([
      {
        id: "c-github",
        label: "GitHub",
        provider: "github",
        operations: ["provider.read", "provider.repositories.read"],
      },
    ]);
    expect(broker.state.pending).toEqual([]);
    expect(broker.state.grants).toMatchObject([
      { seat: "s1", connections: ["c-github"], calls: 0 },
    ]);
  });

  it("answers a later poll with the same grant, and a spent code once it ends", async () => {
    const { broker } = setup();
    const device = seatOf(broker);
    const { code, pending } = await begin(broker, device);
    broker.approve(pending.id, { connections: ["c-github"], minutes: 30 });
    await vi.advanceTimersByTimeAsync(POLL_SECONDS * 1000);
    await device.seat.handle({
      t: "dev.poll",
      req: "p1",
      deviceCode: code.deviceCode,
    });
    expect(device.last()).toMatchObject({ req: "p1", state: "granted" });
    const [grant] = broker.state.grants;
    broker.revoke(grant?.id ?? "");
    await vi.advanceTimersByTimeAsync(POLL_SECONDS * 1000);
    await device.seat.handle({
      t: "dev.poll",
      req: "p2",
      deviceCode: code.deviceCode,
    });
    expect(device.last()).toMatchObject({ req: "p2", state: "expired_token" });
  });

  it("clamps a grant to the session and to eight hours", async () => {
    const { broker } = setup();
    const device = seatOf(broker);
    const { pending } = await begin(broker, device);
    broker.approve(pending.id, { connections: ["c-github"], minutes: 100_000 });
    expect(broker.state.grants[0]?.expiresAt).toBe(START + SESSION_MS);
  });

  it("refuses an approval with nothing to grant, a stale one and an unknown one", async () => {
    const { broker } = setup();
    const device = seatOf(broker);
    const { pending } = await begin(broker, device);
    expect(broker.approve(pending.id, { connections: [], minutes: 5 })).toBe(
      "nothing_chosen",
    );
    expect(
      broker.approve(pending.id, { connections: ["c-gone"], minutes: 5 }),
    ).toBe("nothing_chosen");
    expect(
      broker.approve("unknown", { connections: ["c-github"], minutes: 5 }),
    ).toBe("unknown");
    expect(broker.state.pending).toHaveLength(1);
    expect(broker.state.grants).toEqual([]);
    await vi.advanceTimersByTimeAsync(DEVICE_CODE_TTL_MS);
    expect(
      broker.approve(pending.id, { connections: ["c-github"], minutes: 5 }),
    ).toBe("lapsed");
  });

  it("will not grant once the connections went away", async () => {
    const { broker, held } = setup();
    const device = seatOf(broker);
    const { pending } = await begin(broker, device);
    held.port = null;
    expect(
      broker.approve(pending.id, { connections: ["c-github"], minutes: 5 }),
    ).toBe("unavailable");
  });

  it("tells the device no when the owner does", async () => {
    const { broker } = setup();
    const device = seatOf(broker);
    const { code, pending } = await begin(broker, device);
    expect(broker.deny(pending.id)).toBe(true);
    expect(device.last()).toEqual({
      t: "dev.auth",
      req: "b1",
      state: "access_denied",
    });
    expect(broker.deny(pending.id)).toBe(false);
    await vi.advanceTimersByTimeAsync(POLL_SECONDS * 1000);
    await device.seat.handle({
      t: "dev.poll",
      req: "p1",
      deviceCode: code.deviceCode,
    });
    expect(device.last()).toMatchObject({ req: "p1", state: "access_denied" });
    expect(broker.state.pending).toEqual([]);
    expect(
      broker.approve(pending.id, { connections: ["c-github"], minutes: 5 }),
    ).toBe("lapsed");
  });
});

async function granted(
  connections = ["c-github"],
  invoke?: ConnectionPort["invoke"],
) {
  const world = setup(invoke);
  const device = seatOf(world.broker);
  const { pending } = await begin(world.broker, device);
  world.broker.approve(pending.id, { connections, minutes: 60 });
  return { ...world, device };
}

const call = (
  operation = "provider.repositories.read",
  connection = "c-github",
) =>
  ({
    t: "dev.call",
    req: "k1",
    connection,
    operation,
    input: {},
  }) as const;

describe("using a grant", () => {
  it("lists what the grant covers", async () => {
    const { device } = await granted(["c-github", "c-linear"]);
    await device.seat.handle({ t: "dev.list", req: "l1" });
    const listed = device.last();
    expect(
      listed?.t === "dev.conns" ? listed.connections.map((c) => c.id) : [],
    ).toEqual(["c-github", "c-linear"]);
  });

  it("makes a call and logs it by id, with no value in sight", async () => {
    const seen: unknown[] = [];
    const { broker, device, log } = await granted(
      ["c-github"],
      async (made) => {
        seen.push({ ...made, signal: undefined });
        return { label: "Repos", items: [{ id: "r1", label: "opensesame" }] };
      },
    );
    await device.seat.handle({ ...call(), input: { page: "2" } });
    expect(device.last()).toEqual({
      t: "dev.result",
      req: "k1",
      label: "Repos",
      items: [{ id: "r1", label: "opensesame" }],
      truncated: false,
    });
    expect(seen).toEqual([
      {
        connection: "c-github",
        operation: "provider.repositories.read",
        input: { page: "2" },
        signal: undefined,
      },
    ]);
    expect(log).toEqual([
      {
        at: START,
        guest: "s1",
        what: "invoke",
        connection: "c-github",
        operation: "provider.repositories.read",
      },
    ]);
    expect(broker.state.grants[0]?.calls).toBe(1);
  });

  it("refuses a connection outside the grant exactly as it refuses one that does not exist", async () => {
    const { device, log } = await granted(["c-github"]);
    await device.seat.handle(call("provider.read", "c-vault"));
    const outside = device.last();
    await device.seat.handle({
      ...call("provider.read", "c-nothing"),
      req: "k1",
    });
    expect(device.last()).toEqual(outside);
    expect(outside).toEqual({
      t: "dev.error",
      req: "k1",
      error: "access_denied",
    });
    expect(log.map((entry) => entry.what)).toEqual(["denied", "denied"]);
  });

  it("refuses an operation the connection does not list", async () => {
    const { device } = await granted();
    await device.seat.handle(call("provider.objects.read"));
    expect(device.last()).toMatchObject({ error: "unsupported_operation" });
  });

  it("refuses an operation that reads a secret even when the port lists it", async () => {
    const invoke = vi.fn();
    const { device } = await granted(["c-vault"], invoke);
    await device.seat.handle(call("provider.secret.read", "c-vault"));
    expect(device.last()).toMatchObject({ error: "unsupported_operation" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("tells a device with no grant, or an ended one, it has none", async () => {
    const world = setup();
    const device = seatOf(world.broker);
    await device.seat.handle(call());
    expect(device.last()).toMatchObject({ error: "access_denied" });
    await device.seat.handle({ t: "dev.list", req: "l1" });
    expect(device.last()).toMatchObject({ error: "access_denied" });
    const { pending } = await begin(world.broker, device);
    world.broker.approve(pending.id, { connections: ["c-github"], minutes: 1 });
    await vi.advanceTimersByTimeAsync(60_000);
    await device.seat.handle(call());
    expect(device.last()).toMatchObject({ error: "access_denied" });
    expect(world.broker.state.grants).toEqual([]);
  });

  it("answers expired_token to a grant found lapsed before its timer", async () => {
    const world = setup();
    const device = seatOf(world.broker);
    const { pending } = await begin(world.broker, device);
    world.broker.approve(pending.id, { connections: ["c-github"], minutes: 1 });
    // The clock moves under the timer, as a suspended tab's does.
    vi.setSystemTime(START + 2 * 60_000);
    await device.seat.handle(call());
    expect(device.last()).toMatchObject({ error: "expired_token" });
  });

  it("stops asking a connection that has since gone", async () => {
    const { device, held } = await granted();
    held.connections = [LINEAR];
    await device.seat.handle(call());
    expect(device.last()).toMatchObject({ error: "access_denied" });
    await device.seat.handle({ t: "dev.list", req: "l1" });
    expect(device.last()).toMatchObject({ t: "dev.conns", connections: [] });
  });

  it("reports a failing provider as a code, not as what the provider said", async () => {
    const { device } = await granted(["c-github"], async () => {
      throw new Error("401 token ghp_SECRET for https://x.test/?key=abc");
    });
    await device.seat.handle(call());
    expect(device.last()).toEqual({
      t: "dev.error",
      req: "k1",
      error: "upstream_error",
    });
    expect(JSON.stringify(device.replies)).not.toContain("ghp_SECRET");
  });

  it("gives up on a call that takes too long", async () => {
    const never = deferred();
    const { device } = await granted(["c-github"], async (made) => {
      made.signal.addEventListener("abort", () => never.release());
      await never.promise;
      throw new Error("aborted");
    });
    const pending = device.seat.handle(call());
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;
    expect(device.last()).toMatchObject({ error: "temporarily_unavailable" });
  });

  it("limits calls running at once and calls a minute", async () => {
    const gate = deferred();
    const { device } = await granted(["c-github"], async () => {
      await gate.promise;
      return { label: "x", items: [] };
    });
    const running = Array.from({ length: MAX_IN_FLIGHT }, (_, i) =>
      device.seat.handle({ ...call(), req: `k${i}` }),
    );
    await device.seat.handle({ ...call(), req: "over" });
    expect(device.last()).toEqual({
      t: "dev.error",
      req: "over",
      error: "temporarily_unavailable",
    });
    gate.release();
    await Promise.all(running);
    for (let i = 0; i < CALLS_PER_MINUTE - MAX_IN_FLIGHT; i += 1)
      await device.seat.handle({ ...call(), req: `m${i}` });
    await device.seat.handle({ ...call(), req: "late" });
    expect(device.last()).toMatchObject({
      req: "late",
      error: "temporarily_unavailable",
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await device.seat.handle({ ...call(), req: "again" });
    expect(device.last()).toMatchObject({ req: "again", t: "dev.result" });
  });
});

describe("ending", () => {
  it("answers a call in flight when the owner revokes, and a later one the same", async () => {
    const gate = deferred();
    const { broker, device } = await granted(["c-github"], async (made) => {
      await Promise.race([
        gate.promise,
        new Promise((resolve) =>
          made.signal.addEventListener("abort", () => resolve(undefined)),
        ),
      ]);
      return { label: "x", items: [] };
    });
    const running = device.seat.handle(call());
    expect(broker.revoke(broker.state.grants[0]?.id ?? "")).toBe(true);
    await running;
    expect(device.last()).toEqual({
      t: "dev.error",
      req: "k1",
      error: "access_denied",
    });
    await device.seat.handle({ ...call(), req: "k2" });
    expect(device.last()).toMatchObject({ req: "k2", error: "access_denied" });
    expect(broker.revoke("gone")).toBe(false);
  });

  it("takes a seat's request and grant with it when the seat leaves", async () => {
    const { broker, device } = await granted();
    const other = seatOf(broker, "s2", "second");
    await other.seat.handle({ t: "dev.begin", req: "b1", want: [] });
    expect(broker.state.pending).toHaveLength(1);
    device.seat.close();
    other.seat.close();
    expect(broker.state).toEqual({ pending: [], grants: [] });
  });

  it("ends every request and grant with the session, and takes no more", async () => {
    const { broker, device } = await granted();
    const heard: number[] = [];
    broker.subscribe((state) => heard.push(state.grants.length));
    broker.end();
    expect(broker.state).toEqual({ pending: [], grants: [] });
    expect(heard.at(-1)).toBe(0);
    await device.seat.handle(call());
    expect(device.replies.filter((r) => r.t === "dev.result")).toEqual([]);
    const late = seatOf(broker, "s9");
    await late.seat.handle({ t: "dev.begin", req: "b1", want: [] });
    expect(late.replies).toEqual([]);
  });

  it("replaces a seat's grant when the owner allows a new request", async () => {
    const { broker, device } = await granted(["c-github"]);
    await device.seat.handle({ t: "dev.begin", req: "b2", want: [] });
    const [pending] = broker.state.pending;
    broker.approve(pending?.id ?? "", {
      connections: ["c-linear"],
      minutes: 5,
    });
    expect(broker.state.grants).toHaveLength(1);
    expect(broker.state.grants[0]?.connections).toEqual(["c-linear"]);
    await device.seat.handle(call("provider.read", "c-github"));
    expect(device.last()).toMatchObject({ error: "access_denied" });
  });
});
