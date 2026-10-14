import { type Server, createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { NativeOAuthBrowserPort } from "../native-oauth-browser-port.js";
import { tailscaleAppName, tailscaleOAuthAppClient } from "./oauth-app.js";

const APP = {
  id: "operator-4821",
  name: "Operator deployment",
  clientSecret: "fixture-app-secret",
  redirectURIs: ["https://operator.example/callback"],
  scopes: ["auth_keys:create:once"],
};
let server: Server;
let base = "";
let active = true;
let tokenRequests = 0;
let requests: {
  path: string;
  method: string;
  authorization?: string;
  body: string;
}[] = [];
let reply: ((path: string) => object) | undefined;
function client() {
  return tailscaleOAuthAppClient(
    {
      apiBase: base,
      tailnet: "-",
      redirectUri: APP.redirectURIs[0] ?? "",
      name: APP.name,
    },
    {
      fetch,
      assertCurrent() {
        if (!active) throw new Error("Vault locked or configuration cancelled");
      },
    },
  );
}
function browser(
  transform: (value: URL) => URL = (url) => url,
): NativeOAuthBrowserPort {
  return {
    redirectUri: APP.redirectURIs[0] ?? "",
    navigate: vi.fn(),
    scrubCallback: vi.fn(),
    authorize: async (href) => {
      const url = new URL(href);
      expect(url.origin + url.pathname).toBe(
        "https://login.tailscale.com/a/oauth_authorize",
      );
      expect(url.searchParams.get("scope")).toBe("auth_keys:create:once");
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("client_id")).toBe(APP.id);
      const callback = new URL(APP.redirectURIs[0] ?? "");
      callback.searchParams.set("state", url.searchParams.get("state") ?? "");
      callback.searchParams.set("code", "fixture-consent-code");
      return transform(callback).href;
    },
  };
}
beforeEach(async () => {
  active = true;
  tokenRequests = 0;
  requests = [];
  reply = undefined;
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({
      path: req.url ?? "",
      method: req.method ?? "",
      authorization: req.headers.authorization,
      body: Buffer.concat(chunks).toString(),
    });
    const path = req.url ?? "";
    res.setHeader("content-type", "application/json");
    if (reply) {
      res.end(JSON.stringify(reply(path)));
      return;
    }
    if (path === "/api/v2/oauth/token") {
      tokenRequests++;
      res.end(
        JSON.stringify({
          access_token: "fixture-one-use-device-key",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      );
    } else if (req.method === "GET") {
      const { clientSecret, ...metadata } = APP;
      res.end(JSON.stringify(metadata));
    } else res.end(JSON.stringify(APP));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = z
    .object({ port: z.number().int().positive() })
    .parse(server.address());
  base = `http://127.0.0.1:${address.port}/`;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe("Tailscale OAuth app documented HTTP ceremony", () => {
  it("creates an operator-specific app, retains its one-time secret, verifies it, and exchanges consent for the auth key itself", async () => {
    const api = client();
    const retain = vi.fn(async () => undefined);
    const app = await api.register("fixture-admin-token", retain);
    expect(retain).toHaveBeenCalledExactlyOnceWith(APP);
    await api.verify(app, "fixture-admin-token");
    const key = await api.provision(app, browser());
    expect(key).toMatchObject({
      key: "fixture-one-use-device-key",
      singleUse: true,
    });
    expect(key.expiresAt).toBeGreaterThan(Date.now() + 3_599_000);
    expect(requests.map((r) => [r.method, r.path])).toEqual([
      ["POST", "/api/v2/tailnet/-/oauth-apps"],
      ["GET", `/api/v2/tailnet/-/oauth-apps/${APP.id}`],
      ["POST", "/api/v2/oauth/token"],
    ]);
    expect(JSON.parse(requests[0]?.body ?? "")).toEqual({
      name: APP.name,
      redirectUris: APP.redirectURIs,
      scopes: APP.scopes,
    });
    expect(requests[0]?.authorization).toBe(
      `Basic ${btoa("fixture-admin-token:")}`,
    );
    const exchange = new URLSearchParams(requests[2]?.body);
    expect(Object.fromEntries(exchange)).toEqual({
      grant_type: "authorization_code",
      code: "fixture-consent-code",
      client_id: APP.id,
      client_secret: APP.clientSecret,
      redirect_uri: APP.redirectURIs[0],
    });
    expect(requests[2]?.authorization).toBeUndefined();
  });
  it.each(["state", "origin", "path", "duplicate", "error"])(
    "refuses invalid consent %s before token exchange",
    async (failure) => {
      await expect(
        client().provision(
          APP,
          browser((url) => {
            if (failure === "state") url.searchParams.set("state", "wrong");
            if (failure === "origin") url.host = "attacker.example";
            if (failure === "path") url.pathname = "/other";
            if (failure === "duplicate")
              url.searchParams.append("code", "second");
            if (failure === "error")
              url.searchParams.set("error", "access_denied");
            return url;
          }),
        ),
      ).rejects.toThrow();
      expect(tokenRequests).toBe(0);
    },
  );
  it("refuses a cancelled or locked session before any request", async () => {
    active = false;
    await expect(
      client().register("fixture-admin-token", async () => undefined),
    ).rejects.toThrow();
    await expect(client().provision(APP, browser())).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
  it("does not expose a late token after the vault session ends", async () => {
    reply = () => {
      active = false;
      return {
        access_token: "late-secret",
        token_type: "Bearer",
        expires_in: 3600,
      };
    };
    await expect(client().provision(APP, browser())).rejects.toThrow();
  });
  it("does not retain an app with expanded scopes or a changed callback", async () => {
    reply = () => ({ ...APP, scopes: [...APP.scopes, "all"] });
    const retain = vi.fn(async () => undefined);
    await expect(
      client().register("fixture-admin-token", retain),
    ).rejects.toThrow();
    expect(retain).not.toHaveBeenCalled();
  });
  it("refuses an unexpected token lifetime instead of claiming a valid one-hour key", async () => {
    reply = () => ({
      access_token: "fixture",
      token_type: "Bearer",
      expires_in: 7200,
    });
    await expect(client().provision(APP, browser())).rejects.toThrow();
  });
  it("honors cancellation while a consent popup is pending", async () => {
    const abort = new AbortController();
    const port = browser();
    port.authorize = async (_href, options) => {
      expect(options.signal).toBe(abort.signal);
      abort.abort();
      throw new Error("Cancelled");
    };
    await expect(client().provision(APP, port, abort.signal)).rejects.toThrow(
      "Cancelled",
    );
    expect(tokenRequests).toBe(0);
  });
  it("generates different app display identities per ceremony", () => {
    expect(tailscaleAppName()).not.toBe(tailscaleAppName());
  });
});
it("transmits custom provisioning attributes and refuses any expanded vendor response before retaining its secret", async () => {
  const config = {
    ...client().config,
    allowedNodeAttributes: ["custom:operator"],
  };
  const api = tailscaleOAuthAppClient(config, { fetch, assertCurrent() {} });
  reply = () => ({
    ...APP,
    allowedNodeAttributes: config.allowedNodeAttributes,
  });
  const retain = vi.fn(async () => undefined);
  await api.register("fixture-admin", retain);
  expect(JSON.parse(requests[0]?.body ?? "")).toHaveProperty(
    "allowedNodeAttributes",
    ["custom:operator"],
  );
  reply = () => ({
    ...APP,
    allowedNodeAttributes: ["custom:operator", "custom:extra"],
  });
  retain.mockClear();
  await expect(api.register("fixture-admin", retain)).rejects.toThrow();
  expect(retain).not.toHaveBeenCalled();
  for (const attrs of [["tag:admin"], ["custom:operator", "custom:operator"]])
    expect(() =>
      tailscaleOAuthAppClient(
        { ...config, allowedNodeAttributes: attrs },
        { fetch, assertCurrent() {} },
      ),
    ).toThrow();
});
