import { type Server, createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type RunningVirtualNetworkRelay,
  startVirtualNetworkRelay,
} from "./vnet-server.js";
import { virtualFetchOverHttp } from "./vnet.js";

function boundPort(server: Server, error: string): number {
  const address = z.object({ port: z.number() }).safeParse(server.address());
  if (!address.success) throw new Error(error);
  return address.data.port;
}

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
    relay = await startVirtualNetworkRelay({
      token: "relay-token",
      allowLoopbackTargets: true,
    });
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

describe("virtual network boundaries", () => {
  it("validates close request session IDs before ending a session", async () => {
    const relay = await startVirtualNetworkRelay({ token: "token" });
    try {
      for (const body of [
        null,
        [],
        {},
        { sessionId: 3 },
        { sessionId: "" },
        { sessionId: "x".repeat(129) },
      ]) {
        const response = await fetch(`${relay.url}/close`, {
          method: "POST",
          headers: {
            authorization: "Bearer token",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(502);
        expect(await response.json()).toEqual({
          error: "virtual network: invalid session id",
        });
      }
      const valid = await fetch(`${relay.url}/close`, {
        method: "POST",
        headers: {
          authorization: "Bearer token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ sessionId: "x".repeat(128) }),
      });
      expect(valid.status).toBe(204);
    } finally {
      await relay.close();
    }
  });
  it("refuses plaintext non-loopback relay transport", () => {
    expect(() =>
      virtualFetchOverHttp("http://relay.example.test", "token"),
    ).toThrow(/HTTPS/u);
    expect(() =>
      virtualFetchOverHttp("https://user:pass@relay.example.test", "token"),
    ).toThrow(/HTTPS/u);
    expect(() =>
      virtualFetchOverHttp("http://localhost:4000", "token"),
    ).toThrow(/HTTPS/u);
  });

  it("refuses plaintext listeners outside literal loopback", async () => {
    await expect(
      startVirtualNetworkRelay({ token: "token", host: "0.0.0.0" }),
    ).rejects.toThrow(/literal loopback/u);
    await expect(
      startVirtualNetworkRelay({ token: "token", host: "localhost" }),
    ).rejects.toThrow(/literal loopback/u);
    await expect(startVirtualNetworkRelay({ token: "" })).rejects.toThrow(
      /token/u,
    );
  });

  it("does not follow cross-origin redirects or allow a session policy to widen", async () => {
    let received = 0;
    const sink = createServer((_request, response) => {
      received += 1;
      response.end();
    });
    await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
    const sinkPort = boundPort(sink, "sink failed");
    const sinkOrigin = `http://127.0.0.1:${sinkPort}`;
    const source = createServer((_request, response) =>
      response.writeHead(307, { location: `${sinkOrigin}/capture` }).end(),
    );
    await new Promise<void>((resolve) =>
      source.listen(0, "127.0.0.1", resolve),
    );
    const sourcePort = boundPort(source, "source failed");
    const sourceOrigin = `http://127.0.0.1:${sourcePort}`;
    const relay = await startVirtualNetworkRelay({
      token: "token",
      allowLoopbackTargets: true,
    });
    const fetch = virtualFetchOverHttp(relay.url, "token");
    try {
      await expect(
        fetch({
          sessionId: "redirect",
          url: sourceOrigin,
          method: "POST",
          body: "password-canary",
          allowedOrigins: [sourceOrigin, sinkOrigin],
        }),
      ).rejects.toThrow(/refused/u);
      expect(received).toBe(0);
      await expect(
        fetch({
          sessionId: "redirect",
          url: sinkOrigin,
          method: "GET",
          allowedOrigins: [sinkOrigin],
        }),
      ).rejects.toThrow(/refused/u);
      expect(received).toBe(0);
    } finally {
      await relay.close();
      await new Promise<void>((resolve) => source.close(() => resolve()));
      await new Promise<void>((resolve) => sink.close(() => resolve()));
    }
  });
});

describe("session lifecycle and redirects", () => {
  it("closes authenticated sessions and expires idle sessions while preserving active resume", async () => {
    let clock = 0;
    const targetFetch: typeof globalThis.fetch = async (_url, init) =>
      new Response(new Headers(init?.headers).get("cookie") ?? "", {
        headers: { "set-cookie": "session=abc; Path=/; Secure" },
      });
    const relay = await startVirtualNetworkRelay({
      token: "token",
      sessionIdleTtlMs: 1000,
      now: () => clock,
      fetchImpl: targetFetch,
    });
    const fetch = virtualFetchOverHttp(relay.url, "token");
    const request = (sessionId: string) => ({
      sessionId,
      url: "https://accounts.test/",
      method: "GET",
    });
    try {
      for (let i = 0; i < 500; i += 1) await fetch(request(`session-${i}`));
      await expect(fetch(request("overflow"))).rejects.toThrow(/refused/u);
      const unauthorized = await globalThis.fetch(`${relay.url}/close`, {
        method: "POST",
        headers: {
          authorization: "Bearer wrong",
          "content-type": "application/json",
        },
        body: JSON.stringify({ sessionId: "session-0" }),
      });
      expect(unauthorized.status).toBe(401);
      await fetch.closeSession?.("session-1");
      await fetch(request("overflow"));
      clock = 500;
      expect((await fetch(request("session-0"))).bodyText).toBe("session=abc");
      clock = 1001;
      await fetch(request("new"));
      expect((await fetch(request("session-0"))).bodyText).toBe("session=abc");
      expect((await fetch(request("session-2"))).bodyText).toBe("");
      expect((await fetch(request("session-1"))).bodyText).toBe("");
    } finally {
      await relay.close();
    }
  }, 20_000);

  it("keeps in-flight sessions until completion after close", async () => {
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const targetFetch: typeof globalThis.fetch = async () => {
      started?.();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return new Response("done");
    };
    const relay = await startVirtualNetworkRelay({
      token: "token",
      fetchImpl: targetFetch,
    });
    const fetch = virtualFetchOverHttp(relay.url, "token");
    const request = {
      sessionId: "active",
      url: "https://accounts.test/",
      method: "GET",
    };
    try {
      const inFlight = fetch(request);
      await entered;
      await fetch.closeSession?.("active");
      await expect(fetch(request)).rejects.toThrow(/refused/u);
      release?.();
      expect((await inFlight).bodyText).toBe("done");
    } finally {
      release?.();
      await relay.close();
    }
  });

  it("allows an approved cross-origin redirect without forwarding body or headers and refuses downgrade", async () => {
    const seen: Array<{
      url: string;
      method: string;
      body: BodyInit | null | undefined;
      headers: Headers;
    }> = [];
    let downgrade = false;
    const targetFetch: typeof globalThis.fetch = async (input, init) => {
      const url = input.toString();
      seen.push({
        url,
        method: init?.method ?? "",
        body: init?.body,
        headers: new Headers(init?.headers),
      });
      if (url.startsWith("https://rp.test"))
        return new Response(null, {
          status: 302,
          headers: {
            location: downgrade
              ? "http://127.0.0.1:9999/"
              : "https://idp.test/",
          },
        });
      return new Response("ok");
    };
    const relay = await startVirtualNetworkRelay({
      token: "token",
      fetchImpl: targetFetch,
    });
    const fetch = virtualFetchOverHttp(relay.url, "token");
    const allowedOrigins = [
      "https://rp.test",
      "https://idp.test",
      "http://127.0.0.1:9999",
    ];
    try {
      const result = await fetch({
        sessionId: "flow",
        url: "https://rp.test/",
        method: "POST",
        body: "password-canary",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        allowedOrigins,
      });
      expect(result.bodyText).toBe("ok");
      expect(seen[1]?.method).toBe("GET");
      expect(seen[1]?.body).toBeUndefined();
      expect(seen[1]?.headers.has("content-type")).toBe(false);
      expect(seen[1]?.headers.has("cookie")).toBe(false);
      downgrade = true;
      await expect(
        fetch({
          sessionId: "downgrade",
          url: "https://rp.test/",
          method: "POST",
          body: "password-canary",
          allowedOrigins,
        }),
      ).rejects.toThrow(/refused/u);
      expect(
        seen.some((entry) => entry.url.startsWith("http://127.0.0.1")),
      ).toBe(false);
    } finally {
      await relay.close();
    }
  });

  it("does not replay a secret-bearing relay RPC across HTTP redirects", async () => {
    let captured = 0;
    const sink = createServer((_request, response) => {
      captured += 1;
      response.end();
    });
    await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
    const sinkPort = boundPort(sink, "sink failed");
    const redirector = createServer((_request, response) =>
      response
        .writeHead(307, {
          location: `http://127.0.0.1:${sinkPort}/capture`,
        })
        .end(),
    );
    await new Promise<void>((resolve) =>
      redirector.listen(0, "127.0.0.1", resolve),
    );
    const redirectorPort = boundPort(redirector, "redirector failed");
    try {
      const fetch = virtualFetchOverHttp(
        `http://127.0.0.1:${redirectorPort}`,
        "secret-token",
      );
      await expect(
        fetch({
          sessionId: "run",
          url: "https://rp.test/",
          method: "POST",
          body: "password-canary",
        }),
      ).rejects.toThrow();
      expect(captured).toBe(0);
    } finally {
      await new Promise<void>((resolve) => redirector.close(() => resolve()));
      await new Promise<void>((resolve) => sink.close(() => resolve()));
    }
  });
});
