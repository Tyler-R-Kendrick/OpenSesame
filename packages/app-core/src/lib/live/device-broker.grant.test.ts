import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionConnection } from "./connection-port.js";
/**
 * What a grant lets a device do — and nothing else (ADR 0195): the checks every
 * call passes, the limits, the ways a grant ends, and the promise that
 * everything the broker sends is something the device's reader accepts.
 */
import { approveAs } from "./device-approval.test-support.js";
import {
  GITHUB,
  LINEAR,
  START,
  begin,
  call,
  granted,
  seatOf,
  setup,
  useBrokerClock,
} from "./device-broker.test-support.js";
import { CALLS_PER_MINUTE, MAX_IN_FLIGHT } from "./device-types.js";
import { deferred } from "./live-clock.fixture.js";
import { readChannelMessage } from "./messages.js";

beforeEach(useBrokerClock);
afterEach(() => {
  vi.useRealTimers();
});

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
    await approveAs(world.broker, pending.id, {
      connections: ["c-github"],
      minutes: 1,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await device.seat.handle(call());
    expect(device.last()).toMatchObject({ error: "access_denied" });
    expect(world.broker.state.grants).toEqual([]);
  });

  it("answers expired_token to a grant found lapsed before its timer", async () => {
    const world = setup();
    const device = seatOf(world.broker);
    const { pending } = await begin(world.broker, device);
    await approveAs(world.broker, pending.id, {
      connections: ["c-github"],
      minutes: 1,
    });
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
    await approveAs(broker, pending?.id ?? "", {
      connections: ["c-linear"],
      minutes: 5,
    });
    expect(broker.state.grants).toHaveLength(1);
    expect(broker.state.grants[0]?.connections).toEqual(["c-linear"]);
    await device.seat.handle(call("provider.read", "c-github"));
    expect(device.last()).toMatchObject({ error: "access_denied" });
  });
});

describe("what it sends", () => {
  it("is always something the device's reader accepts, whatever the connections are called", async () => {
    const messy: SessionConnection = {
      id: "c-messy",
      label: "Work\u202E\n\u0000 GitHub ",
      provider: "git hub",
      operations: ["provider.read", "Not An Op", "provider.secret.read"],
    };
    const unnameable: SessionConnection = {
      id: "has a space",
      label: "x",
      provider: "p",
      operations: ["provider.read"],
    };
    const { broker } = setup(undefined, [messy, unnameable, GITHUB]);
    const device = seatOf(broker);
    const { pending } = await begin(broker, device);
    await approveAs(broker, pending.id, {
      connections: ["c-messy", "has a space", "c-github"],
      minutes: 5,
    });
    await device.seat.handle({ t: "dev.list", req: "l1" });
    await device.seat.handle({
      t: "dev.call",
      req: "k1",
      connection: "c-messy",
      operation: "provider.read",
      input: {},
    });
    await device.seat.handle({ t: "dev.list", req: "l2" });
    expect(device.replies.map((reply) => reply.t)).toEqual([
      "dev.code",
      "dev.auth",
      "dev.conns",
      "dev.result",
      "dev.conns",
    ]);
    for (const reply of device.replies)
      expect(readChannelMessage(JSON.stringify(reply))).toEqual(reply);
    const listed = device.replies.find((reply) => reply.t === "dev.conns");
    expect(listed?.t === "dev.conns" ? listed.connections : []).toEqual([
      {
        id: "c-messy",
        label: "Work GitHub",
        provider: "other",
        operations: ["provider.read"],
      },
      GITHUB,
    ]);
  });
});
