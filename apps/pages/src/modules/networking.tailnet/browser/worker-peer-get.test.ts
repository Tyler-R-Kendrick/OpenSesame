import { expect, it, vi } from "vitest";
import type { NativeResponse } from "./protocol.js";
import type { NativePeerGETClient } from "./sdk-peer-get.js";
import { WorkerPeerGET } from "./worker-peer-get.js";
function fixture(protocol = "http:") {
  const url = `${protocol}//100.64.0.1/proof`;
  let resolve: ((value: NativeResponse) => void) | undefined;
  let retire: ((value: boolean) => void) | undefined;
  const pending = new Promise<NativeResponse>((done) => {
    resolve = done;
  });
  const closing = new Promise<boolean>((done) => {
    retire = done;
  });
  const port: NativePeerGETClient = {
    ready: () => true,
    nativeHTTP: vi.fn(() => pending),
    cancelHTTP: vi.fn(() => true),
    close: vi.fn(() => closing),
  };
  const node = { nativePeerGET: port };
  const post = vi.fn();
  // This substitutes only the existing SDK boundary. It is not actual WASM proof.
  const peer = new WorkerPeerGET(() => node, post);
  return {
    peer,
    port,
    url,
    node,
    post,
    resolve: (value: Partial<NativeResponse> = {}) =>
      resolve?.({
        status: 200,
        statusText: "OK",
        url,
        headers: [],
        body: new TextEncoder().encode("wire peer"),
        ...value,
      }),
    retire: (value = true) => retire?.(value),
  };
}
it.each(["http:", "https:"])(
  "uses dedicated %s peer GET independently of provider HTTPS transport",
  async (protocol) => {
    const f = fixture(protocol);
    f.peer.get(1, f.url);
    expect(f.port.nativeHTTP).toHaveBeenCalledWith(
      1,
      { method: "GET", url: f.url, headers: [], body: new Uint8Array() },
      expect.any(AbortSignal),
    );
    expect(f.node).not.toHaveProperty("nativeHTTP");
    f.resolve();
    await vi.waitFor(() =>
      expect(f.post).toHaveBeenCalledWith({
        kind: "get",
        id: 1,
        status: 200,
        text: "wire peer",
      }),
    );
    f.retire();
    await f.peer.close();
  },
);
it.each([
  { url: "http://100.64.0.2/proof" },
  { status: 302 },
  { body: new Uint8Array(1_000_001) },
])("refuses retargeted, redirected or oversized replies", async (reply) => {
  const f = fixture();
  f.peer.get(1, "http://100.64.0.1/proof");
  f.resolve(reply);
  await vi.waitFor(() =>
    expect(f.post).toHaveBeenCalledWith({ kind: "error" }),
  );
  expect(f.post).not.toHaveBeenCalledWith(
    expect.objectContaining({ kind: "get" }),
  );
  f.retire();
  await f.peer.close();
});
it("withdraws pending publication but awaits original physical close acknowledgement", async () => {
  const f = fixture();
  f.peer.get(1, "http://100.64.0.1/proof");
  let done = false;
  const closing = f.peer.close().then((value) => {
    done = true;
    return value;
  });
  f.resolve();
  await Promise.resolve();
  expect(done).toBe(false);
  expect(f.post).not.toHaveBeenCalledWith(
    expect.objectContaining({ kind: "get" }),
  );
  f.retire();
  await expect(closing).resolves.toBe(true);
});
it("rejects userinfo, unsupported schemes and consumed IDs before native requests", () => {
  const f = fixture();
  f.peer.get(1, "http://user:secret@100.64.0.1/proof");
  f.peer.get(2, "file:///secret");
  expect(f.port.nativeHTTP).not.toHaveBeenCalled();
  f.peer.get(3, "http://100.64.0.1/proof");
  f.peer.get(3, "http://100.64.0.1/proof");
  expect(f.port.nativeHTTP).toHaveBeenCalledTimes(1);
  f.retire();
  void f.peer.close();
});
it("withdraws a held HTTPS result when the original peer port changes", async () => {
  const f = fixture("https:");
  f.peer.get(1, f.url);
  f.node.nativePeerGET = { ...f.port };
  f.resolve();
  await vi.waitFor(() =>
    expect(f.post).toHaveBeenCalledWith({ kind: "error" }),
  );
  expect(f.post).not.toHaveBeenCalledWith(
    expect.objectContaining({ kind: "get" }),
  );
  expect(f.port.cancelHTTP).toHaveBeenCalledWith(1);
  f.retire();
  await f.peer.close();
});

it("awaits original HTTPS physical close before acknowledging withdrawal", async () => {
  const f = fixture("https:");
  f.peer.get(1, f.url);
  let retired = false;
  const closing = f.peer.close().then((value) => {
    retired = true;
    return value;
  });
  f.resolve();
  await Promise.resolve();
  expect(retired).toBe(false);
  expect(f.port.cancelHTTP).toHaveBeenCalledWith(1);
  expect(f.post).not.toHaveBeenCalledWith(
    expect.objectContaining({ kind: "get" }),
  );
  f.retire();
  await expect(closing).resolves.toBe(true);
});
