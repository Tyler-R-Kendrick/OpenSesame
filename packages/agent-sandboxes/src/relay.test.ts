import { once } from "node:events";
import type {
  BrowserDriver,
  Observation,
} from "@opensesame/cua-password-reset";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { relayDriverOverWebSocket } from "./relay-driver.js";
import { type RunningRelayServer, startRelayServer } from "./relay-server.js";

const OBSERVATION: Observation = {
  id: "obs-1",
  origin: "https://accounts.example.test",
  fields: [{ ref: "e1", kind: "email", label: "Email" }],
};

function fakeDriver(): BrowserDriver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    open: vi.fn(async (url: string) => {
      calls.push(`open ${url}`);
    }),
    snapshot: vi.fn(async () => OBSERVATION),
    click: vi.fn(async (ref: string) => {
      calls.push(`click ${ref}`);
    }),
    fill: vi.fn(async () => {}),
    fillSecret: vi.fn(async (ref: string) => {
      calls.push(`fillSecret ${ref}`);
    }),
    pageUrl: vi.fn(async () => "https://accounts.example.test/reset"),
    close: vi.fn(async () => {
      calls.push("close");
    }),
  };
}

describe("driver relay", () => {
  let server: RunningRelayServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
    vi.unstubAllGlobals();
  });

  it("drives the hosted browser over an authenticated socket", async () => {
    const hosted = fakeDriver();
    server = await startRelayServer({ token: "s3cret-token", driver: hosted });
    const driver = relayDriverOverWebSocket(server.url, {
      token: "s3cret-token",
    });
    await driver.open("https://accounts.example.test/reset");
    await expect(driver.snapshot()).resolves.toEqual(OBSERVATION);
    await driver.fillSecret("e1", "value-never-logged");
    await expect(driver.pageUrl()).resolves.toContain("/reset");
    await driver.close();
    expect(hosted.calls).toEqual([
      "open https://accounts.example.test/reset",
      "fillSecret e1",
      "close",
    ]);
  });

  it("refuses a wrong relay token", async () => {
    server = await startRelayServer({
      token: "s3cret-token",
      driver: fakeDriver(),
    });
    const driver = relayDriverOverWebSocket(server.url, { token: "wrong" });
    await expect(
      driver.open("https://accounts.example.test/reset"),
    ).rejects.toThrow(/refused|failed/u);
  });

  it("surfaces hosted driver errors as relay errors", async () => {
    const hosted = fakeDriver();
    vi.mocked(hosted.open).mockRejectedValue(new Error("navigation blocked"));
    server = await startRelayServer({ token: "t", driver: hosted });
    const driver = relayDriverOverWebSocket(server.url, { token: "t" });
    await expect(driver.open("https://x.test/")).rejects.toThrow(
      "navigation blocked",
    );
  });
  it("allows retrying close when the hosted driver fails to close", async () => {
    const hosted = fakeDriver();
    if (!hosted.close) throw new Error("fake driver requires close");
    vi.mocked(hosted.close).mockRejectedValueOnce(new Error("close failed"));
    server = await startRelayServer({ token: "t", driver: hosted });
    const driver = relayDriverOverWebSocket(server.url, { token: "t" });
    await expect(driver.close()).rejects.toThrow("close failed");
    await expect(driver.close()).resolves.toBeUndefined();
    expect(hosted.close).toHaveBeenCalledTimes(2);
  });

  it("rejects insecure remote addresses and plaintext non-loopback listeners", async () => {
    const driver = fakeDriver();
    await expect(
      startRelayServer({ host: "0.0.0.0", token: "t", driver }),
    ).rejects.toThrow(/loopback/u);
    await expect(startRelayServer({ token: "", driver })).rejects.toThrow(
      /token/u,
    );
    expect(() =>
      relayDriverOverWebSocket("ws://example.test/relay", { token: "t" }),
    ).toThrow(/wss/u);
    expect(() =>
      relayDriverOverWebSocket("ws://localhost/relay", { token: "t" }),
    ).toThrow(/wss/u);
    expect(() =>
      relayDriverOverWebSocket("wss://user:password@example.test/relay", {
        token: "t",
      }),
    ).toThrow(/credentials/u);
    const constructed = vi.fn();
    class Socket {
      constructor(url: string) {
        constructed(url);
      }
      addEventListener() {}
      send() {}
      close() {}
    }
    vi.stubGlobal("WebSocket", Socket);
    relayDriverOverWebSocket("wss://example.test/relay", { token: "t" });
    expect(constructed).toHaveBeenCalledWith("wss://example.test/relay");
  });

  it("allows only one authenticated client to own the browser session", async () => {
    const hosted = fakeDriver();
    server = await startRelayServer({ token: "shared", driver: hosted });
    const first = relayDriverOverWebSocket(server.url, { token: "shared" });
    await first.open("https://first.example/");
    const second = relayDriverOverWebSocket(server.url, { token: "shared" });
    await expect(second.open("https://second.example/")).rejects.toThrow(
      /refused|closed/u,
    );
    expect(hosted.calls).toEqual(["open https://first.example/"]);
    await first.close();
  });

  it("serializes pipelined commands and reconnects after in-flight work", async () => {
    const hosted = fakeDriver();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(hosted.open).mockImplementation(async () => {
      await held;
    });
    server = await startRelayServer({ token: "shared", driver: hosted });
    const first = new WebSocket(server.url);
    try {
      await once(first, "open");
      first.send(JSON.stringify({ type: "auth", token: "shared" }));
      await once(first, "message");
      first.send(
        JSON.stringify({ id: 1, method: "open", url: "https://x.test/" }),
      );
      first.send(JSON.stringify({ id: 2, method: "snapshot" }));
      await vi.waitFor(() => expect(hosted.open).toHaveBeenCalledOnce());
      expect(hosted.snapshot).not.toHaveBeenCalled();
      first.terminate();
      await once(first, "close");
      const next = relayDriverOverWebSocket(server.url, { token: "shared" });
      const nextSnapshot = next.snapshot();
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(hosted.snapshot).not.toHaveBeenCalled();
      release();
      await expect(nextSnapshot).resolves.toEqual(OBSERVATION);
      expect(hosted.snapshot).toHaveBeenCalledOnce();
      await next.close();
    } finally {
      release();
      first.terminate();
    }
  });

  it("rejects an in-flight and subsequent command when the socket closes", async () => {
    const hosted = fakeDriver();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(hosted.open).mockImplementation(async () => {
      await held;
    });
    server = await startRelayServer({ token: "t", driver: hosted });
    const driver = relayDriverOverWebSocket(server.url, { token: "t" });
    const pending = driver.open("https://x.test/");
    await vi.waitFor(() => expect(hosted.open).toHaveBeenCalledOnce());
    const closing = server.close();
    try {
      await expect(pending).rejects.toThrow(/closed|failed/u);
      await expect(driver.snapshot()).rejects.toThrow(/closed/u);
    } finally {
      release();
      await closing;
      server = null;
    }
  });
});
