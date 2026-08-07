import { describe, expect, it } from "vitest";
import { createApiClient, createDpopKeyPair } from "./index.js";

describe("api-client", () => {
  it("builds requests against host base url", async () => {
    const calls: string[] = [];
    const client = createApiClient({
      baseUrl: "http://host.test:8787/",
      fetchImpl: async (input) => {
        calls.push(String(input));
        return new Response("ok", { status: 200 });
      },
    });
    await client.health();
    expect(calls[0]).toBe("http://host.test:8787/health/live");
  });

  it("probeDaemon returns unavailable on network error", async () => {
    const client = createApiClient({
      baseUrl: "http://host.test:8787",
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    const probe = await client.probeDaemon("http://127.0.0.1:18790");
    expect(probe.available).toBe(false);
  });

  it("discover falls back to ready", async () => {
    const client = createApiClient({
      baseUrl: "http://host.test:8787",
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("oauth-protected-resource")) {
          return new Response("no", { status: 404 });
        }
        if (url.includes("/health/ready")) {
          return new Response("{}", { status: 200 });
        }
        return new Response("no", { status: 404 });
      },
    });
    const d = await client.discover();
    expect(d.source).toBe("ready");
    expect(d.ready).toBe(true);
  });

  it("createDpopProof has dpop+jwt typ and ES256", async () => {
    const { createDpopProof } = await createDpopKeyPair();
    const proof = await createDpopProof("https://host.test/api", "POST");
    const [h] = proof.split(".");
    const json = JSON.parse(
      Buffer.from(h!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    );
    expect(json.alg).toBe("ES256");
    expect(json.typ).toBe("dpop+jwt");
  });

  it("syncPull sends device_id", async () => {
    let body = "";
    const client = createApiClient({
      baseUrl: "http://host.test:8787",
      fetchImpl: async (_input, init) => {
        body = String(init?.body ?? "");
        return new Response("{}", { status: 200 });
      },
    });
    await client.syncPull({ deviceId: "dev-a", epoch: 3 });
    expect(body).toContain("dev-a");
    expect(body).toContain('"since_epoch":3');
  });
});
