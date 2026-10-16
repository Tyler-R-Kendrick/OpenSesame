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
