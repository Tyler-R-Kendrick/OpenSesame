import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertSourceOrder } from "@opensesame/testing";
import {
  accessTokenHash,
  createApiClient,
  createDpopKeyPair,
  normalizeHttpBaseUrl,
  normalizeLoopbackBaseUrl,
} from "./index.js";

describe("normalizeLoopbackBaseUrl", () => {
  it("accepts loopback origins and strips trailing slash", () => {
    expect(normalizeLoopbackBaseUrl("http://127.0.0.1:8787/")).toBe(
      "http://127.0.0.1:8787",
    );
    expect(normalizeLoopbackBaseUrl(" http://localhost:8787 ")).toBe(
      "http://localhost:8787",
    );
    expect(normalizeLoopbackBaseUrl("https://[::1]:8787")).toBe(
      "https://[::1]:8787",
    );
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
      baseUrl: "https://host.test:8787/",
      fetchImpl: async (input) => {
        calls.push(String(input));
        return new Response("ok", { status: 200 });
      },
    });
    await client.health();
    expect(calls[0]).toBe("https://host.test:8787/health/live");
  });

  it("probeDaemon returns unavailable on network error", async () => {
    const client = createApiClient({
      baseUrl: "https://host.test:8787",
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    const probe = await client.probeDaemon("http://127.0.0.1:18790");
    expect(probe.available).toBe(false);
  });

  it("discover falls back to ready", async () => {
    const client = createApiClient({
      baseUrl: "https://host.test:8787",
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
    const padded = h?.replace(/-/g, "+").replace(/_/g, "/") ?? "";
    const json = JSON.parse(
      atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "=")),
    );
    expect(json.alg).toBe("ES256");
    expect(json.typ).toBe("dpop+jwt");
  });

  it("will not carry a bearer to a base it should not", () => {
    // Cleartext off this machine, credentials in the URL, junk: refused where the
    // client is built rather than left to each caller to remember.
    for (const bad of [
      "http://host.test:8787",
      "https://user:pw@host.test",
      "http://127.0.0.1:8787/?next=x",
      "ftp://127.0.0.1",
      "not a url",
    ]) {
      expect(() => createApiClient({ baseUrl: bad }), bad).toThrow(/baseUrl/);
    }
    expect(createApiClient({ baseUrl: "http://127.0.0.1:8787/" }).baseUrl).toBe(
      "http://127.0.0.1:8787",
    );
  });

  it("binds a proof to the token it travels with", async () => {
    let dpop = "";
    const client = createApiClient({
      baseUrl: "https://host.test:8787",
      accessToken: "opaque-session-token",
      dpop: true,
      fetchImpl: async (_input, init) => {
        dpop = String(new Headers(init?.headers).get("dpop") ?? "");
        return new Response("{}", { status: 200 });
      },
    });
    await client.whoami();
    const claims = JSON.parse(
      Buffer.from(dpop.split(".").at(1) ?? "", "base64url").toString("utf8"),
    ) as { ath?: string; htu?: string; htm?: string };
    // The verifier in crates/proof requires ath whenever a token is present.
    expect(claims.ath).toBe(await accessTokenHash("opaque-session-token"));
    expect(claims.htu).toBe("https://host.test:8787/api/v1/whoami");
    expect(claims.htm).toBe("GET");
  });

  it("keeps a query string out of the bound URI", async () => {
    const { createDpopProof } = await createDpopKeyPair();
    const proof = await createDpopProof(
      "https://host.test/api?next=elsewhere",
      "POST",
    );
    const claims = JSON.parse(
      Buffer.from(proof.split(".").at(1) ?? "", "base64url").toString("utf8"),
    ) as { htu?: string; ath?: string };
    expect(claims.htu).toBe("https://host.test/api");
    // No token, no ath: the verifier rejects an unexpected one.
    expect(claims.ath).toBeUndefined();
  });

  it("does not follow a resource to a cleartext authorization server", async () => {
    const client = createApiClient({
      baseUrl: "https://host.test:8787",
      fetchImpl: async (input) =>
        String(input).includes("oauth-protected-resource")
          ? new Response(
              JSON.stringify({
                resource: "https://host.test:8787",
                authorization_servers: [
                  "http://issuer.example.test",
                  "https://issuer.example.test",
                  42,
                ],
              }),
              { status: 200 },
            )
          : new Response("no", { status: 404 }),
    });
    const d = await client.discover();
    expect(d.authorizationServers).toEqual(["https://issuer.example.test"]);
  });

  it("does not probe a daemon that is not on this machine", async () => {
    let called = false;
    const client = createApiClient({
      baseUrl: "https://host.test:8787",
      fetchImpl: async () => {
        called = true;
        return new Response("{}", { status: 200 });
      },
    });
    const probe = await client.probeDaemon("https://daemon.example.test");
    expect(probe.available).toBe(false);
    expect(called).toBe(false);
  });

  it("answers a server that demands its own nonce, once", async () => {
    const proofs: string[] = [];
    let calls = 0;
    const client = createApiClient({
      baseUrl: "https://host.test:8787",
      accessToken: "opaque",
      dpop: true,
      fetchImpl: async (_input, init) => {
        calls += 1;
        proofs.push(String(new Headers(init?.headers).get("dpop") ?? ""));
        if (calls === 1) {
          return new Response("{}", {
            status: 401,
            headers: {
              "www-authenticate": 'DPoP error="use_dpop_nonce"',
              "dpop-nonce": "n-from-server",
            },
          });
        }
        return new Response("{}", { status: 200 });
      },
    });
    expect(await client.whoami()).toEqual({});
    expect(calls).toBe(2);
    const nonceOf = (proof: string) =>
      (
        JSON.parse(
          Buffer.from(proof.split(".").at(1) ?? "", "base64url").toString(
            "utf8",
          ),
        ) as { nonce?: string }
      ).nonce;
    expect(nonceOf(proofs.at(0) ?? "")).toBeUndefined();
    expect(nonceOf(proofs.at(1) ?? "")).toBe("n-from-server");
  });

  it("does not retry a refusal that is not about the nonce", async () => {
    let calls = 0;
    const client = createApiClient({
      baseUrl: "https://host.test:8787",
      accessToken: "opaque",
      dpop: true,
      fetchImpl: async () => {
        calls += 1;
        return new Response("no", {
          status: 401,
          headers: { "www-authenticate": 'DPoP error="invalid_token"' },
        });
      },
    });
    await expect(client.whoami()).rejects.toThrow(/whoami_failed:401/);
    expect(calls).toBe(1);
  });

  it("remembers a nonce a server offered on a good response", async () => {
    const proofs: string[] = [];
    const client = createApiClient({
      baseUrl: "https://host.test:8787",
      dpop: true,
      fetchImpl: async (_input, init) => {
        proofs.push(String(new Headers(init?.headers).get("dpop") ?? ""));
        return new Response("{}", {
          status: 200,
          headers: { "dpop-nonce": "n-1" },
        });
      },
    });
    await client.health();
    await client.health();
    const second = JSON.parse(
      Buffer.from(proofs.at(1)?.split(".").at(1) ?? "", "base64url").toString(
        "utf8",
      ),
    ) as { nonce?: string };
    expect(second.nonce).toBe("n-1");
  });

  it("syncPull sends device_id", async () => {
    let body = "";
    const client = createApiClient({
      baseUrl: "https://host.test:8787",
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
    expect(normalizeHttpBaseUrl("http://127.0.0.1:8788")).toBe(
      "http://127.0.0.1:8788",
    );
    expect(normalizeHttpBaseUrl("http://127.5.5.5:8788")).toBe(
      "http://127.5.5.5:8788",
    );
    // Cleartext to another host would hand the session bearer to the network.
    expect(normalizeHttpBaseUrl("http://issuer.example.test")).toBeNull();
    expect(
      normalizeHttpBaseUrl("https://user:pw@issuer.example.test"),
    ).toBeNull();
    expect(normalizeHttpBaseUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeHttpBaseUrl("not a url")).toBeNull();
  });
});

describe("PACT — browser extension loopback pin", () => {
  it("popup and background refuse a rewritten remote hostApiBase", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const ext = join(here, "../../../apps/browser-extension");
    assertSourceOrder(
      readFileSync(join(ext, "entrypoints/background.ts"), "utf8"),
      ["normalizeLoopbackBaseUrl", "if (normalized) return normalized", "DEFAULT_HOST"],
    );
    assertSourceOrder(
      readFileSync(join(ext, "entrypoints/popup/main.ts"), "utf8"),
      [
        "normalizeLoopbackBaseUrl(raw)",
        "if (!value)",
        "chrome.storage.local.set({ hostApiBase: value })",
      ],
    );
    expect(normalizeLoopbackBaseUrl("https://evil.example")).toBeNull();
  });
});
