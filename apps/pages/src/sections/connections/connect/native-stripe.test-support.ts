import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tlsFetch } from "@opensesame/app-core/lib/native-s3-backup.test-support.js";
import {
  deferred,
  runtimeFixture,
} from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import {
  type TailscaleBrowserNode,
  TailscaleNativeHTTPConfiguration,
  bindTailscaleBrowserNode,
} from "@opensesame/app-core/lib/tailscale/browser-node-port.js";
import { openBrowserNodeState } from "@opensesame/app-core/lib/tailscale/browser-node-store.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { BoundaryValue } from "@opensesame/os-domain";
import { vi } from "vitest";
import { createActivation } from "../../../modules/activation.js";
import { bindNativeApiRuntime } from "../../../modules/connectors.external/native-api-runtime.js";
import { bindNativeRuntime } from "../../../modules/connectors.external/native-runtime.js";
import { createTestContext } from "../../../modules/test-context.js";

export const stripeKey = "stripe-owned:read-only~credential";
export const stripeOrigin = "https://api.stripe.com";
export const stripeBalance = {
  object: "balance",
  livemode: false,
  available: [{ amount: 1500, currency: "usd", source_types: { card: 1500 } }],
  pending: [{ amount: -7, currency: "jpy" }],
};
export const stripeDraft = {
  providerId: "stripe",
  displayName: "Read-only account balance",
  parameters: {},
  credentials: { api_key: stripeKey },
};

function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "stripe-native-balance-"));
  execFileSync(
    "openssl",
    [
      ..."req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=localhost".split(
        " ",
      ),
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  return {
    directory,
    key: readFileSync(join(directory, "key.pem")),
    cert: readFileSync(join(directory, "cert.pem")),
  };
}

function routeOracle(
  tls: ReturnType<typeof certificate>,
  expectedPath: string,
) {
  const requests: { authorized: boolean; path: string; emptyBody: boolean }[] =
    [];
  let respond = (response: ServerResponse) =>
    response.end(JSON.stringify(stripeBalance));
  const server = createServer(tls, async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const authorized =
      request.method === "GET" &&
      request.url === expectedPath &&
      request.headers.authorization === `Bearer ${stripeKey}` &&
      request.headers["stripe-version"] === "2026-09-30.endive" &&
      request.headers.cookie === undefined &&
      request.headers["stripe-account"] === undefined;
    const emptyBody = Buffer.concat(chunks).length === 0;
    requests.push({ authorized, path: request.url ?? "", emptyBody });
    response.setHeader("content-type", "application/json");
    if (!authorized || !emptyBody) {
      response.writeHead(401);
      response.end(JSON.stringify({ error: { message: stripeKey } }));
      return;
    }
    respond(response);
  });
  return {
    server,
    requests,
    reply(body: BoundaryValue, status = 200) {
      respond = (response) => {
        response.writeHead(status);
        return response.end(JSON.stringify(body));
      };
    },
    hold() {
      const arrived = deferred<void>();
      const closed = deferred<void>();
      respond = (response) => {
        response.once("close", () => closed.resolve());
        response.write('{"object":"balance","available":[');
        arrived.resolve();
        return response;
      };
      return { arrived: arrived.promise, closed: closed.promise };
    },
  };
}

/** Independent HTTPS route/auth oracle behind the real captured native transport boundary. */
export async function stripeOracle(expectedPath = "/v1/balance") {
  const storage = await runtimeFixture();
  const tls = certificate();
  const oracle = routeOracle(tls, expectedPath);
  const { server } = oracle;
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = server.address();
  if (!address || !(address instanceof Object))
    throw new Error("TLS oracle address missing");
  const fetcher = tlsFetch(tls.cert);
  const lifetime = new AbortController();
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const source = new Request(input, init);
    const request = new Request(source, {
      signal: AbortSignal.any([source.signal, lifetime.signal]),
    });
    lifetime.signal.throwIfAborted();
    if (new URL(request.url).origin !== stripeOrigin)
      throw new Error("Unexpected provider origin");
    const response = await fetcher(
      new URL(
        new URL(request.url).pathname + new URL(request.url).search,
        `https://127.0.0.1:${address.port}`,
      ),
      request,
    );
    lifetime.signal.throwIfAborted();
    return response;
  });
  const snapshot: ReturnType<TailscaleBrowserNode["snapshot"]> = {
    status: "connected",
    hostname: "stripe-browser",
    controlURL: "https://controlplane.tailscale.com",
    authURL: "",
    addresses: ["100.64.0.3"],
    peerCount: 1,
    failure: "",
  };
  const node: TailscaleBrowserNode = {
    captureNativeHTTP: () => ({
      fetch,
      signal: lifetime.signal,
      assertCurrent: () => lifetime.signal.throwIfAborted(),
    }),
    snapshot: () => snapshot,
    subscribe: () => () => {},
    start: async () => {},
    stop: () => lifetime.abort(),
    forget: async () => {},
    login() {},
    get: async () => {
      throw new Error("No peer probe in this test");
    },
  };
  await openBrowserNodeState(
    {
      hostname: "stripe-browser",
      controlURL: "https://controlplane.tailscale.com",
      nativeHTTP: TailscaleNativeHTTPConfiguration.parse({
        version: 1,
        exitNodeID: "approved-exit",
        trustMode: "public",
        targets: [{ origin: stripeOrigin, prefixes: ["203.0.113.0/24"] }],
      }),
    },
    vaultStore.getSnapshot().tomb,
    () => {
      if (!vaultStore.isUnlocked()) throw new Error("Vault locked");
    },
  );
  const release = bindTailscaleBrowserNode(node);
  const context = createTestContext();
  const activation = createActivation(context.ctx, "connectors.external");
  bindNativeRuntime(context.ctx, activation);
  bindNativeApiRuntime(activation);
  const browser = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Browser fallback forbidden"));
  return {
    storage,
    ...oracle,
    fetch,
    browser,
    context,
    activation,
    lifetime,
    async close() {
      activation.dispose();
      lifetime.abort();
      release();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(tls.directory, { recursive: true, force: true });
      await storage.close();
    },
  };
}
