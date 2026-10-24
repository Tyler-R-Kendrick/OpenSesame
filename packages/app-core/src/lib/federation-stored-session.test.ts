import { once } from "node:events";
import { createServer } from "node:http";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeEach, expect, it } from "vitest";
import { z } from "zod";
import { resetAmbientAuthSeams } from "./ambient-auth-seam.js";
import { restoreAuthenticatedSession } from "./federation-restoration.js";
import { readStoredSessionSync } from "./federation-stored-session.js";

const actualFetch = globalThis.fetch;
const closes: (() => Promise<void>)[] = [];
beforeEach(resetAmbientAuthSeams);
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  resetAmbientAuthSeams();
});
async function fixture() {
  const signer = await generateKeyPair("ES256");
  const foreignSigner = await generateKeyPair("ES256");
  const jwk = {
    ...(await exportJWK(signer.publicKey)),
    kid: "stored-reader-key",
    alg: "ES256",
    use: "sig",
  };
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.setHeader("content-type", "application/json");
    if (request.method !== "GET" || request.url !== "/jwks") {
      response.writeHead(404);
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  closes.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const { port } = z
    .object({ port: z.number().int().positive() })
    .parse(server.address());
  const issuer = `http://127.0.0.1:${port}`;
  const trust = { issuer, clientId: "reader-spa", jwksUri: `${issuer}/jwks` };
  const now = Math.floor(Date.now() / 1000);
  return {
    trust,
    requests,
    expiresAt: (now + 600) * 1000,
    async token({ forged = false, expired = false } = {}) {
      return new SignJWT({ name: "Signed name" })
        .setProtectedHeader({ alg: "ES256", kid: jwk.kid, typ: "JWT" })
        .setIssuer(issuer)
        .setSubject("signed-subject")
        .setAudience(trust.clientId)
        .setIssuedAt(now - 7200)
        .setExpirationTime(expired ? now - 3600 : now + 600)
        .sign(forged ? foreignSigner.privateKey : signer.privateKey);
    },
    stored(idToken: string) {
      return JSON.stringify({
        issuer,
        upstreamId: "broker-fixture",
        idToken,
        audience: trust.clientId,
        jwksUri: trust.jwksUri,
        pairwiseSub: "mutable-json-subject",
        name: "Mutable JSON name",
        expiresAt: Date.now() + 86400000,
      });
    },
  };
}
it("reads only remembered JWT hints synchronously and authenticates the actual signature through a real JWKS request", async () => {
  const f = await fixture();
  const raw = f.stored(await f.token());
  const remembered = readStoredSessionSync(
    raw,
    (issuer) => issuer === f.trust.issuer,
  );
  expect(remembered?.pairwiseSub).toBe("signed-subject");
  expect(remembered?.name).toBe("Signed name");
  expect(remembered?.expiresAt).toBe(f.expiresAt);
  expect(f.requests).toEqual([]);
  const restored = await restoreAuthenticatedSession(raw, f.trust, actualFetch);
  expect(restored.kind).toBe("authenticated");
  if (restored.kind !== "authenticated")
    throw new Error("The actual signed assertion was not authenticated");
  expect(restored.claims.sub).toBe("signed-subject");
  expect(restored.identity.pairwiseSub).toBe(remembered?.pairwiseSub);
  expect(f.requests).toEqual(["/jwks"]);
});
it("never upgrades a decoded wrong-key hint into authenticated identity", async () => {
  const f = await fixture();
  const raw = f.stored(await f.token({ forged: true }));
  expect(readStoredSessionSync(raw, () => true)?.pairwiseSub).toBe(
    "signed-subject",
  );
  expect(f.requests).toEqual([]);
  const restored = await restoreAuthenticatedSession(raw, f.trust, actualFetch);
  expect(restored).toEqual({
    kind: "remembered",
    issuer: f.trust.issuer,
    audience: f.trust.clientId,
  });
  expect(f.requests).toEqual(["/jwks"]);
});
it("refuses an expired JWT hint despite a mutated future JSON expiry and cannot authenticate it online", async () => {
  const f = await fixture();
  const raw = f.stored(await f.token({ expired: true }));
  expect(readStoredSessionSync(raw, () => true)).toBeNull();
  expect(f.requests).toEqual([]);
  const restored = await restoreAuthenticatedSession(raw, f.trust, actualFetch);
  expect(restored).toEqual({
    kind: "remembered",
    issuer: f.trust.issuer,
    audience: f.trust.clientId,
  });
  expect(f.requests).toEqual(["/jwks"]);
});
it("requires the caller's trusted issuer and online audience before any provider request", async () => {
  const f = await fixture();
  const raw = f.stored(await f.token());
  expect(readStoredSessionSync(raw, () => false)).toBeNull();
  for (const trust of [
    { ...f.trust, issuer: "https://untrusted.example" },
    { ...f.trust, clientId: "foreign-spa" },
  ]) {
    expect(await restoreAuthenticatedSession(raw, trust, actualFetch)).toEqual({
      kind: "rejected",
      reason: "untrusted",
    });
  }
  expect(f.requests).toEqual([]);
});
