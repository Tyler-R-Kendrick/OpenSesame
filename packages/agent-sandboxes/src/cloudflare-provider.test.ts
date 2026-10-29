import { describe, expect, it, vi } from "vitest";
import { CloudflareBrowserRunClient } from "./cloudflare-client.js";
import { CloudflareSandboxProvider } from "./cloudflare-provider.js";

const mocks = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("./cdp-node-socket.js", () => ({ connectCdp: mocks.connect }));

describe("Cloudflare browser containment", () => {
  it("rejects before allocating a session or opening a CDP socket", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("unexpected provider request");
    });
    const client = new CloudflareBrowserRunClient({
      accountId: "acct-1",
      apiToken: "token-1",
      fetchImpl,
    });
    const provider = new CloudflareSandboxProvider({ client });
    await expect(
      provider.allocate({
        origin: "https://accounts.example.test/reset?token=canary",
      }),
    ).rejects.toThrow("temporarily unavailable");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});
