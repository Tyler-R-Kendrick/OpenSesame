import { describe, expect, it, vi } from "vitest";
import { createApiClient, createDpopKeyPair } from "./index.js";

describe("DPoP key custody", () => {
  it("uses the paired key and DPoP scheme without following redirects", async () => {
    const key = await createDpopKeyPair();
    const sign = vi.spyOn(key, "createDpopProof");
    const client = createApiClient({
      baseUrl: "https://host.example",
      accessToken: "bound-fixture",
      dpop: key,
      fetchImpl: async (_url, init) => {
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("DPoP bound-fixture");
        expect(headers.get("dpop")).toBeTruthy();
        expect(init?.redirect).toBe("error");
        return Response.json({});
      },
    });
    await client.whoami();
    expect(sign).toHaveBeenCalledWith(
      "https://host.example/api/v1/whoami",
      "GET",
      "bound-fixture",
      undefined,
    );
  });
  it("keeps the private key non-extractable while exporting the public proof JWK", async () => {
    const generated = vi.spyOn(crypto.subtle, "generateKey");
    try {
      const factory = await createDpopKeyPair();
      expect(generated).toHaveBeenCalledWith(
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign", "verify"],
      );
      const key = await generated.mock.results[0]?.value;
      expect(key.privateKey.extractable).toBe(false);
      await expect(
        crypto.subtle.exportKey("jwk", key.privateKey),
      ).rejects.toThrow();
      expect(factory.jwk).toMatchObject({
        kty: "EC",
        crv: "P-256",
        x: expect.any(String),
        y: expect.any(String),
      });
      expect(factory.jwk).not.toHaveProperty("d");
      expect(
        (
          await factory.createDpopProof(
            "https://host.example/api/v1/sync/pull-page",
            "POST",
            "opaque-session:test",
          )
        ).split("."),
      ).toHaveLength(3);
    } finally {
      generated.mockRestore();
    }
  });
});
