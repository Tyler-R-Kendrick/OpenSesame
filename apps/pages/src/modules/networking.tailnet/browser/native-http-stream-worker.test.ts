/** @vitest-environment node */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  chunk,
  fixture,
  head,
  request,
  settle,
} from "./native-http-stream-worker.test-support.js";
import {
  HostMessage,
  type NativeStreamChunk,
  WorkerMessage,
} from "./protocol.js";
import type { NativeHTTPClient } from "./sdk.js";
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  vi.resetModules();
  f = await fixture();
});
afterEach(async () => {
  f.close();
  await settle();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("publishes headers before held body and grants no unrequested credit", async () => {
  const input = request();
  f.send({ kind: "nativeHTTPStream", id: 1, request: input });
  input.headers[0][1] = "changed";
  const original = head();
  await f.headers(1, original);
  original.headers[0][1] = "mutated after publication";
  expect(f.opened.get(1)?.request.headers).toEqual(request().headers);
  expect(f.sent).toEqual([{ kind: "nativeHTTPStream", id: 1, result: head() }]);
  expect(f.port.pullHTTP).not.toHaveBeenCalled();
  expect(f.opened.get(1)?.signal.aborted).toBe(false);
  f.send({ kind: "pullHTTP", id: 1, sequence: 1 });
  const packet = chunk();
  await f.frame(1, packet);
  packet.body[0] = 99;
  expect(f.sent.at(-1)).toEqual({
    kind: "nativeHTTPChunk",
    id: 1,
    result: chunk(),
  });
  expect(f.port.pullHTTP).toHaveBeenCalledTimes(1);
});
it("retains open streams in the same four-slot registry as buffered operations", async () => {
  f.stream();
  await f.headers();
  for (let id = 2; id <= 4; id++)
    f.send({ kind: "nativeHTTP", id, request: request() });
  f.stream(5);
  expect(f.port.nativeHTTP).toHaveBeenCalledTimes(3);
  expect(f.port.nativeHTTPStream).toHaveBeenCalledTimes(1);
  expect(f.port.cancelHTTP).toHaveBeenCalledWith(5);
  f.send({ kind: "pullHTTP", id: 1, sequence: 1 });
  await f.frame(1, { ...chunk(), body: new Uint8Array(), eof: true });
  f.stream(5);
  expect(f.port.nativeHTTPStream).toHaveBeenCalledTimes(1);
  f.stream(6);
  expect(f.port.nativeHTTPStream).toHaveBeenCalledTimes(2);
  expect(f.client.logout).not.toHaveBeenCalled();
});
it.each(["concurrent", "wrong", "replay", "before-header", "buffered"])(
  "refuses an invalid %s credit without a second read",
  async (kind) => {
    if (kind === "buffered")
      f.send({ kind: "nativeHTTP", id: 1, request: request() });
    else {
      f.stream();
      if (kind !== "before-header") await f.headers();
    }
    if (["concurrent", "replay"].includes(kind)) {
      f.send({ kind: "pullHTTP", id: 1, sequence: 1 });
      if (kind === "replay") await f.frame();
    }
    f.send({ kind: "pullHTTP", id: 1, sequence: kind === "wrong" ? 2 : 1 });
    expect(f.port.pullHTTP).toHaveBeenCalledTimes(
      ["concurrent", "replay"].includes(kind) ? 1 : 0,
    );
    expect(f.port.cancelHTTP).toHaveBeenCalledWith(1);
    expect(f.sent.at(-1)).toEqual({ kind: "nativeHTTPError", id: 1 });
    const before = f.sent.length;
    if (f.credits.length) await f.frame();
    else if (f.opened.has(1)) await f.headers();
    expect(f.sent).toHaveLength(before);
  },
);
it.each(["oversized", "shared", "sequence"])(
  "rejects %s body frames before publication",
  async (kind) => {
    f.stream();
    await f.headers();
    f.send({ kind: "pullHTTP", id: 1, sequence: 1 });
    const value = chunk();
    if (kind === "oversized") value.body = new Uint8Array(32769);
    if (kind === "shared")
      value.body = new Uint8Array(new SharedArrayBuffer(1));
    if (kind === "sequence") value.sequence = 2;
    await f.frame(1, value);
    expect(f.sent.at(-1)).toEqual({ kind: "nativeHTTPError", id: 1 });
    expect(f.sent.some((item) => item.kind === "nativeHTTPChunk")).toBe(false);
    expect(f.opened.get(1)?.signal.aborted).toBe(true);
  },
);
it("bounds actual accumulated bytes to four MiB", async () => {
  f.stream();
  await f.headers();
  for (let sequence = 1; sequence <= 128; sequence++) {
    f.send({ kind: "pullHTTP", id: 1, sequence });
    await f.frame(1, { sequence, body: new Uint8Array(32768), eof: false });
  }
  expect(f.sent.filter((item) => item.kind === "nativeHTTPChunk")).toHaveLength(
    128,
  );
  f.send({ kind: "pullHTTP", id: 1, sequence: 129 });
  await f.frame(1, { sequence: 129, body: new Uint8Array(1), eof: true });
  expect(f.sent.at(-1)).toEqual({ kind: "nativeHTTPError", id: 1 });
  expect(f.port.cancelHTTP).toHaveBeenCalledWith(1);
});
it("cancels only original A while B and ordinary peer callbacks remain usable", async () => {
  f.stream(1);
  f.stream(2);
  await f.headers(1);
  await f.headers(2);
  f.send({ kind: "pullHTTP", id: 1, sequence: 1 });
  f.send({ kind: "pullHTTP", id: 2, sequence: 1 });
  f.send({ kind: "cancelHTTP", id: 1 });
  expect(f.opened.get(1)?.signal.aborted).toBe(true);
  expect(f.opened.get(2)?.signal.aborted).toBe(false);
  await f.frame(1);
  await f.frame(2, { ...chunk(), eof: true });
  expect(f.sent.filter((item) => item.kind === "nativeHTTPChunk")).toEqual([
    { kind: "nativeHTTPChunk", id: 2, result: { ...chunk(), eof: true } },
  ]);
  f.send({ kind: "login" });
  expect(f.client.login).toHaveBeenCalledOnce();
  expect(f.client.logout).not.toHaveBeenCalled();
});
it.each(["cancel", "close", "readiness", "port", "method"])(
  "refuses late chunks after %s withdrawal",
  async (kind) => {
    f.stream();
    await f.headers();
    f.send({ kind: "pullHTTP", id: 1, sequence: 1 });
    if (kind === "cancel") f.send({ kind: "cancelHTTP", id: 1 });
    if (kind === "close") f.send({ kind: "closeHTTP" });
    if (kind === "readiness") f.port.ready.mockReturnValue(false);
    if (kind === "port") f.client.nativeHTTP = { ...f.port };
    if (kind === "method")
      f.port.pullHTTP = vi
        .fn<(id: number, sequence: number) => Promise<NativeStreamChunk>>()
        .mockRejectedValue(new Error("replacement"));
    await f.frame();
    expect(f.sent.some((item) => item.kind === "nativeHTTPChunk")).toBe(false);
    expect(f.opened.get(1)?.signal.aborted).toBe(true);
  },
);
it("fences synchronous readiness cancellation and reentrant body copy", async () => {
  f.stream();
  await f.headers();
  f.send({ kind: "pullHTTP", id: 1, sequence: 1 });
  const value = chunk();
  value.body.slice = () => {
    f.send({ kind: "cancelHTTP", id: 1 });
    return new Uint8Array([9]);
  };
  await f.frame(1, value);
  expect(f.sent.some((item) => item.kind === "nativeHTTPChunk")).toBe(false);
  f.stream(2);
  f.port.ready.mockImplementationOnce(() => {
    f.send({ kind: "cancelHTTP", id: 2 });
    return true;
  });
  await f.headers(2);
  expect(
    f.sent.some((item) => item.kind === "nativeHTTPStream" && item.id === 2),
  ).toBe(false);
});
it("rejects withdrawal from the final original-port getter before publication", async () => {
  f.stream();
  let reads = 0;
  Object.defineProperty(f.client, "nativeHTTP", {
    get() {
      if (++reads === 4) f.send({ kind: "cancelHTTP", id: 1 });
      return f.port;
    },
  });
  await f.headers();
  expect(reads).toBe(4);
  expect(f.sent.some((item) => item.kind === "nativeHTTPStream")).toBe(false);
  expect(f.opened.get(1)?.signal.aborted).toBe(true);
});
it("rechecks captured method identity after the final readiness callback", async () => {
  f.stream();
  let checks = 0;
  f.port.ready.mockImplementation(() => {
    if (++checks === 2)
      f.port.pullHTTP = vi
        .fn<(id: number, sequence: number) => Promise<NativeStreamChunk>>()
        .mockRejectedValue(new Error("replacement"));
    return true;
  });
  await f.headers();
  expect(f.sent).toEqual([{ kind: "nativeHTTPError", id: 1 }]);
  expect(f.opened.get(1)?.signal.aborted).toBe(true);
});
it.each(["wrong-url", "status", "provider-error"])(
  "correlates %s errors without provider details",
  async (kind) => {
    f.stream();
    if (kind === "provider-error") {
      f.opened.get(1)?.reject(new Error("private-provider-body"));
      await settle();
    } else
      await f.headers(1, {
        ...head(),
        ...(kind === "wrong-url"
          ? { url: "https://other.example/sse" }
          : { status: 999 }),
      });
    expect(f.sent).toEqual([{ kind: "nativeHTTPError", id: 1 }]);
    expect(JSON.stringify(f.sent)).not.toContain("private-provider-body");
  },
);
it.each(["missing-open", "missing-pull", "buffered-only"])(
  "refuses streaming for %s ports while preserving their buffered capability",
  async (kind) => {
    const legacy: NativeHTTPClient = {
      ready: f.port.ready,
      nativeHTTP: f.port.nativeHTTP,
      cancelHTTP: f.port.cancelHTTP,
      closeHTTP: f.port.closeHTTP,
    };
    if (kind === "missing-open") legacy.pullHTTP = f.port.pullHTTP;
    if (kind === "missing-pull")
      legacy.nativeHTTPStream = f.port.nativeHTTPStream;
    f.client.nativeHTTP = legacy;
    f.stream(1);
    expect(f.sent).toEqual([{ kind: "nativeHTTPError", id: 1 }]);
    expect(f.port.nativeHTTPStream).not.toHaveBeenCalled();
    expect(f.port.pullHTTP).not.toHaveBeenCalled();
    f.send({ kind: "nativeHTTP", id: 2, request: request() });
    const held = f.buffered.get(2);
    if (!held) throw new Error("Buffered-only port was not admitted");
    held.resolve({ ...head(), body: new Uint8Array([7]) });
    await settle();
    expect(f.sent.at(-1)).toEqual({
      kind: "nativeHTTP",
      id: 2,
      result: { ...head(), body: new Uint8Array([7]) },
    });
  },
);
it("retains real provider HTTP authorization status instead of turning it into cancellation", async () => {
  f.stream();
  await f.headers(1, { ...head(), status: 401, statusText: "Unauthorized" });
  expect(f.sent).toEqual([
    {
      kind: "nativeHTTPStream",
      id: 1,
      result: { ...head(), status: 401, statusText: "Unauthorized" },
    },
  ]);
  expect(f.opened.get(1)?.signal.aborted).toBe(false);
});
it("retains the original thirty-second lifetime across idle headers and credits", async () => {
  vi.useFakeTimers();
  f.stream();
  await f.headers();
  vi.advanceTimersByTime(20_000);
  f.send({ kind: "pullHTTP", id: 1, sequence: 1 });
  await f.frame();
  vi.advanceTimersByTime(9_999);
  expect(f.opened.get(1)?.signal.aborted).toBe(false);
  expect(f.sent.some((item) => item.kind === "nativeHTTPError")).toBe(false);
  vi.advanceTimersByTime(1);
  expect(f.opened.get(1)?.signal.aborted).toBe(true);
  expect(f.sent.at(-1)).toEqual({ kind: "nativeHTTPError", id: 1 });
  expect(f.port.cancelHTTP).toHaveBeenCalledWith(1);
  f.stream(2);
  expect(f.opened.get(2)?.signal.aborted).toBe(false);
  expect(f.client.logout).not.toHaveBeenCalled();
});
it.each(["buffered", "eof", "cancel", "error"])(
  "clears the deadline after %s settlement",
  async (kind) => {
    vi.useFakeTimers();
    if (kind === "buffered") {
      f.send({ kind: "nativeHTTP", id: 1, request: request() });
      f.buffered.get(1)?.resolve({ ...head(), body: new Uint8Array([7]) });
      await settle();
    } else {
      f.stream();
      await f.headers();
      if (kind === "cancel") f.send({ kind: "cancelHTTP", id: 1 });
      else {
        f.send({ kind: "pullHTTP", id: 1, sequence: 1 });
        if (kind === "error") {
          f.credits[0].gate.reject(new Error("bounded provider failure"));
          await settle();
        } else await f.frame(1, { ...chunk(), eof: true });
      }
    }
    const messages = [...f.sent];
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(30_000);
    expect(f.sent).toEqual(messages);
  },
);
it("checks monotonic expiry before publication even when the timer has not run", async () => {
  f.stream();
  const now = performance.now();
  vi.spyOn(performance, "now").mockReturnValue(now + 30_001);
  await f.headers();
  expect(f.sent).toEqual([{ kind: "nativeHTTPError", id: 1 }]);
  expect(f.opened.get(1)?.signal.aborted).toBe(true);
});
it("protocol refuses unsafe identities, replacement fields and unbounded chunks", () => {
  for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(
      WorkerMessage.safeParse({
        kind: "nativeHTTPStream",
        id,
        request: request(),
      }).success,
    ).toBe(false);
    expect(
      WorkerMessage.safeParse({ kind: "pullHTTP", id: 1, sequence: id })
        .success,
    ).toBe(false);
  }
  expect(
    WorkerMessage.safeParse({
      kind: "pullHTTP",
      id: 1,
      sequence: 1,
      replacement: "foreign",
    }).success,
  ).toBe(false);
  expect(
    HostMessage.safeParse({
      kind: "nativeHTTPChunk",
      id: 1,
      result: { ...chunk(), body: new Uint8Array(32769) },
    }).success,
  ).toBe(false);
  expect(
    HostMessage.safeParse({
      kind: "nativeHTTPChunk",
      id: 1,
      result: { ...chunk(), replacement: true },
    }).success,
  ).toBe(false);
});
