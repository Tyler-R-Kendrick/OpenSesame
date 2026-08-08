import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createMockUpstreamIdp } from "./server.js";

describe("mock-upstream-idp", () => {
  it("serves discovery, authorize (auto-approve), token, and jwks", async () => {
    const idp = await createMockUpstreamIdp({
      host: "127.0.0.1",
      port: 0 as unknown as number,
      issuer: "http://127.0.0.1:0",
    });

    // Bind to ephemeral port then rewrite issuer for redirects
    await new Promise<void>((resolve, reject) => {
      idp.server.listen(0, "127.0.0.1", () => resolve());
      idp.server.once("error", reject);
    });
    const addr = idp.server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    const base = `http://127.0.0.1:${addr.port}`;
    idp.config.issuer = base;
    idp.config.redirectUris = [`${base}/cb`];

    // Catch redirect on /cb
    const cbServer = createServer((req, res) => {
      res.writeHead(200);
      res.end(req.url ?? "");
    });
    await new Promise<void>((resolve) => cbServer.listen(addr.port + 1, "127.0.0.1", () => resolve()));
    const cbAddr = cbServer.address();
    if (!cbAddr || typeof cbAddr === "string") throw new Error("no cb address");
    const redirectUri = `http://127.0.0.1:${cbAddr.port}/cb`;
    idp.config.redirectUris = [redirectUri];

    try {
      const discovery = await fetch(`${base}/.well-known/openid-configuration`);
      expect(discovery.status).toBe(200);
      expect(discovery.headers.get("x-content-type-options")).toBe("nosniff");
      expect(discovery.headers.get("x-frame-options")).toBe("DENY");
      expect(discovery.headers.get("cache-control")).toBe("no-store");
      const meta = (await discovery.json()) as {
        issuer: string;
        jwks_uri: string;
        code_challenge_methods_supported: string[];
      };
      expect(meta.jwks_uri).toContain("/jwks");
      expect(meta.code_challenge_methods_supported).toEqual(["S256"]);

      const jwks = await fetch(`${base}/jwks`);
      expect(jwks.status).toBe(200);
      const jwksBody = (await jwks.json()) as { keys: unknown[] };
      expect(jwksBody.keys.length).toBe(1);

      const noPkce = new URL(`${base}/authorize`);
      noPkce.searchParams.set("client_id", idp.config.clientId);
      noPkce.searchParams.set("redirect_uri", redirectUri);
      noPkce.searchParams.set("response_type", "code");
      noPkce.searchParams.set("scope", "openid profile email");
      const noPkceRes = await fetch(noPkce, { redirect: "manual" });
      expect(noPkceRes.status).toBe(400);

      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");

      const authUrl = new URL(`${base}/authorize`);
      authUrl.searchParams.set("client_id", idp.config.clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", "openid profile email");
      authUrl.searchParams.set("state", "xyz");
      authUrl.searchParams.set("nonce", "n1");
      authUrl.searchParams.set("code_challenge", challenge);
      authUrl.searchParams.set("code_challenge_method", "S256");

      const authRes = await fetch(authUrl, { redirect: "manual" });
      expect(authRes.status).toBe(302);
      const location = authRes.headers.get("location");
      expect(location).toBeTruthy();
      const code = new URL(location!).searchParams.get("code");
      expect(code).toBeTruthy();

      const badVerifier = await fetch(`${base}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code!,
          redirect_uri: redirectUri,
          client_id: idp.config.clientId,
          client_secret: idp.config.clientSecret,
          code_verifier: "wrong-verifier",
        }),
      });
      expect(badVerifier.status).toBe(400);

      const authUrl2 = new URL(`${base}/authorize`);
      authUrl2.searchParams.set("client_id", idp.config.clientId);
      authUrl2.searchParams.set("redirect_uri", redirectUri);
      authUrl2.searchParams.set("response_type", "code");
      authUrl2.searchParams.set("scope", "openid profile email");
      authUrl2.searchParams.set("code_challenge", challenge);
      authUrl2.searchParams.set("code_challenge_method", "S256");
      const authRes2 = await fetch(authUrl2, { redirect: "manual" });
      const code2 = new URL(authRes2.headers.get("location")!).searchParams.get("code");

      const tokenRes = await fetch(`${base}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code2!,
          redirect_uri: redirectUri,
          client_id: idp.config.clientId,
          client_secret: idp.config.clientSecret,
          code_verifier: verifier,
        }),
      });
      expect(tokenRes.status).toBe(200);
      const tokens = (await tokenRes.json()) as { id_token: string; access_token: string };
      expect(tokens.id_token.split(".")).toHaveLength(3);
      expect(tokens.access_token).toMatch(/^mock-access-/);
    } finally {
      await new Promise<void>((resolve) => cbServer.close(() => resolve()));
      await idp.close();
    }
  });
});
