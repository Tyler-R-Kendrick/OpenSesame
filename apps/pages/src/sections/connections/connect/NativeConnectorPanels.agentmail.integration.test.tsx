/** @vitest-environment jsdom */
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import { configureNativeApiConnector } from "@opensesame/app-core/lib/native-api-connectors.js";
import { nativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import { tlsFetch } from "@opensesame/app-core/lib/test/native-s3-backup-fixtures.js";
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
const apiKey = "am_private:resource~key";
const body = {
  count: 2,
  inboxes: [
    {
      inbox_id: "inbox-1",
      email: "ops@agentmail.to",
      display_name: "<img src=x onerror=alert(1)>",
      metadata: { ignoredSecret: apiKey },
    },
    { inbox_id: "inbox-2", email: "support@agentmail.to" },
  ],
};
const closed: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closed.splice(0)) await close();
});
function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "agentmail-resource-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "2",
      "-subj",
      "/CN=localhost",
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
      request.headers.cookie === undefined &&
      ["/v0/inboxes", "/v0/inboxes?limit=20"].includes(request.url ?? "");
    const emptyBody = Buffer.concat(chunks).length === 0;
    requests.push({ path: request.url ?? "", authorized, emptyBody });
    response.setHeader("content-type", "application/json");
    if (!authorized || !emptyBody) {
      response.writeHead(403);
      response.end("{}");
      return;
    }
    if (request.url === "/v0/inboxes") response.end(JSON.stringify(body));
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
  fixture.route.respond = async (request) => {
    const url = new URL(request.url);
    if (url.origin !== "https://api.agentmail.to")
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
        respond(response);
        return response;
      };
    },
  };
}
async function saved() {
  const view = await configureNativeApiConnector({
    providerId: "agentmail",
    displayName: "Mailbox",
    parameters: {},
    credentials: { api_key: apiKey },
  });
  const driver = nativeConnectorDriver("api-key", "agentmail");
  return {
    view,
    driver,
    read: () => driver.invoke(view.connectionId, "provider.inboxes.read", {}),
  };
}
function mount(onFlash = vi.fn()) {
  render(
    <MemoryRouter>
      <NativeConnectorPanels
        provider={integrationProvider("agentmail")}
        connection={null}
        onFlash={onFlash}
        onChanged={() => {}}
      />
    </MemoryRouter>,
  );
  return onFlash;
}
it("consumes real typed inboxes from a saved form, then a cold sealed reload, in the shared results UI", async () => {
  const o = await oracle();
  mount();
  await userEvent.click(screen.getByRole("radio", { name: "API Key" }));
  await userEvent.type(screen.getByLabelText("AgentMail API key"), apiKey);
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and connect AgentMail" }),
  );
  await screen.findByRole("button", { name: "List inboxes" });
  expect(screen.queryByText("Check AgentMail access")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "List inboxes" }));
  const section = await screen.findByRole("region", { name: "2 inboxes" });
  expect(
    within(section)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["<img src=x onerror=alert(1)>", "support@agentmail.to"]);
  expect(section.querySelector("img, a")).toBeNull();
  expect(section.textContent).not.toContain(apiKey);
  expect([...o.fixture.disk.files.values()].join()).not.toContain(apiKey);
  expect(JSON.stringify(readDeviceRows())).not.toContain(apiKey);
  expect(screen.getByLabelText("AgentMail API key")).toHaveProperty(
    "value",
    "",
  );
  await o.fixture.reload();
  await userEvent.click(screen.getByRole("button", { name: "List inboxes" }));
  await waitFor(() => expect(o.requests).toHaveLength(3));
  expect(o.requests.map((request) => request.path)).toEqual([
    "/v0/inboxes",
    "/v0/inboxes?limit=20",
    "/v0/inboxes?limit=20",
  ]);
  expect(
    o.requests.every((request) => request.authorized && request.emptyBody),
  ).toBe(true);
  expect(
    (await screen.findByRole("region", { name: "2 inboxes" })).textContent,
  ).toContain("support@agentmail.to");
});
it("returns an actual empty collection as zero resources, not fabricated items", async () => {
  const o = await oracle();
  const s = await saved();
  o.reply({ count: 0, inboxes: [] });
  expect(await s.read()).toEqual({ label: "0 inboxes", items: [] });
});
it.each([
  { count: 1, inboxes: [{ inbox_id: 1, email: "a@agentmail.to" }] },
  { count: 1, inboxes: [{ inbox_id: "a", email: null }] },
  { count: 2, inboxes: [{ inbox_id: "a", email: "a@agentmail.to" }] },
  {
    count: 2,
    inboxes: [
      { inbox_id: "a", email: "a@agentmail.to" },
      { inbox_id: "a", email: "b@agentmail.to" },
    ],
  },
  {
    count: 1,
    inboxes: [
      { inbox_id: "a", email: "a@agentmail.to", display_name: "bad\nlabel" },
    ],
  },
  {
    count: 1,
    inboxes: [
      { inbox_id: "a", email: "a@agentmail.to", display_name: "x".repeat(513) },
    ],
  },
  {
    count: 21,
    inboxes: Array.from({ length: 21 }, (_, index) => ({
      inbox_id: String(index),
      email: "a@agentmail.to",
    })),
  },
  {
    count: 1,
    inboxes: [{ inbox_id: "a", email: "a@agentmail.to" }],
    error: apiKey,
  },
  {
    count: 1,
    inboxes: [{ inbox_id: "a", email: "a@agentmail.to", display_name: apiKey }],
  },
  {
    count: 1,
    inboxes: [
      {
        inbox_id: "a",
        email: "a@agentmail.to",
        display_name: encodeURIComponent(apiKey),
      },
    ],
  },
])(
  "refuses malformed, oversized, duplicate or credential-reflecting typed results %#",
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
  ] as const;
  for (const [key, value] of invalidInputs)
    await expect(
      s.driver.invoke(s.view.connectionId, "provider.inboxes.read", {
        [key]: value,
      }),
    ).rejects.toThrow("does not accept");
  await expect(
    s.driver.invoke(s.view.connectionId, "provider.inboxes.delete", {}),
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
it("bounds the actual streamed TLS body at256KiB and closes the original socket", async () => {
  const o = await oracle();
  const s = await saved();
  const drained = deferred();
  o.hold((response) => {
    response.once("close", drained.resolve);
    response.write(
      `{"count":1,"inboxes":[{"inbox_id":"${"x".repeat(256 * 1024)}`,
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
    response.write('{"count":1,"inboxes":[');
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
it("rejects a late inbox result after the saved connection revision changes", async () => {
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
    providerId: "agentmail",
    displayName: "Renamed",
    parameters: {},
    credentials: {},
    connectionId: s.view.connectionId,
    revision: s.view.revision,
  });
  finish();
  await rejected;
  expect(o.requests).toHaveLength(3);
});
