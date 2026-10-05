import { createServer } from "node:http";
import { isJsonObject, isNumber, overlapCast } from "@opensesame/os-domain";
import { Hono } from "hono";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { expect, it } from "vitest";
import { type OpenSesameAuthVariables, openSesameAuth } from "./hono.js";
import { createOpenSesameVerifier } from "./verifier.js";

it("keeps customer resource audiences separate over live discovery, JWKS, and HTTP", async () => {
  const keys = await generateKeyPair("RS256");
  const jwk = await exportJWK(keys.publicKey);
  const app = new Hono<{ Variables: OpenSesameAuthVariables }>();
  let issuer = "";
  let discoveryReads = 0;
  let jwksReads = 0;
  app.get("/.well-known/openid-configuration", (c) => {
    discoveryReads++;
    return c.json({ issuer, jwks_uri: `${issuer}/jwks` });
  });
  app.get("/jwks", (c) => {
    jwksReads++;
    return c.json({
      keys: [
        { ...jwk, kid: "deployment-signing-key", alg: "RS256", use: "sig" },
      ],
    });
  });
  const server = createServer(async (request, response) => {
    const headers = new Headers();
    if (request.headers.authorization)
      headers.set("authorization", request.headers.authorization);
    const result = await app.fetch(
      new Request(`${issuer}${request.url}`, { headers }),
    );
    response.statusCode = result.status;
    result.headers.forEach((value, name) => response.setHeader(name, value));
    response.end(await result.text());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = overlapCast(server.address());
    if (!isJsonObject(address) || !isNumber(address.port))
      throw new Error("expected a TCP listener");
    issuer = `http://127.0.0.1:${address.port}`;
    for (const customer of ["customer-a", "customer-b"]) {
      app.use(
        `/customers/${customer}/resource`,
        openSesameAuth({
          verifier: createOpenSesameVerifier({
            issuer,
            audience: customer,
            requiredScopes: ["resource:read"],
          }),
        }),
      );
      app.get(`/customers/${customer}/resource`, (c) =>
        c.json({ customer, subject: c.get("identity").sub }),
      );
    }
    const mint = (customer: string) =>
      new SignJWT({ scope: "resource:read", token_use: "access" })
        .setProtectedHeader({ alg: "RS256", kid: "deployment-signing-key" })
        .setIssuer(issuer)
        .setAudience(customer)
        .setSubject(`${customer}-principal`)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(keys.privateKey);
    const customerA = await mint("customer-a");
    const customerB = await mint("customer-b");
    const get = (customer: string, token: string) =>
      fetch(`${issuer}/customers/${customer}/resource`, {
        headers: { authorization: `Bearer ${token}` },
      });
    const ownA = await get("customer-a", customerA);
    const ownB = await get("customer-b", customerB);
    expect(ownA.status).toBe(200);
    expect(ownB.status).toBe(200);
    expect(await ownA.json()).toEqual({
      customer: "customer-a",
      subject: "customer-a-principal",
    });
    expect(await ownB.json()).toEqual({
      customer: "customer-b",
      subject: "customer-b-principal",
    });
    for (const [customer, token] of [
      ["customer-b", customerA],
      ["customer-a", customerB],
    ]) {
      const foreign = await get(customer ?? "", token ?? "");
      expect(foreign.status).toBe(401);
      expect(foreign.headers.get("www-authenticate")).toContain("Bearer");
      const error = await foreign.text();
      expect(error).not.toContain(token);
      expect(error).not.toContain("principal");
    }
    expect(discoveryReads).toBe(2);
    expect(jwksReads).toBe(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 20_000);
