/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { installWorkerEgress } from "./worker-egress.js";
const native = vi.fn(async () => new Response("fixture"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("authorizes every HTTP request, refuses redirect following and omits ambient cookies", async () => {
  vi.stubGlobal("fetch", native);
  const decide = vi.fn(async () => false);
  installWorkerEgress(decide, ["https://assets.example/runtime.wasm.gz"]);
  await expect(fetch("https://unapproved.example/secret")).rejects.toThrow(
    "denied",
  );
  expect(native).not.toHaveBeenCalled();
  decide.mockResolvedValue(true);
  await fetch("https://control.example/key", { method: "GET" });
  expect(decide).toHaveBeenCalledWith("https://control.example/key", "GET");
  expect(native).toHaveBeenCalledWith(expect.any(Request), {
    redirect: "error",
    credentials: "omit",
  });
  await expect(fetch("data:text/plain,unexpected")).rejects.toThrow("denied");
});
it("never constructs a native WebSocket until its exact URL is approved", async () => {
  const constructed = vi.fn();
  class Native extends EventTarget {
    constructor(url: string) {
      super();
      constructed(url);
    }
  }
  vi.stubGlobal("fetch", native);
  vi.stubGlobal("WebSocket", Native);
  let release: (allowed: boolean) => void = () => {};
  const decide = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
  );
  installWorkerEgress(decide, []);
  const socket = new WebSocket("wss://relay.example/derp", ["derp"]);
  expect(constructed).not.toHaveBeenCalled();
  expect(socket.readyState).toBe(0);
  release(false);
  await vi.waitFor(() => expect(socket.readyState).toBe(3));
  expect(constructed).not.toHaveBeenCalled();
  expect(decide).toHaveBeenCalledWith("wss://relay.example/derp", "CONNECT");
});
it("cancellation before an asynchronous socket grant prevents any late construction", async () => {
  const constructed = vi.fn();
  class Native extends EventTarget {
    constructor(url: string) {
      super();
      constructed(url);
    }
  }
  vi.stubGlobal("fetch", native);
  vi.stubGlobal("WebSocket", Native);
  let release: (allowed: boolean) => void = () => {};
  installWorkerEgress(
    () =>
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
    [],
  );
  const socket = new WebSocket("wss://relay.example/derp");
  socket.close();
  release(true);
  await Promise.resolve();
  expect(constructed).not.toHaveBeenCalled();
  expect(socket.readyState).toBe(3);
});

it("settles the original empty HEAD stream before publishing a metadata-preserving readable response", async () => {
  let finish: () => void = () => {};
  const original = new Response(
    new ReadableStream({
      start(controller) {
        finish = () => controller.close();
      },
    }),
    { status: 200, statusText: "Probe", headers: { "x-probe": "actual" } },
  );
  const fetcher = vi.fn(async () => original);
  vi.stubGlobal("fetch", fetcher);
  installWorkerEgress(async () => true, []);
  let published = false;
  const pending = fetch("https://relay.example/derp/probe", {
    method: "HEAD",
  }).then((response) => {
    published = true;
    return response;
  });
  await vi.waitFor(() => expect(original.bodyUsed).toBe(true));
  expect(published).toBe(false);
  finish();
  const returned = await pending;
  expect(returned).not.toBe(original);
  expect({
    url: returned.url,
    type: returned.type,
    redirected: returned.redirected,
    status: returned.status,
    statusText: returned.statusText,
    headers: [...returned.headers],
  }).toEqual({
    url: original.url,
    type: original.type,
    redirected: original.redirected,
    status: original.status,
    statusText: original.statusText,
    headers: [...original.headers],
  });
  expect(returned.bodyUsed).toBe(false);
  const reader = returned.body?.getReader();
  expect(await reader?.read()).toEqual({ done: true, value: undefined });
  reader?.releaseLock();
});

it.each(["GET", "POST"])(
  "leaves a bodyful %s response identical and unread for the original caller",
  async (method) => {
    const original = new Response("provider-body", {
      headers: { "x-original": "preserved" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => original),
    );
    installWorkerEgress(async () => true, []);
    const returned = await fetch("https://relay.example/resource", {
      method,
    });
    expect(returned).toBe(original);
    expect(original.bodyUsed).toBe(false);
    expect(await returned.text()).toBe("provider-body");
  },
);

it("preserves an unsuccessful HEAD status without manufacturing success", async () => {
  const original = new Response(null, {
    status: 403,
    statusText: "Forbidden",
    headers: { "x-refused": "true" },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => original),
  );
  installWorkerEgress(async () => true, []);
  const returned = await fetch("https://relay.example/derp/probe", {
    method: "HEAD",
  });
  expect(returned.status).toBe(403);
  expect(returned.statusText).toBe("Forbidden");
  expect(returned.ok).toBe(false);
  expect(returned.headers.get("x-refused")).toBe("true");
  expect((await returned.arrayBuffer()).byteLength).toBe(0);
});

it.each([
  new DOMException("original owner cancelled", "AbortError"),
  new TypeError("actual browser CORS refusal"),
])(
  "propagates original pre-header abort or CORS failure unchanged",
  async (error) => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
    installWorkerEgress(async () => true, []);
    await expect(
      fetch("https://relay.example/derp/probe", { method: "HEAD" }),
    ).rejects.toBe(error);
  },
);

it("refuses a HEAD result when its original signal aborts during empty-stream settlement", async () => {
  let finish: () => void = () => {};
  const original = new Response(
    new ReadableStream({
      start(controller) {
        finish = () => controller.close();
      },
    }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => original),
  );
  installWorkerEgress(async () => true, []);
  const owner = new AbortController();
  const reason = new DOMException("original owner withdrew", "AbortError");
  const pending = fetch("https://relay.example/derp/probe", {
    method: "HEAD",
    signal: owner.signal,
  });
  const rejection = expect(pending).rejects.toBe(reason);
  await vi.waitFor(() => expect(original.bodyUsed).toBe(true));
  owner.abort(reason);
  finish();
  await rejection;
});
