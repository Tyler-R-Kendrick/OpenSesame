/** @vitest-environment jsdom */
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import {
  configureNativeApiConnector,
  testNativeApiCredential,
} from "@opensesame/app-core/lib/native-api-connectors.js";
import { nativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import { tlsFetch } from "@opensesame/app-core/lib/native-s3-backup.test-support.js";
import type { BoundaryValue } from "@opensesame/os-domain";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { NativeConnectorPanels } from "./NativeConnectorPanels.js";
import {
  connectorIntegration,
  installConnectorIntegration,
  integrationProvider,
} from "./native-connector-integration.test-support.js";

installConnectorIntegration();
const apiKey = "cloudflare_private:resource~key";
const first = {
  id: "023e105f4ecef8ad9ca31a8372d0c353",
  name: "example.com",
  account: { id: "owned-account", name: apiKey },
  owner: { name: "Private owner" },
  name_servers: ["alice.ns.cloudflare.com"],
  status: "active",
  verification_key: apiKey,
};
const second = {
  ...first,
  id: "023e105f4ecef8ad9ca31a8372d0c354",
  name: "example.net",
};
const body = {
  success: true,
  errors: [],
  messages: [],
  result: [first, second],
  result_info: {
    page: 1,
    per_page: 20,
    count: 2,
    total_count: 27,
    total_pages: 2,
  },
};
const draft = {
  providerId: "cloudflare",
  displayName: "Cloudflare zones",
  parameters: {},
  credentials: { api_key: apiKey },
};
const closed: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closed.splice(0)) await close();
});
function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "cloudflare-resource-"));
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
function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
/** Independent fixed-route/auth oracle with real pinned HTTPS streamed bodies. */
async function oracle() {
  const tls = certificate();
  const fixture = connectorIntegration();
  const requests: { path: string; authorized: boolean; emptyBody: boolean }[] =
    [];
  let write = (response: ServerResponse) => response.end(JSON.stringify(body));
  const server = createServer(tls, async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const authorized =
      request.method === "GET" &&
      request.headers.authorization === `Bearer ${apiKey}` &&
      request.headers["x-auth-key"] === undefined &&
      request.headers["x-auth-email"] === undefined &&
      request.headers.cookie === undefined &&
      [
        "/client/v4/user/tokens/verify",
        "/client/v4/zones?page=1&per_page=20",
      ].includes(request.url ?? "");
    const emptyBody = Buffer.concat(chunks).length === 0;
    requests.push({ path: request.url ?? "", authorized, emptyBody });
    response.setHeader("content-type", "application/json");
    if (!authorized || !emptyBody) {
      response.writeHead(403);
      response.end("{}");
      return;
    }
    if (request.url === "/client/v4/user/tokens/verify") {
      response.end(
        JSON.stringify({
          success: true,
          errors: [],
          result: { id: "token-123", status: "active" },
        }),
      );
      return;
    }
    write(response);
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
  fixture.route.respond = async (request) => {
    const url = new URL(request.url);
    if (url.origin !== "https://api.cloudflare.com")
      throw new Error("Unexpected original provider origin");
    return fetcher(
      new URL(url.pathname + url.search, `https://127.0.0.1:${address.port}`),
      request,
    );
  };
  return {
    fixture,
    requests,
    reply: (value: BoundaryValue, status = 200) => {
      write = (response) => {
        response.writeHead(status);
        return response.end(JSON.stringify(value));
      };
    },
    hold: (respond: (response: ServerResponse) => void) => {
      write = (response) => {
        write = (next) => next.end(JSON.stringify(body));
        respond(response);
        return response;
      };
    },
  };
}
async function saved() {
  const view = await configureNativeApiConnector(draft);
  const driver = nativeConnectorDriver("api-key", "cloudflare");
  return {
    view,
    driver,
    read: () => driver.invoke(view.connectionId, "provider.zones.read", {}),
  };
}
function mount(onFlash = vi.fn()) {
  render(
    <MemoryRouter>
      <NativeConnectorPanels
        provider={integrationProvider("cloudflare")}
        connection={null}
        onFlash={onFlash}
        onChanged={() => {}}
      />
    </MemoryRouter>,
  );
  return onFlash;
}
it("reads actual first-page zones with saved bearer token through common UI and cold sealed reload", async () => {
  const o = await oracle();
  await testNativeApiCredential(draft);
  mount();
  await userEvent.click(screen.getByRole("radio", { name: "API Key" }));
  await userEvent.type(screen.getByLabelText("Cloudflare API key"), apiKey);
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and connect Cloudflare" }),
  );
  await screen.findByRole("button", { name: "List zones" });
  expect(screen.queryByText("Check Cloudflare access")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "List zones" }));
  const section = await screen.findByRole("region", {
    name: "Showing 2 zones from first page",
  });
  expect(
    within(section)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["example.com", "example.net"]);
  expect(section.querySelector("img, a")).toBeNull();
  expect(section.textContent).not.toContain(apiKey);
  expect([...o.fixture.disk.files.values()].join()).not.toContain(apiKey);
  expect(JSON.stringify(readDeviceRows())).not.toContain(apiKey);
  expect(screen.getByLabelText("Cloudflare API key")).toHaveProperty(
    "value",
    "",
  );
  await o.fixture.reload();
  await userEvent.click(screen.getByRole("button", { name: "List zones" }));
  await waitFor(() => expect(o.requests).toHaveLength(4));
  expect(o.requests.map((request) => request.path)).toEqual([
    "/client/v4/user/tokens/verify",
    "/client/v4/user/tokens/verify",
    "/client/v4/zones?page=1&per_page=20",
    "/client/v4/zones?page=1&per_page=20",
  ]);
  expect(
    o.requests.every((request) => request.authorized && request.emptyBody),
  ).toBe(true);
  await screen.findByText("example.net", { selector: "li" });
});
it("returns an actual empty collection as zero resources, not fabricated items", async () => {
  const o = await oracle();
  const s = await saved();
  o.reply({ success: true, errors: [], result: [] });
  expect(await s.read()).toEqual({
    label: "Showing 0 zones from first page",
    items: [],
  });
  o.reply({
    success: true,
    errors: [],
    result: [{ ...second, name: "<img src=x onerror=alert(1)>" }],
  });
  expect(await s.read()).toEqual({
    label: "Showing 1 zone from first page",
    items: [{ id: second.id, label: "<img src=x onerror=alert(1)>" }],
  });
});
it.each([
  { ...body, success: false },
  { ...body, errors: [{ code: 1001, message: apiKey }] },
  { ...body, errors: undefined },
  { ...body, result: undefined },
  { ...body, result: [{ ...first, id: "" }] },
  { ...body, result: [{ ...first, id: "x".repeat(33) }] },
  { ...body, result: [{ ...first, name: 1 }] },
  { ...body, result: [{ ...first, name: "" }] },
  { ...body, result: [{ ...first, name: "bad\nlabel" }] },
  { ...body, result: [{ ...first, name: "x".repeat(254) }] },
  { ...body, result: [first, first] },
  {
    ...body,
    result: Array.from({ length: 21 }, (_, n) => ({ ...first, id: String(n) })),
  },
  { ...body, result_info: { page: 2 } },
  { ...body, result_info: { per_page: 50 } },
  { ...body, result_info: { count: 3 } },
  { ...body, result_info: { total_count: 1 } },
  { ...body, result_info: { total_pages: 0 } },
  { ...body, result_info: { total_pages: -1 } },
  { ...body, result_info: { count: 1.5 } },
  { ...body, result_info: { total_count: Number.MAX_SAFE_INTEGER + 1 } },
  { ...body, result: [{ ...first, name: apiKey }] },
  { ...body, result: [{ ...first, name: encodeURIComponent(apiKey) }] },
])(
  "refuses provider errors, malformed pagination/resources or credential echoes %#",
  async (invalid) => {
    const o = await oracle();
    const s = await saved();
    o.reply(invalid);
    await expect(s.read()).rejects.toMatchObject({
      code: "response",
      message: "Provider did not return the expected response",
    });
  },
);
it("refuses arbitrary UI request input and unknown actions before network dispatch", async () => {
  const o = await oracle();
  const s = await saved();
  const invalidInputs = [
    ["url", "https://other.example"],
    ["limit", "10000"],
    ["api_key", "override"],
    ["page_token", "unbounded"],
    ["account.id", "OTHERACCOUNT"],
  ] as const;
  const read = (input: Parameters<typeof s.driver.invoke>[2]) =>
    s.driver.invoke(s.view.connectionId, "provider.zones.read", input);
  for (const [key, value] of invalidInputs)
    await expect(read({ [key]: value })).rejects.toThrow("does not accept");
  await expect(
    s.driver.invoke(s.view.connectionId, "provider.zones.delete", {}),
  ).rejects.toThrow("Unsupported provider API operation");
  expect(o.requests).toHaveLength(1);
});
it.each([
  [401, "authorization"],
  [403, "permission"],
  [429, "rate-limit"],
  [500, "response"],
] as const)(
  "preserves actual HTTP %s and redacts upstream errors",
  async (status, code) => {
    const o = await oracle();
    const s = await saved();
    o.reply({ error: apiKey }, status);
    await expect(s.read()).rejects.toMatchObject({ code, status });
    expect(readNativeConnector(s.view.connectionId)?.status).toBe(
      status === 401 ? "reauthorize" : "connected",
    );
  },
);
it("bounds the actual streamed TLS body at 256KiB and closes the original socket", async () => {
  const o = await oracle();
  const s = await saved();
  const drained = deferred();
  o.hold((response) => {
    response.once("close", drained.resolve);
    response.write(
      `{"success":true,"errors":[],"result":[{"name":"${"x".repeat(256 * 1024)}`,
    );
  });
  await expect(s.read()).rejects.toMatchObject({ code: "response" });
  await drained.promise;
});
it("physically drains an original held read on owner withdrawal and refuses the retained old driver", async () => {
  const o = await oracle();
  const s = await saved();
  const arrived = deferred();
  const drained = deferred();
  o.hold((response) => {
    response.once("close", drained.resolve);
    response.write('{"success":true,"errors":[],"result":[');
    arrived.resolve();
  });
  const pending = s.read();
  const rejected = expect(pending).rejects.toThrow();
  await arrived.promise;
  o.fixture.activation.dispose();
  await rejected;
  await drained.promise;
  await expect(s.read()).rejects.toThrow();
  expect(o.requests).toHaveLength(2);
});
it("rejects a late zone result after the saved connection revision changes", async () => {
  const o = await oracle();
  const s = await saved();
  const arrived = deferred();
  let finish = () => {};
  o.hold((response) => {
    finish = () => {
      response.end(JSON.stringify(body));
    };
    arrived.resolve();
  });
  const pending = s.read();
  const rejected = expect(pending).rejects.toThrow("changed");
  await arrived.promise;
  await configureNativeApiConnector({
    ...draft,
    displayName: "Renamed",
    credentials: {},
    connectionId: s.view.connectionId,
    revision: s.view.revision,
  });
  finish();
  await rejected;
  expect(o.requests).toHaveLength(3);
});
