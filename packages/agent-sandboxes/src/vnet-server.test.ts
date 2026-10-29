import { type Server, createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type RunningVirtualNetworkRelay,
  startVirtualNetworkRelay,
} from "./vnet-server.js";
import { virtualFetchOverHttp } from "./vnet.js";

describe("virtual network relay", () => {
  let target: Server;
  let targetPort = 0;
  let relay: RunningVirtualNetworkRelay;

  beforeAll(async () => {
    target = createServer((request, response) => {
      if (request.url === "/start") {
        response.writeHead(303, {
          location: "/final",
          "set-cookie": "session=abc; Path=/",
        });
        response.end();
        return;
      }
      response
        .writeHead(200, { "content-type": "text/plain" })
        .end(`cookie:${request.headers.cookie ?? ""} method:${request.method}`);
    });
    await new Promise<void>((resolve) => {
      target.listen(0, "127.0.0.1", resolve);
    });
    const address = target.address();
    targetPort =
      address instanceof Object && "port" in address ? address.port : 0;
    relay = await startVirtualNetworkRelay({ token: "relay-token" });
  });

  afterAll(async () => {
    await relay.close();
    await new Promise<void>((resolve) => target.close(() => resolve()));
  });

  it("follows redirects relay-side and carries cookies per session", async () => {
    const virtualFetch = virtualFetchOverHttp(relay.url, "relay-token");
    const result = await virtualFetch({
      sessionId: "s1",
      url: `http://127.0.0.1:${targetPort}/start`,
      method: "POST",
      body: "payload",
    });
    expect(result.status).toBe(200);
    expect(result.url).toBe(`http://127.0.0.1:${targetPort}/final`);
    expect(result.bodyText).toBe("cookie:session=abc method:GET");
    // A different session does not inherit the cookie.
    const other = await virtualFetch({
      sessionId: "s2",
      url: `http://127.0.0.1:${targetPort}/final`,
      method: "GET",
    });
    expect(other.bodyText).toBe("cookie: method:GET");
  });

  it("pins a session to its first host when no allowlist is given", async () => {
    const virtualFetch = virtualFetchOverHttp(relay.url, "relay-token");
    await virtualFetch({
      sessionId: "s3",
      url: `http://127.0.0.1:${targetPort}/final`,
      method: "GET",
    });
    await expect(
      virtualFetch({
        sessionId: "s3",
        url: "http://example.com/final",
        method: "GET",
      }),
    ).rejects.toThrow(/refused/u);
  });

  it("requires the relay token", async () => {
    const virtualFetch = virtualFetchOverHttp(relay.url, "wrong");
    await expect(
      virtualFetch({
        sessionId: "s4",
        url: `http://127.0.0.1:${targetPort}/final`,
        method: "GET",
      }),
    ).rejects.toThrow("refused (401)");
  });
});
