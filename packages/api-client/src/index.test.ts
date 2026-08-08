import { describe, expect, it } from "vitest";
import {
  createApiClient,
  createDpopKeyPair,
  normalizeHttpBaseUrl,
  normalizeLoopbackBaseUrl,
} from "./index.js";

describe("normalizeLoopbackBaseUrl", () => {
  it("accepts loopback origins and strips trailing slash", () => {
    expect(normalizeLoopbackBaseUrl("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
    expect(normalizeLoopbackBaseUrl(" http://localhost:8787 ")).toBe("http://localhost:8787");
    expect(normalizeLoopbackBaseUrl("https://[::1]:8787")).toBe("https://[::1]:8787");
    expect(normalizeLoopbackBaseUrl("http://api.localhost:8787")).toBe(
      "http://api.localhost:8787",
    );
  });

  it("rejects remote hosts, odd schemes, and credential/query smuggling", () => {
    for (const bad of [
      "http://evil.example",
      "http://10.0.0.5:8787",
      "http://127.0.0.1.evil.example",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "http://user:pass@127.0.0.1:8787",
      "http://127.0.0.1:8787/?next=http://evil.example",
      "http://127.0.0.1:8787/#x",
      "not a url",
      "",
    ]) {
      expect(normalizeLoopbackBaseUrl(bad), bad).toBeNull();
    }
  });
});

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
    const padded = h!.replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "=")));
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

describe("normalizeHttpBaseUrl", () => {
  it("allows https anywhere and http only on loopback", () => {
    expect(normalizeHttpBaseUrl("https://issuer.example.test/")).toBe(
      "https://issuer.example.test",
    );
    expect(normalizeHttpBaseUrl("http://127.0.0.1:8788")).toBe("http://127.0.0.1:8788");
    expect(normalizeHttpBaseUrl("http://127.5.5.5:8788")).toBe("http://127.5.5.5:8788");
    // Cleartext to another host would hand the session bearer to the network.
    expect(normalizeHttpBaseUrl("http://issuer.example.test")).toBeNull();
    expect(normalizeHttpBaseUrl("https://user:pw@issuer.example.test")).toBeNull();
    expect(normalizeHttpBaseUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeHttpBaseUrl("not a url")).toBeNull();
  });
});
