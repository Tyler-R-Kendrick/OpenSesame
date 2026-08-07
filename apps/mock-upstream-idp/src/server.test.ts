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
      const meta = (await discovery.json()) as { issuer: string; jwks_uri: string };
      expect(meta.jwks_uri).toContain("/jwks");

      const jwks = await fetch(`${base}/jwks`);
      expect(jwks.status).toBe(200);
      const jwksBody = (await jwks.json()) as { keys: unknown[] };
      expect(jwksBody.keys.length).toBe(1);

      const authUrl = new URL(`${base}/authorize`);
      authUrl.searchParams.set("client_id", idp.config.clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", "openid profile email");
      authUrl.searchParams.set("state", "xyz");
      authUrl.searchParams.set("nonce", "n1");

      const authRes = await fetch(authUrl, { redirect: "manual" });
      expect(authRes.status).toBe(302);
      const location = authRes.headers.get("location");
      expect(location).toBeTruthy();
      const code = new URL(location!).searchParams.get("code");
      expect(code).toBeTruthy();

      const tokenRes = await fetch(`${base}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code!,
          redirect_uri: redirectUri,
          client_id: idp.config.clientId,
          client_secret: idp.config.clientSecret,
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
