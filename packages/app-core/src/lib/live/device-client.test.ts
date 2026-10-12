/**
 * A device's side of the authorization flow (ADR 0195), against a pipe the
 * test plays the owner's tab on: RFC 8628's waiting, the owner's answer
 * arriving by push or by poll, and every way an ask can come to nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DeviceClient,
  DeviceError,
  type DevicePipe,
  REPLY_MS,
} from "./device-client.js";
import type { DeviceMessage, DeviceRequest } from "./device-messages.js";
import { FAKE_CLOCK } from "./live-clock.fixture.js";

const CODE = {
  t: "dev.code",
  deviceCode: "D".repeat(22),
  userCode: "BCDF-GHJK",
  expiresIn: 600,
  interval: 5,
} as const;
const CONNECTION = {
  id: "c-1",
  label: "GitHub",
  provider: "github",
  operations: ["provider.read"],
};

function pipe() {
  const sent: DeviceRequest[] = [];
  let hear: (message: DeviceMessage) => void = () => undefined;
  let end: () => void = () => undefined;
  let open = true;
  const made: DevicePipe = {
    send: (request) => {
      if (!open) return false;
      sent.push(request);
      return true;
    },
    onMessage: (handler) => {
      hear = handler;
    },
    onEnd: (handler) => {
      end = handler;
    },
  };
  return {
    made,
    sent,
    reply: (message: DeviceMessage) => hear(message),
    end: () => end(),
    shut: () => {
      open = false;
    },
    last: () => sent[sent.length - 1],
  };
}

beforeEach(() => {
  vi.useFakeTimers({ ...FAKE_CLOCK, now: 1_800_000_000_000 });
});
afterEach(() => {
  vi.useRealTimers();
});

async function begun(owner: ReturnType<typeof pipe>, want?: string[]) {
  const client = new DeviceClient(owner.made);
  const codes: string[] = [];
  const granted = client.authorize({
    want: want ?? [],
    onCode: (view) => codes.push(view.userCode),
  });
  // Observe a rejection at once; the test reads it where it expects it.
  granted.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(0);
  const request = owner.last();
  if (request?.t !== "dev.begin") throw new Error("no begin");
  owner.reply({ ...CODE, req: request.req });
  await vi.advanceTimersByTimeAsync(0);
  return { client, granted, codes, begin: request };
}

describe("authorizing", () => {
  it("asks, shows the code, and takes the owner's push", async () => {
    const owner = pipe();
    const { granted, codes, begin } = await begun(owner, ["c-1"]);
    expect(begin).toMatchObject({ want: ["c-1"] });
    expect(codes).toEqual(["BCDF-GHJK"]);
    owner.reply({
      t: "dev.auth",
      req: begin.req,
      state: "granted",
      expiresAt: 5,
      connections: [CONNECTION],
    });
    await expect(granted).resolves.toEqual({
      expiresAt: 5,
      connections: [CONNECTION],
    });
    // No poll was needed.
    expect(owner.sent.map((request) => request.t)).toEqual(["dev.begin"]);
  });

  it("polls on the interval it was given, and takes a grant from the poll", async () => {
    const owner = pipe();
    const { granted } = await begun(owner);
    await vi.advanceTimersByTimeAsync(5000);
    const poll = owner.last();
    expect(poll).toMatchObject({ t: "dev.poll", deviceCode: CODE.deviceCode });
    owner.reply({
      t: "dev.auth",
      req: poll?.req ?? "",
      state: "authorization_pending",
    });
    await vi.advanceTimersByTimeAsync(5000);
    const again = owner.last();
    expect(again?.req).not.toBe(poll?.req);
    owner.reply({
      t: "dev.auth",
      req: again?.req ?? "",
      state: "granted",
      expiresAt: 9,
      connections: [],
    });
    await expect(granted).resolves.toMatchObject({ expiresAt: 9 });
  });

  it("waits longer when told to slow down", async () => {
    const owner = pipe();
    const { granted } = await begun(owner);
    await vi.advanceTimersByTimeAsync(5000);
    const poll = owner.last();
    owner.reply({
      t: "dev.auth",
      req: poll?.req ?? "",
      state: "slow_down",
      interval: 15,
    });
    await vi.advanceTimersByTimeAsync(14_000);
    expect(
      owner.sent.filter((request) => request.t === "dev.poll"),
    ).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    const next = owner.last();
    expect(
      owner.sent.filter((request) => request.t === "dev.poll"),
    ).toHaveLength(2);
    owner.reply({
      t: "dev.auth",
      req: next?.req ?? "",
      state: "granted",
      expiresAt: 1,
      connections: [],
    });
    await granted;
  });

  it("fails with the owner's refusal, pushed or polled", async () => {
    const pushed = pipe();
    const first = await begun(pushed);
    pushed.reply({
      t: "dev.auth",
      req: first.begin.req,
      state: "access_denied",
    });
    await expect(first.granted).rejects.toMatchObject({
      code: "access_denied",
    });

    const polled = pipe();
    const second = await begun(polled);
    await vi.advanceTimersByTimeAsync(5000);
    polled.reply({
      t: "dev.auth",
      req: polled.last()?.req ?? "",
      state: "expired_token",
    });
    await expect(second.granted).rejects.toMatchObject({
      code: "expired_token",
    });
  });

  it("gives up on its own when the request lapses unanswered", async () => {
    const owner = pipe();
    const { granted } = await begun(owner);
    // The owner's tab is gone quiet: each poll goes unanswered until it lapses.
    const outcome = granted.then(
      () => null,
      (error) => error,
    );
    await vi.advanceTimersByTimeAsync(10 * 60_000 + REPLY_MS);
    expect(await outcome).toBeInstanceOf(DeviceError);
  });

  it("fails when the owner refuses the ask outright", async () => {
    const owner = pipe();
    const client = new DeviceClient(owner.made);
    const granted = client.authorize();
    granted.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    owner.reply({
      t: "dev.error",
      req: owner.last()?.req ?? "",
      error: "temporarily_unavailable",
    });
    await expect(granted).rejects.toMatchObject({
      code: "temporarily_unavailable",
    });
  });

  it("stops waiting when told to", async () => {
    const owner = pipe();
    const controller = new AbortController();
    const client = new DeviceClient(owner.made);
    const granted = client.authorize({ signal: controller.signal });
    granted.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    owner.reply({ ...CODE, req: owner.last()?.req ?? "" });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await expect(granted).rejects.toMatchObject({ code: "aborted" });
  });
});

describe("asking for connections and making calls", () => {
  it("lists the connections", async () => {
    const owner = pipe();
    const client = new DeviceClient(owner.made);
    const listed = client.connections();
    await vi.advanceTimersByTimeAsync(0);
    owner.reply({
      t: "dev.conns",
      req: owner.last()?.req ?? "",
      connections: [CONNECTION],
    });
    await expect(listed).resolves.toEqual([CONNECTION]);
  });

  it("makes a call and hands back its lines", async () => {
    const owner = pipe();
    const client = new DeviceClient(owner.made);
    const called = client.call("c-1", "provider.read", { page: "1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(owner.last()).toMatchObject({
      t: "dev.call",
      connection: "c-1",
      operation: "provider.read",
      input: { page: "1" },
    });
    owner.reply({
      t: "dev.result",
      req: owner.last()?.req ?? "",
      label: "Repos",
      items: [{ id: "a", label: "a" }],
      truncated: true,
    });
    await expect(called).resolves.toEqual({
      label: "Repos",
      items: [{ id: "a", label: "a" }],
      truncated: true,
    });
  });

  it("fails a call with the owner's code, and does not mix up two", async () => {
    const owner = pipe();
    const client = new DeviceClient(owner.made);
    const first = client.call("c-1", "provider.read");
    const second = client.call("c-2", "provider.read");
    first.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    const [one, two] = owner.sent;
    owner.reply({
      t: "dev.error",
      req: two?.req ?? "",
      error: "access_denied",
    });
    owner.reply({
      t: "dev.result",
      req: one?.req ?? "",
      label: "L",
      items: [],
      truncated: false,
    });
    await expect(second).rejects.toMatchObject({ code: "access_denied" });
    await expect(first).resolves.toMatchObject({ label: "L" });
  });

  it("fails an ask whose answer is the wrong kind", async () => {
    const owner = pipe();
    const client = new DeviceClient(owner.made);
    const called = client.call("c-1", "provider.read");
    await vi.advanceTimersByTimeAsync(0);
    owner.reply({
      t: "dev.conns",
      req: owner.last()?.req ?? "",
      connections: [],
    });
    await expect(called).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("ignores an answer to nothing it asked, and a request sent back", async () => {
    const owner = pipe();
    const client = new DeviceClient(owner.made);
    const called = client.call("c-1", "provider.read");
    await vi.advanceTimersByTimeAsync(0);
    owner.reply({ t: "dev.error", req: "nope", error: "access_denied" });
    owner.reply({ t: "dev.list", req: owner.last()?.req ?? "" });
    owner.reply({
      t: "dev.result",
      req: owner.last()?.req ?? "",
      label: "L",
      items: [],
      truncated: false,
    });
    await expect(called).resolves.toMatchObject({ label: "L" });
  });

  it("times out an ask nobody answers, and forgets it", async () => {
    const owner = pipe();
    const client = new DeviceClient(owner.made, { replyMs: 1000 });
    const called = client.call("c-1", "provider.read");
    called.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(called).rejects.toMatchObject({ code: "timeout" });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("when the channel goes", () => {
  it("fails every ask still out, and every later one", async () => {
    const owner = pipe();
    const client = new DeviceClient(owner.made);
    const called = client.call("c-1", "provider.read");
    const listed = client.connections();
    called.catch(() => undefined);
    listed.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    owner.end();
    await expect(called).rejects.toMatchObject({ code: "channel_closed" });
    await expect(listed).rejects.toMatchObject({ code: "channel_closed" });
    await expect(client.connections()).rejects.toMatchObject({
      code: "channel_closed",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops waiting for the owner at once, instead of finishing its wait", async () => {
    const owner = pipe();
    const { granted } = await begun(owner);
    owner.end();
    // Nowhere near the five seconds the wait was set for.
    await vi.advanceTimersByTimeAsync(10);
    await expect(granted).rejects.toMatchObject({ code: "channel_closed" });
  });

  it("fails an ask whose frame did not go out", async () => {
    const owner = pipe();
    owner.shut();
    const client = new DeviceClient(owner.made);
    await expect(client.connections()).rejects.toMatchObject({
      code: "channel_closed",
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
