/** Owned TLS provider oracle; loopback mapping is test infrastructure only. */
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureNativeApiConnector } from "@opensesame/app-core/lib/native-api-connectors.js";
import { nativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import { runtimeFixture } from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import {
  type TailscaleBrowserNode,
  TailscaleNativeHTTPConfiguration,
  bindTailscaleBrowserNode,
} from "@opensesame/app-core/lib/tailscale/browser-node-port.js";
import { openBrowserNodeState } from "@opensesame/app-core/lib/tailscale/browser-node-store.js";
import { tlsFetch } from "@opensesame/app-core/lib/test/native-s3-backup-fixtures.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { BoundaryValue } from "@opensesame/os-domain";
import { vi } from "vitest";
import { connectorIntegration } from "./native-connector-integration.test-support.js";

export const apiKey = "datadog_api:resource~key";
export const applicationKey = "datadog_application:resource~key";
export const sites = [
  "datadoghq.com",
  "us3.datadoghq.com",
  "us5.datadoghq.com",
  "datadoghq.eu",
  "ap1.datadoghq.com",
  "ap2.datadoghq.com",
  "uk1.datadoghq.com",
  "ddog-gov.com",
  "us2.ddog-gov.com",
] as const;
export const monitors = [
  {
    id: 12861,
    name: "<img src=x onerror=alert(1)>",
    message: apiKey,
    query: applicationKey,
    tags: [apiKey],
    creator: { email: applicationKey },
    assets: [{ url: "https://discard.example/secret" }],
  },
  { id: 12862, name: "Queue depth" },
];
const closed: (() => Promise<void>)[] = [];
export async function closeDatadogOracles() {
  for (const close of closed.splice(0).reverse()) await close();
}
export function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "datadog-resource-"));
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
export function draft(site: string = sites[0]) {
  return {
    providerId: "datadog",
    displayName: "Organization monitors",
    parameters: { site },
    credentials: { api_key: apiKey, application_key: applicationKey },
  };
}
export async function saved(site: string = sites[0]) {
  const view = await configureNativeApiConnector(draft(site));
  const driver = nativeConnectorDriver("api-key", "datadog");
  return {
    view,
    driver,
    read: (signal?: AbortSignal) =>
      driver.invoke(view.connectionId, "provider.monitors.read", {}, signal),
  };
}
/** A strict configured-node port carries actual TLS, retaining every original owner signal. */
async function nativeNode(fetcher: typeof fetch) {
  const config = {
    hostname: "datadog-browser",
    controlURL: "https://controlplane.tailscale.com",
    nativeHTTP: TailscaleNativeHTTPConfiguration.parse({
      version: 1,
      exitNodeID: "approved-test-exit",
      trustMode: "public",
      targets: sites.map((site) => ({
        origin: `https://api.${site}`,
        prefixes: ["203.0.113.0/24"],
      })),
    }),
  };
  await openBrowserNodeState(config, vaultStore.getSnapshot().tomb, () => {
    if (vaultStore.getSnapshot().status !== "unlocked")
      throw new Error("Vault locked");
  });
  const lifetime = new AbortController();
  const capture = vi.fn((owner: AbortSignal) => {
    const signal = AbortSignal.any([owner, lifetime.signal]);
    const assertCurrent = () => signal.throwIfAborted();
    return {
      signal,
      assertCurrent,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        assertCurrent();
        const request = new Request(input, init);
        return fetcher(request, {
          signal: AbortSignal.any([signal, request.signal]),
        });
      },
    };
  });
  const value: TailscaleBrowserNode = {
    captureNativeHTTP: capture,
    snapshot: () => ({
      status: "connected",
      hostname: config.hostname,
      controlURL: config.controlURL,
      authURL: "",
      addresses: ["100.64.0.3"],
      peerCount: 1,
      failure: "",
    }),
    subscribe: () => () => {},
    start: async () => {},
    stop: () => lifetime.abort(),
    forget: async () => {},
    login() {},
    get: async () => {
      throw new Error("No peer GET fixture");
    },
  };
  const release = bindTailscaleBrowserNode(value);
  closed.push(async () => release());
  return { value, capture, lifetime };
}
/** Neither production parser nor runtime constructs the oracle's expected auth/query. */
export async function datadogOracle(native = false) {
  const fixture = connectorIntegration();
  if (native) {
    const vault = await runtimeFixture();
    closed.push(() => vault.close());
  }
  const tls = certificate();
  const requests: { path: string; authorized: boolean; bytes: number }[] = [];
  const origins: string[] = [];
  let write = (response: ServerResponse) =>
    response.end(JSON.stringify(monitors));
  const server = createServer(tls, async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const authorized =
      request.method === "GET" &&
      request.headers["dd-api-key"] === apiKey &&
      request.headers["dd-application-key"] === applicationKey &&
      request.headers.authorization === undefined &&
      request.headers.cookie === undefined &&
      ["/api/v2/validate_keys", "/api/v1/monitor?page=0&page_size=20"].includes(
        request.url ?? "",
      );
    const bytes = Buffer.concat(chunks).length;
    requests.push({ path: request.url ?? "", authorized, bytes });
    response.setHeader("content-type", "application/json");
    if (!authorized || bytes) {
      response.writeHead(403);
      response.end("{}");
      return;
    }
    if (request.url === "/api/v2/validate_keys")
      response.end('{"status":"ok"}');
    else write(response);
  });
  closed.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tls.directory, { recursive: true, force: true });
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = server.address();
  if (!address || !(address instanceof Object))
    throw new Error("Missing TCP oracle address");
  const fetcher = tlsFetch(tls.cert);
  const route: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!sites.some((site) => url.origin === `https://api.${site}`))
      throw new Error("Unexpected original provider origin");
    origins.push(url.origin);
    return fetcher(
      new URL(url.pathname + url.search, `https://127.0.0.1:${address.port}`),
      request,
    );
  };
  fixture.route.respond = (request) => route(request);
  const browserFetch = vi.fn(async () => {
    throw new Error("Native route must not fall back to browser fetch");
  });
  const node = native ? await nativeNode(route) : null;
  if (native) fixture.route.respond = browserFetch;
  return {
    fixture,
    requests,
    origins,
    node,
    browserFetch,
    reply: (value: BoundaryValue, status = 200) => {
      write = (response) => {
        response.writeHead(status);
        return response.end(JSON.stringify(value));
      };
    },
    hold: (respond: (response: ServerResponse) => void) => {
      write = (response) => {
        write = (next) => next.end(JSON.stringify(monitors));
        respond(response);
        return response;
      };
    },
  };
}
