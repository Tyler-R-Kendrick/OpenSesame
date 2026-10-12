import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
/**
 * Device authorization from the owner's side (ADR 0196): the request and its
 * codes, RFC 8628's polling rules, and the owner's answer.
 */
import { approveAs } from "./device-approval.test-support.js";
import {
  SESSION_MS,
  START,
  begin,
  seatOf,
  setup,
  useBrokerClock,
} from "./device-broker.test-support.js";
import {
  BEGIN_GAP_MS,
  DEVICE_CODE_TTL_MS,
  MAX_PENDING,
  POLL_SECONDS,
} from "./device-types.js";

beforeEach(useBrokerClock);
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

  it("does not let a seat ask again in a flood", async () => {
    const { broker } = setup();
    const device = seatOf(broker);
    const first = await begin(broker, device);
    for (const req of ["b2", "b3"])
      await device.seat.handle({ t: "dev.begin", req, want: [] });
    expect(device.last()).toEqual({
      t: "dev.error",
      req: "b3",
      error: "temporarily_unavailable",
    });
    // The first request stands, untouched.
    expect(broker.state.pending.map((one) => one.userCode)).toEqual([
      first.code.userCode,
    ]);
  });

  it("lets a seat hold one question: a new one replaces the old", async () => {
    const { broker } = setup();
    const device = seatOf(broker);
    const first = await begin(broker, device);
    await vi.advanceTimersByTimeAsync(BEGIN_GAP_MS);
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
      await approveAs(broker, "nope", {
        connections: ["c-github"],
        minutes: 5,
      }),
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
    const result = await approveAs(broker, pending.id, {
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
    await approveAs(broker, pending.id, {
      connections: ["c-github"],
      minutes: 30,
    });
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
    await approveAs(broker, pending.id, {
      connections: ["c-github"],
      minutes: 100_000,
    });
    expect(broker.state.grants[0]?.expiresAt).toBe(START + SESSION_MS);
  });

  it("refuses an approval with nothing to grant, a stale one and an unknown one", async () => {
    const { broker } = setup();
    const device = seatOf(broker);
    const { pending } = await begin(broker, device);
    expect(
      await approveAs(broker, pending.id, { connections: [], minutes: 5 }),
    ).toBe("nothing_chosen");
    expect(
      await approveAs(broker, pending.id, {
        connections: ["c-gone"],
        minutes: 5,
      }),
    ).toBe("nothing_chosen");
    expect(
      await approveAs(broker, "unknown", {
        connections: ["c-github"],
        minutes: 5,
      }),
    ).toBe("unknown");
    expect(broker.state.pending).toHaveLength(1);
    expect(broker.state.grants).toEqual([]);
    await vi.advanceTimersByTimeAsync(DEVICE_CODE_TTL_MS);
    expect(
      await approveAs(broker, pending.id, {
        connections: ["c-github"],
        minutes: 5,
      }),
    ).toBe("lapsed");
  });

  it("will not grant once the connections went away", async () => {
    const { broker, held } = setup();
    const device = seatOf(broker);
    const { pending } = await begin(broker, device);
    held.port = null;
    expect(
      await approveAs(broker, pending.id, {
        connections: ["c-github"],
        minutes: 5,
      }),
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
      await approveAs(broker, pending.id, {
        connections: ["c-github"],
        minutes: 5,
      }),
    ).toBe("lapsed");
  });
});
