import { describe, expect, it, vi } from "vitest";
import { CloudflareBrowserRunClient } from "./cloudflare-client.js";
import { CloudflareSandboxProvider } from "./cloudflare-provider.js";

describe("Cloudflare browser allocation", () => {
  it("reaches the provider API instead of failing at a local suspension gate", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("provider request reached");
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
    ).rejects.toThrow("session allocation request failed");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
