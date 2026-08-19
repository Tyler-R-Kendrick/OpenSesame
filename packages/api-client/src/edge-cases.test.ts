import { afterEach, describe, expect, it, vi } from "vitest";
import {
  accessTokenHash,
  createApiClient,
  createDpopKeyPair,
} from "./index.js";

function jsonClient(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; method: string; body: string }[] = [];
  const client = createApiClient({
    baseUrl: "https://host.test:8787",
    fetchImpl: async (input, init) => {
      calls.push({
        url: String(input),
        method: String(init?.method ?? "GET"),
        body: String(init?.body ?? ""),
      });
      return handler(String(input), init);
    },
  });
  return { calls, client };
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function proofClaims(proof: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(proof.split(".").at(1) ?? "", "base64url").toString("utf8"),
  ) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api-client error surfacing", () => {
  it("ignores an error body whose error field is not a string", async () => {
    const { client } = jsonClient(
      () => new Response(JSON.stringify({ error: 42 }), { status: 500 }),
    );
    await expect(client.listProviders()).rejects.toThrow(
      "providers_failed:500",
    );
  });

  it("fails integration delete with the broker error code", async () => {
    const { client } = jsonClient(
      () =>
        new Response(JSON.stringify({ error: "integration_in_use" }), {
          status: 409,
        }),
    );
    await expect(client.deleteIntegration("integration_01J")).rejects.toThrow(
      "integration_delete_failed:409:integration_in_use",
    );
  });
});

describe("api-client discovery", () => {
  it("parses a minimal protected-resource document", async () => {
    const { client } = jsonClient((url) =>
      url.includes("oauth-protected-resource")
        ? ok({ dpop_bound_access_tokens_required: true })
        : new Response("no", { status: 404 }),
    );
    const d = await client.discover();
    expect(d.source).toBe("prm");
    expect(d.dpopBound).toBe(true);
    expect(d.resource).toBeUndefined();
    expect(d.authorizationServers).toBeUndefined();
  });

  it("reports none when the host answers but exposes neither document", async () => {
    const { client } = jsonClient(() => new Response("no", { status: 503 }));
    const d = await client.discover();
    expect(d).toEqual({ source: "none" });
  });

  it("reports none when the host cannot be reached at all", async () => {
    const client = createApiClient({
      baseUrl: "https://host.test:8787",
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
    });
    const d = await client.discover();
    expect(d).toEqual({ source: "none" });
  });
});

describe("api-client daemon probe", () => {
  it("reports health when the local daemon answers", async () => {
    const { client } = jsonClient(() => ok({ version: "0.1.0" }));
    const probe = await client.probeDaemon();
    expect(probe.available).toBe(true);
    expect(probe.url).toBe("http://127.0.0.1:18790");
    expect(probe.health).toEqual({ version: "0.1.0" });
  });

  it("reports unavailable when the daemon answers with an error", async () => {
    const { client } = jsonClient(() => new Response("busy", { status: 503 }));
    const probe = await client.probeDaemon("http://127.0.0.1:18790/");
    expect(probe.available).toBe(false);
    expect(probe.health).toBeUndefined();
  });
});

describe("api-client DPoP edge cases", () => {
  it("keeps an unparseable htu as-is instead of throwing", async () => {
    const { createDpopProof } = await createDpopKeyPair();
    const proof = await createDpopProof("not a url", "post");
    const claims = proofClaims(proof);
    expect(claims.htu).toBe("not a url");
    expect(claims.htm).toBe("POST");
  });

  it("mints a jti from getRandomValues when randomUUID is absent", async () => {
    const { createDpopProof } = await createDpopKeyPair();
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => bytes.fill(7),
    });
    const proof = await createDpopProof("https://host.test/api", "GET");
    const claims = proofClaims(proof);
    expect(typeof claims.jti).toBe("string");
    expect(String(claims.jti).length).toBeGreaterThan(0);
  });

  it("refuses to mint a proof when no randomness source exists", async () => {
    const { createDpopProof } = await createDpopKeyPair();
    vi.stubGlobal("crypto", {});
    await expect(
      createDpopProof("https://host.test/api", "GET"),
    ).rejects.toThrow("crypto_unavailable_for_dpop_jti");
  });

  it("refuses to hash a token when Web Crypto is unavailable", async () => {
    vi.stubGlobal("crypto", {});
    await expect(accessTokenHash("opaque")).rejects.toThrow(
      "crypto_subtle_unavailable",
    );
  });

  it("does not retry a bare 401 with no challenge headers", async () => {
    let calls = 0;
    const client = createApiClient({
      baseUrl: "https://host.test:8787",
      accessToken: "opaque",
      dpop: true,
      fetchImpl: async () => {
        calls += 1;
        return new Response("no", { status: 401 });
      },
    });
    await expect(client.whoami()).rejects.toThrow(/whoami_failed:401/);
    expect(calls).toBe(1);
  });

  it("answers a DPoP challenge that carries a nonce but no use_dpop_nonce error", async () => {
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
          return new Response("no", {
            status: 401,
            headers: {
              "www-authenticate": 'DPoP error="invalid_proof"',
              "dpop-nonce": "n-2",
            },
          });
        }
        return new Response("{}", { status: 200 });
      },
    });
    expect(await client.whoami()).toEqual({});
    expect(calls).toBe(2);
    expect(proofClaims(proofs[1] ?? "").nonce).toBe("n-2");
  });

  it("ignores a nonce that arrives with a non-DPoP challenge", async () => {
    let calls = 0;
    const client = createApiClient({
      baseUrl: "https://host.test:8787",
      accessToken: "opaque",
      dpop: true,
      fetchImpl: async () => {
        calls += 1;
        return new Response("no", {
          status: 401,
          headers: {
            "www-authenticate": 'Bearer realm="host"',
            "dpop-nonce": "n-3",
          },
        });
      },
    });
    await expect(client.whoami()).rejects.toThrow(/whoami_failed:401/);
    expect(calls).toBe(1);
  });
});
