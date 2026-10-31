import { describe, expect, it } from "vitest";
import { z } from "zod";
import { deployAnonymousCloudflareRelay } from "./cloudflare-anon-relay.js";
import type { CloudflareTemporaryAccount } from "./cloudflare-provisioning.js";
import { WasmRelayProvider } from "./wasm-provider.js";

const ACCOUNT: CloudflareTemporaryAccount = {
  accountId: "acct-anon",
  apiToken: "temp-token",
  claimUrl: "https://dash.cloudflare.com/claim-preview?claimToken=x",
  accountExpiresAt: "2999-01-01T00:00:00Z",
  claimExpiresAt: "2999-01-01T00:00:00Z",
};

function fakeCloudflareApi() {
  const calls: string[] = [];
  let metadata = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes(".workers.dev"))
      return new Response("unauthorized", { status: 401 });
    if (url.endsWith("/workers/subdomain") && init?.method !== "POST")
      return Response.json({
        success: true,
        result: { subdomain: "test-sub" },
      });
    if (url.includes("/storage/kv/namespaces") && init?.method === "POST")
      return Response.json({ success: true, result: { id: "kv-1" } });
    if (url.includes("/workers/scripts/") && init?.method === "PUT") {
      // SAFETY: checked at the fake boundary: deployTemporaryWorker always sends FormData with a metadata field.
      metadata = String((init.body as FormData).get("metadata") ?? "");
      return Response.json({ success: true, result: {} });
    }
    return Response.json({ success: true, result: {} });
  };
  return { fetchImpl, calls, metadata: () => metadata };
}

describe("anonymous Cloudflare relay deployment", () => {
  it("deploys the relay worker with KV jar and no claim step", async () => {
    const fake = fakeCloudflareApi();
    const deployed = await deployAnonymousCloudflareRelay({
      account: ACCOUNT,
      fetchImpl: fake.fetchImpl,
      readyTimeoutMs: 5_000,
    });
    expect(deployed.relayUrl).toMatch(
      /^https:\/\/os-relay-[0-9a-f]+\.test-sub\.workers\.dev$/u,
    );
    expect(deployed.relayToken.length).toBeGreaterThan(16);
    const metadata = z
      .object({ bindings: z.array(z.record(z.string(), z.string())) })
      .parse(JSON.parse(fake.metadata()));
    expect(metadata.bindings).toContainEqual({
      type: "kv_namespace",
      name: "RELAY_KV",
      namespace_id: "kv-1",
    });
    expect(
      metadata.bindings.some(
        (b) => b.name === "RELAY_TOKEN" && b.text === deployed.relayToken,
      ),
    ).toBe(true);
    await deployed.close();
    expect(fake.calls.some((c) => c.startsWith("DELETE "))).toBe(true);
  });

  it("provider deploys anonymously and closes the deployment with the sandbox", async () => {
    let deployedCount = 0;
    let closed = false;
    const provider = new WasmRelayProvider({
      anonymousCloudflare: true,
      virtualFetch: Object.assign(
        async () => ({ status: 200, url: "", headers: {}, bodyText: "" }),
        { closeSession: async () => {} },
      ),
      deployRelay: async () => {
        deployedCount += 1;
        return {
          relayUrl: "https://relay.example.test",
          relayToken: "tok",
          account: ACCOUNT,
          close: async () => {
            closed = true;
          },
        };
      },
    });
    // An injected virtual fetch short-circuits deployment entirely.
    const sandbox = await provider.allocate({
      origin: "https://accounts.example.test/reset",
    });
    await sandbox.close();
    expect(deployedCount).toBe(0);
    expect(closed).toBe(false);
  });

  it("provider deploys once per allocation and tears it down on close", async () => {
    let deployedCount = 0;
    let closed = false;
    const provider = new WasmRelayProvider({
      anonymousCloudflare: true,
      deployRelay: async () => {
        deployedCount += 1;
        return {
          relayUrl: "https://relay.example.test",
          relayToken: "tok",
          account: ACCOUNT,
          close: async () => {
            closed = true;
          },
        };
      },
    });
    const sandbox = await provider.allocate({
      origin: "https://accounts.example.test/reset",
    });
    expect(deployedCount).toBe(1);
    await sandbox.close();
    expect(closed).toBe(true);
  });
});
