import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CloudflareBrowserRunClient,
  CloudflareSessionCleanupError,
} from "./cloudflare-client.js";
import { CloudflareSandboxProvider } from "./cloudflare-provider.js";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  driverConnect: vi.fn(),
}));

vi.mock("./cdp-node-socket.js", () => ({ connectCdp: mocks.connect }));
vi.mock("./cdp-driver.js", () => ({
  CdpBrowserDriver: { connect: mocks.driverConnect },
}));

function fakeClient(deleteStatus = 200) {
  const calls: string[] = [];
  const client = new CloudflareBrowserRunClient({
    accountId: "acct-1",
    apiToken: "token-1",
    fetchImpl: async (url, init) => {
      calls.push(`${init?.method} ${url}`);
      return new Response(JSON.stringify({ sessionId: "sess-9" }), {
        status: init?.method === "DELETE" ? deleteStatus : 200,
      });
    },
  });
  return { client, calls };
}

beforeEach(() => {
  mocks.connect.mockReset();
  mocks.driverConnect.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("Cloudflare provider lifecycle", () => {
  it("closes an open socket and deletes the session when driver initialization fails", async () => {
    const { client, calls } = fakeClient();
    const close = vi.fn();
    mocks.connect.mockResolvedValue({ close });
    mocks.driverConnect.mockRejectedValue(new Error("driver refused"));
    const provider = new CloudflareSandboxProvider({ client });
    await expect(
      provider.allocate({ origin: "https://accounts.example.test" }),
    ).rejects.toThrow("driver refused");
    expect(close).toHaveBeenCalledOnce();
    expect(calls[1]).toMatch(/^DELETE .*\/sess-9$/u);
  });

  it("bounds initialization and closes the socket before session deletion", async () => {
    vi.useFakeTimers();
    const { client, calls } = fakeClient();
    const close = vi.fn();
    mocks.connect.mockResolvedValue({ close });
    mocks.driverConnect.mockImplementation(() => new Promise(() => {}));
    const provider = new CloudflareSandboxProvider({ client });
    const pending = provider.allocate({
      origin: "https://accounts.example.test",
    });
    const rejected = expect(pending).rejects.toThrow(
      "initialization timed out",
    );
    await vi.advanceTimersByTimeAsync(15_001);
    await rejected;
    expect(close).toHaveBeenCalledOnce();
    expect(calls[1]).toMatch(/^DELETE .*\/sess-9$/u);
  });

  it("returns the validated session ID when cleanup fails", async () => {
    const { client } = fakeClient(500);
    const close = vi.fn();
    mocks.connect.mockResolvedValue({ close });
    mocks.driverConnect.mockRejectedValue(new Error("driver refused"));
    const provider = new CloudflareSandboxProvider({ client });
    const failure = await provider
      .allocate({ origin: "https://accounts.example.test" })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CloudflareSessionCleanupError);
    expect(failure).toMatchObject({ sessionId: "sess-9" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("attempts session deletion even if closing the browser throws", async () => {
    const { client, calls } = fakeClient();
    mocks.connect.mockResolvedValue({ close: vi.fn() });
    mocks.driverConnect.mockResolvedValue({
      close: vi.fn().mockRejectedValue(new Error("close failed")),
    });
    const provider = new CloudflareSandboxProvider({ client });
    const sandbox = await provider.allocate({
      origin: "https://accounts.example.test",
    });
    await expect(sandbox.close()).rejects.toThrow("close failed");
    expect(calls[1]).toMatch(/^DELETE .*\/sess-9$/u);
  });
});
