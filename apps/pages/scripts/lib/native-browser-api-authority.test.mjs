/** @vitest-environment node */
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import { configureNativeApiConnector } from "@opensesame/app-core/lib/native-api-connectors.js";
import { nativeApiResourceActions } from "@opensesame/app-core/lib/native-api-resources.js";
import { nativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import { tlsFetch } from "@opensesame/app-core/lib/native-s3-backup.test-support.js";
import { JSDOM } from "jsdom";
import { afterEach, expect, it, vi } from "vitest";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "../../src/sections/connections/connect/native-connector-integration.test-support.js";
import { routeNativeApiAuthority } from "./native-browser-api-authority.mjs";

installConnectorIntegration();
const cleanup = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.unstubAllGlobals();
});
function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "postmark-ci-"));
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
/** Real HTTPS wraps the actual browser authority handler; unchanged synthetic authority routing. */
async function authority() {
  const handlers = [];
  const upstream = await routeNativeApiAuthority(
    {
      route: async (match, handle) => {
        handlers.push({ match, handle });
      },
    },
    {
      check: (ok, message) => expect(ok, message).toBe(true),
    },
  );
  const protocol = upstream.fixtures.find(
    (fixture) => fixture.providerId === "postmark",
  );
  if (!protocol?.read) throw new Error("Postmark resource fixture missing");
  const dom = new JSDOM("", { url: "https://selfhost.example/OpenSesame/" });
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  cleanup.push(async () => dom.window.close());
  const fixture = connectorIntegration();
  const tls = certificate();
  const requests = [];
  const settlements = [];
  const server = createServer(tls, async (incoming, response) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const url = new URL(incoming.url ?? "/", "https://api.postmarkapp.com");
    requests.push({ path: url.pathname + url.search, method: incoming.method });
    settlements.push(new Promise((resolve) => response.once("close", resolve)));
    const request = {
      url: () => url.href,
      method: () => incoming.method,
      allHeaders: async () => incoming.headers,
      postData: () => body || null,
    };
    const matches = handlers.filter((entry) => entry.match(url)).reverse();
    async function dispatch(index) {
      const entry = matches[index];
      if (!entry) {
        response.writeHead(404);
        response.end("{}");
        return;
      }
      await entry.handle({
        request: () => request,
        fallback: () => dispatch(index + 1),
        fulfill: async (reply) => {
          if (response.destroyed) return;
          response.writeHead(reply.status, {
            ...reply.headers,
            "content-type": reply.contentType ?? "application/json",
          });
          response.end(reply.body);
        },
      });
    }
    await dispatch(0);
  });
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(tls.directory, { recursive: true, force: true });
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = server.address();
  if (!address || !(address instanceof Object))
    throw new Error("Missing TCP oracle address");
  const fetcher = tlsFetch(tls.cert);
  fixture.route.respond = async (request) => {
    const url = new URL(request.url);
    if (url.origin !== "https://api.postmarkapp.com")
      throw new Error("Unexpected provider origin");
    return fetcher(
      new URL(url.pathname + url.search, `https://127.0.0.1:${address.port}`),
      request,
    );
  };
  const browserFetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("Browser fetch forbidden");
  });
  return { upstream, protocol, fixture, requests, settlements, browserFetch };
}
function draft(protocol) {
  return {
    providerId: "postmark",
    displayName: "CI Postmark",
    parameters: protocol.parameters,
    credentials: protocol.credentials,
  };
}
async function saved(o) {
  const view = await configureNativeApiConnector(draft(o.protocol));
  const driver = nativeConnectorDriver("api-key", "postmark");
  return {
    view,
    read: () => driver.invoke(view.connectionId, o.protocol.read.id, {}),
  };
}
it("uses the CI resource fixture through saved common controller and cold sealed reload", async () => {
  const o = await authority();
  expect(nativeApiResourceActions("postmark", "api-key")).toEqual([
    { id: o.protocol.read.id, label: o.protocol.read.label },
  ]);
  const s = await saved(o);
  expect(await s.read()).toEqual(o.protocol.read.result);
  for (const privateText of [
    ...Object.values(o.protocol.credentials),
    ...o.protocol.read.excludedText,
  ]) {
    expect(JSON.stringify(o.protocol.read.result)).not.toContain(privateText);
  }
  expect(JSON.stringify(readDeviceRows())).not.toContain(
    o.protocol.credentials.api_key,
  );
  expect([...o.fixture.disk.files.values()].join()).not.toContain(
    o.protocol.credentials.api_key,
  );
  await o.fixture.reload();
  expect(await s.read()).toEqual(o.protocol.read.result);
  expect(o.requests.map((item) => item.path)).toEqual([
    "/server",
    ...Array(2).fill(
      "/messages/outbound?count=20&offset=0&messagestream=outbound",
    ),
  ]);
  expect(
    o.upstream.state.calls.map((call) => [call.purpose, call.operation]),
  ).toEqual([
    ["verification", null],
    ...Array(2).fill(["resource", "provider.messages.read"]),
  ]);
  expect(o.browserFetch).not.toHaveBeenCalled();
});
it.each([
  ["GET", "/messages/outbound?count=21&offset=0&messagestream=outbound", {}],
  ["GET", "/messages/outbound?count=20&offset=1&messagestream=outbound", {}],
  ["GET", "/messages/outbound?count=20&offset=0&messagestream=broadcast", {}],
  [
    "GET",
    "/messages/outbound?count=20&offset=0&messagestream=outbound&url=https://other.example",
    {},
  ],
  [
    "GET",
    "/messages/outbound?count=20&offset=0&messagestream=outbound",
    { "X-Postmark-Server-Token": "wrong" },
  ],
  [
    "GET",
    "/messages/outbound?count=20&offset=0&messagestream=outbound",
    { Authorization: "Bearer wrong" },
  ],
  [
    "GET",
    "/messages/outbound?count=20&offset=0&messagestream=outbound",
    { "X-Postmark-Account-Token": "wrong" },
  ],
  [
    "GET",
    "/messages/outbound?count=20&offset=0&messagestream=outbound",
    { Cookie: "session=wrong" },
  ],
  ["POST", "/messages/outbound?count=20&offset=0&messagestream=outbound", {}],
])(
  "refuses wrong outbound query/auth/method at the actual TLS authority %#",
  async (method, path, extra) => {
    const o = await authority();
    const response = await o.fixture.route.respond(
      new Request(`https://api.postmarkapp.com${path}`, {
        method,
        headers: {
          Accept: "application/json",
          "X-Postmark-Server-Token": o.protocol.credentials.api_key,
          ...extra,
        },
      }),
    );
    expect(response.status).toBe(404);
    await response.text();
    expect(o.upstream.state.calls).toHaveLength(0);
    expect(o.browserFetch).not.toHaveBeenCalled();
  },
);
it.each([
  ["reject", "authorization"],
  ["unavailable", "response"],
  ["malformed", "response"],
])("retains %s failure semantics on resource requests", async (flag, code) => {
  const o = await authority();
  const s = await saved(o);
  o.upstream.state[flag].add("postmark");
  await expect(s.read()).rejects.toMatchObject({ code });
  expect(o.upstream.state.calls.at(-1)).toMatchObject({
    purpose: "resource",
    operation: "provider.messages.read",
  });
  expect(o.browserFetch).not.toHaveBeenCalled();
});
it("checks replacement credentials on the distinct actual resource route", async () => {
  const o = await authority();
  const next = o.upstream.alternate(o.protocol, "replacement");
  const view = await configureNativeApiConnector(draft(next));
  expect(
    await nativeConnectorDriver("api-key", "postmark").invoke(
      view.connectionId,
      o.protocol.read.id,
      {},
    ),
  ).toEqual(o.protocol.read.result);
  expect(o.upstream.state.calls.map((call) => call.credentialProof)).toEqual([
    "replacement",
    "replacement",
  ]);
  expect(o.browserFetch).not.toHaveBeenCalled();
});
it("physically drains paused actual resource traffic on owner withdrawal", async () => {
  const o = await authority();
  const s = await saved(o);
  const release = o.upstream.pause("postmark");
  try {
    const pending = s.read();
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(o.upstream.state.calls).toHaveLength(2));
    o.fixture.activation.dispose();
    await rejected;
    await o.settlements[1];
    await expect(s.read()).rejects.toThrow();
    expect(o.upstream.state.calls).toHaveLength(2);
    expect(o.browserFetch).not.toHaveBeenCalled();
  } finally {
    release();
  }
});
