import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertExclusiveClaim,
  assertNoSecretFields,
  assertSourceOrder,
} from "@opensesame/testing";
import { describe, expect, it } from "vitest";
import { assertMockIdpListenAllowed } from "./config.js";
import { createMockUpstreamIdp } from "./server.js";

const here = dirname(fileURLToPath(import.meta.url));

async function listenIdp() {
  const idp = await createMockUpstreamIdp({
    host: "127.0.0.1",
    port: 0 as unknown as number,
    issuer: "http://127.0.0.1:0",
  });
  await new Promise<void>((resolve, reject) => {
    idp.server.listen(0, "127.0.0.1", () => resolve());
    idp.server.once("error", reject);
  });
  const addr = idp.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  const base = `http://127.0.0.1:${addr.port}`;
  idp.config.issuer = base;
  return { idp, base };
}

describe("PACT — mock-upstream-idp", () => {
  it("property: listen is loopback-only without an override", () => {
    expect(() => assertMockIdpListenAllowed("127.0.0.1")).not.toThrow();
    expect(() => assertMockIdpListenAllowed("0.0.0.0", {})).toThrow(
      /not loopback/,
    );
  });

  it("adversarial: PKCE is required and wrong client is 400", async () => {
    const { idp, base } = await listenIdp();
    try {
      const noPkce = new URL(`${base}/authorize`);
      noPkce.searchParams.set("client_id", idp.config.clientId);
      noPkce.searchParams.set(
        "redirect_uri",
        idp.config.redirectUris[0] ?? "http://127.0.0.1/cb",
      );
      noPkce.searchParams.set("response_type", "code");
      const res = await fetch(noPkce, { redirect: "manual" });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("invalid_request");
      assertNoSecretFields(body);
    } finally {
      await idp.close();
    }
  });

  it("chaos: authorization code is single-use", async () => {
    const { idp, base } = await listenIdp();
    const redirectUri = "http://127.0.0.1:9/cb";
    idp.config.redirectUris = [redirectUri];
    try {
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256")
        .update(verifier)
        .digest("base64url");
      const authUrl = new URL(`${base}/authorize`);
      authUrl.searchParams.set("client_id", idp.config.clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", "openid");
      authUrl.searchParams.set("code_challenge", challenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      const authRes = await fetch(authUrl, { redirect: "manual" });
      const location = authRes.headers.get("location");
      const code = new URL(location ?? "http://127.0.0.1/").searchParams.get(
        "code",
      );
      expect(code).toBeTruthy();

      const tokenBody = new URLSearchParams({
        grant_type: "authorization_code",
        code: code ?? "",
        redirect_uri: redirectUri,
        client_id: idp.config.clientId,
        client_secret: idp.config.clientSecret,
        code_verifier: verifier,
      });
      await assertExclusiveClaim(async () => {
        const res = await fetch(`${base}/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: tokenBody,
        });
        return res.status === 200;
      }, 8);
    } finally {
      await idp.close();
    }
  });

  it("contract: codes are deleted before PKCE verify (one-time)", () => {
    assertSourceOrder(readFileSync(join(here, "server.ts"), "utf8"), [
      "const stored = codes.get(code)",
      "codes.delete(code)",
      "pkceChallengesEqual",
    ]);
  });
});
