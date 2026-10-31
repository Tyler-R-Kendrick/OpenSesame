import { once } from "node:events";
import { createServer } from "node:http";
import { isString } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createOpenSesameProvider } from "./create-provider.js";

describe("dynamic registration boundaries", () => {
  it("keeps finite metadata limits and requires an initial access token", async () => {
    const bundle = createOpenSesameProvider({
      env: { dcrEnabled: true, isProduction: false },
    });
    expect(bundle.configuration.fetchResponseBodyLimits).toEqual({
      "client_id metadata document": 5 * 1024,
      jwks_uri: 64 * 1024,
      sector_identifier_uri: 64 * 1024,
    });
    const server = createServer(bundle.provider.callback());
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || isString(address)) throw new Error("Missing address");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/reg`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["https://client.example/callback"],
        }),
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: "invalid_token" });
      const token = await new bundle.provider.InitialAccessToken({}).save();
      const authorized = await fetch(`http://127.0.0.1:${address.port}/reg`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          redirect_uris: ["https://client.example/callback"],
        }),
      });
      expect(authorized.status).toBe(201);
      expect(await authorized.json()).toMatchObject({
        redirect_uris: ["https://client.example/callback"],
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
