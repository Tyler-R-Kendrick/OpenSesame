import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  nativeStreamChannel,
  wantsNativeStream,
} from "./controller-native-stream.js";
import {
  url,
  type Fixture,
  begin,
  credit,
  fixture,
  frame,
  head,
} from "./controller-native-stream.test-support.js";
import type { NativeRequest } from "./protocol.js";
let f: Fixture;
beforeEach(() => {
  f = fixture();
});
afterEach(() => {
  f.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("gives each stream a frozen channel that sends only its own commands", () => {
  const sent: unknown[] = [];
  const request: NativeRequest = {
    method: "GET",
    url,
    headers: [],
    body: new Uint8Array(),
  };
  const channel = nativeStreamChannel(
    { postMessage: (message) => sent.push(message) },
    7,
    request,
  );
  channel.open();
  channel.pull(1);
  channel.cancel();
  expect(Object.isFrozen(channel)).toBe(true);
  expect(Object.keys(channel).sort()).toEqual(["cancel", "open", "pull"]);
  expect(sent).toEqual([
    { kind: "nativeHTTPStream", id: 7, request },
    { kind: "pullHTTP", id: 7, sequence: 1 },
    { kind: "cancelHTTP", id: 7 },
  ]);
});
it("returns exact headers before an indefinite body and grants no eager credit", async () => {
  const { pending } = await begin(f);
  f.emit(head());
  const response = await pending;
  expect(response.url).toBe(url);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  await Promise.resolve();
  expect(f.sent.filter((m) => m.kind === "pullHTTP")).toHaveLength(0);
  const reader = response.body?.getReader();
  const read = reader?.read();
  await credit(f);
  const body = new Uint8Array([0xe2, 0x82]);
  f.emit(frame(1, 1, body));
  body.fill(0);
  expect((await read)?.value).toEqual(new Uint8Array([0xe2, 0x82]));
  expect(f.sent.filter((m) => m.kind === "pullHTTP")).toHaveLength(1);
  const second = reader?.read();
  await credit(f, 1, 2);
  f.emit(frame(1, 2, new Uint8Array([0xac]), true));
  expect((await second)?.value).toEqual(new Uint8Array([0xac]));
  expect((await reader?.read())?.done).toBe(true);
  expect(f.sent.filter((m) => m.kind === "cancelHTTP")).toHaveLength(0);
});
it("preserves fragmented UTF8 through a single decoder until exact EOF", async () => {
  const { pending } = await begin(f);
  f.emit(head());
  const response = await pending;
  const text = response.text();
  const bytes = new TextEncoder().encode("data: 雪€\n\n");
  for (let i = 0; i < bytes.length; i++) {
    await credit(f, 1, i + 1);
    f.emit(frame(1, i + 1, bytes.slice(i, i + 1), i === bytes.length - 1));
  }
  expect(await text).toBe("data: 雪€\n\n");
});
it.each(["caller", "owner", "close", "cancel"])(
  "withdraws the original %s after headers and refuses late data",
  async (reason) => {
    const caller = new AbortController();
    const { pending } = await begin(f, caller.signal);
    f.emit(head());
    const reader = (await pending).body?.getReader();
    const read = reader?.read();
    const rejected =
      reason === "cancel" ? undefined : expect(read).rejects.toThrow();
    await credit(f);
    if (reason === "caller") caller.abort();
    if (reason === "owner") f.withdraw();
    if (reason === "close") f.close();
    if (reason === "cancel") await reader?.cancel();
    f.emit(frame());
    if (reason === "cancel") expect((await read)?.done).toBe(true);
    else await rejected;
    expect(f.sent).toContainEqual({ kind: "cancelHTTP", id: 1 });
    expect(f.stop).not.toHaveBeenCalled();
  },
);
it.each([
  "duplicate-head",
  "wrong-url",
  "before-credit",
  "replay",
  "worker-error",
])("rejects %s without changing original ownership", async (reason) => {
  const { pending } = await begin(f);
  if (reason === "wrong-url") {
    const rejected = expect(pending).rejects.toThrow();
    f.emit(head(1, { url: "https://other.example/events" }));
    await rejected;
    return;
  }
  f.emit(head());
  const reader = (await pending).body?.getReader();
  if (reason === "before-credit") f.emit(frame());
  const read = reader?.read();
  const rejected = expect(read).rejects.toThrow();
  if (reason !== "before-credit") await credit(f);
  if (reason === "duplicate-head") f.emit(head());
  if (reason === "worker-error") f.emit({ kind: "nativeHTTPError", id: 1 });
  if (reason === "replay") f.emit(frame(1, 2));
  await rejected;
  expect(f.sent).toContainEqual({ kind: "cancelHTTP", id: 1 });
});
it("retains shared four-slot capacity through idle headers and releases on EOF", async () => {
  const responses: Response[] = [];
  for (let id = 1; id <= 4; id++) {
    f.sent.length = 0;
    const { pending } = await begin(f);
    f.emit(head(id));
    responses.push(await pending);
  }
  const extra = f.requests
    .capture(new AbortController().signal)
    .fetch(url, { headers: { accept: "text/event-stream" } });
  await vi.waitFor(() =>
    expect(f.sent.filter((m) => m.kind === "nativeHTTPReady")).toHaveLength(2),
  );
  f.emit({ kind: "nativeHTTPReady", ready: true });
  await expect(extra).rejects.toThrow("capacity");
  const reader = responses[0].body?.getReader();
  const read = reader?.read();
  await credit(f);
  f.emit(frame(1, 1, new Uint8Array(), true));
  await read;
  f.sent.length = 0;
  const { pending } = await begin(f);
  expect(f.sent).toContainEqual(
    expect.objectContaining({ kind: "nativeHTTPStream", id: 5 }),
  );
  f.emit(head(5));
  await pending;
});
it("limits accumulated streamed bytes to four MiB", async () => {
  const { pending } = await begin(f);
  f.emit(head());
  const reader = (await pending).body?.getReader();
  for (let sequence = 1; sequence <= 128; sequence++) {
    const read = reader?.read();
    await credit(f, 1, sequence);
    f.emit(frame(1, sequence, new Uint8Array(32768)));
    expect((await read)?.value?.byteLength).toBe(32768);
  }
  const read = reader?.read();
  const rejected = expect(read).rejects.toThrow();
  await credit(f, 1, 129);
  f.emit(frame(1, 129));
  await rejected;
});
it("expires idle headers at the original caller deadline without resetting after headers", async () => {
  vi.useFakeTimers();
  let admittedAt = 0;
  vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    expect(milliseconds).toBe(30_000);
    admittedAt = Date.now();
    const deadline = new AbortController();
    setTimeout(() => deadline.abort(), milliseconds);
    return deadline.signal;
  });
  const pending = f.requests
    .capture(new AbortController().signal)
    .fetch(url, { headers: { accept: "text/event-stream" } });
  await vi.waitFor(() =>
    expect(f.sent).toContainEqual({ kind: "nativeHTTPReady" }),
  );
  f.emit({ kind: "nativeHTTPReady", ready: true });
  await vi.waitFor(() =>
    expect(f.sent).toContainEqual(
      expect.objectContaining({ kind: "nativeHTTPStream" }),
    ),
  );
  vi.advanceTimersByTime(20_000);
  f.emit(head());
  const reader = (await pending).body?.getReader();
  vi.advanceTimersByTime(29_999 - (Date.now() - admittedAt));
  expect(f.sent.some((m) => m.kind === "cancelHTTP")).toBe(false);
  vi.advanceTimersByTime(1);
  await expect(reader?.read()).rejects.toThrow();
  expect(f.sent).toContainEqual({ kind: "cancelHTTP", id: 1 });
});
it("preserves an actual HTTP authorization error response body", async () => {
  const { pending } = await begin(f);
  f.emit(head(1, { status: 401, statusText: "Unauthorized" }));
  const response = await pending;
  expect(response.status).toBe(401);
  const body = response.text();
  await credit(f);
  f.emit(frame(1, 1, new TextEncoder().encode("permission denied"), true));
  expect(await body).toBe("permission denied");
});
it.each([204, 205, 304])(
  "settles bodyless %s without a pull or retained slot",
  async (status) => {
    const { pending } = await begin(f);
    f.emit(head(1, { status }));
    expect((await pending).body).toBeNull();
    expect(f.sent.some((m) => m.kind === "pullHTTP")).toBe(false);
    expect(f.sent.filter((m) => m.kind === "cancelHTTP")).toEqual([
      { kind: "cancelHTTP", id: 1 },
    ]);
  },
);
it.each([
  ["GET", "text/event-stream", true],
  ["POST", "application/json, Text/Event-Stream; charset=utf-8", true],
  ["HEAD", "text/event-stream", false],
  ["GET", "application/json", false],
  ["GET", "text/event-streaming", false],
])("selects %s Accept %s deliberately", (method, accept, expected) => {
  expect(
    wantsNativeStream(new Request(url, { method, headers: { accept } })),
  ).toBe(expected);
});

it("retires bodyless responses upstream without waiting for a pull or the thirty-second deadline", async () => {
  const upstream = new Set<number>();
  f.dispatch((message) => {
    if (message.kind === "nativeHTTPReady")
      f.emit({ kind: "nativeHTTPReady", ready: true });
    else if (message.kind === "cancelHTTP") upstream.delete(message.id);
    else if (message.kind === "nativeHTTPStream") {
      if (upstream.size >= 4)
        f.emit({ kind: "nativeHTTPError", id: message.id });
      else {
        upstream.add(message.id);
        f.emit(head(message.id, { status: 204 }));
      }
    }
  });
  const port = f.requests.capture(new AbortController().signal);
  for (let id = 1; id <= 6; id++) {
    const response = await port.fetch(url, {
      headers: { accept: "text/event-stream" },
    });
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(upstream.size).toBe(0);
    expect(f.sent).toContainEqual({ kind: "cancelHTTP", id });
  }
  expect(f.sent.some((message) => message.kind === "pullHTTP")).toBe(false);
  expect(f.stop).not.toHaveBeenCalled();
});
