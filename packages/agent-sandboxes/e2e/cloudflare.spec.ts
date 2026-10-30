import { expect, test } from "@playwright/test";
import { CloudflareSandboxProvider } from "../src/index.js";

test("Cloudflare browser allocation fails closed before provider network access", async () => {
  let requests = 0;
  const provider = new CloudflareSandboxProvider({
    accountId: "acct-test",
    apiToken: "cf-test-token",
    fetchImpl: async () => {
      requests += 1;
      throw new Error("unexpected provider request");
    },
  });
  await expect(
    provider.allocate({
      origin: "https://accounts.example.test/reset?token=canary",
    }),
  ).rejects.toThrow("temporarily unavailable");
  expect(requests).toBe(0);
});
