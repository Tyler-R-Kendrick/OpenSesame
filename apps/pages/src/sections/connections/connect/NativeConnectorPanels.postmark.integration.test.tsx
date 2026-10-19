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
const apiKey = "pm_private:resource~key";
const first = {
  MessageID: "0ac29aee-e1cd-480d-b08d-4f48548ff48d",
  MessageStream: "outbound",
  Subject: "<img src=x onerror=alert(1)>",
  Status: "Sent",
  Metadata: { ignoredSecret: apiKey },
};
const second = {
  MessageID: "e30970cd-3901-4cc4-8b52-9e7dd57ce350",
  MessageStream: "outbound",
  Subject: "Followup",
  Status: "Queued",
};
const body = { TotalCount: 194, Messages: [first, second] };

const closed: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closed.splice(0)) await close();
});
function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "postmark-resource-"));
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
      request.headers["x-postmark-server-token"] === apiKey &&
      request.headers.accept === "application/json" &&
      request.headers.authorization === undefined &&
      request.headers.cookie === undefined &&
      [
        "/server",
        "/messages/outbound?count=20&offset=0&messagestream=outbound",
      ].includes(request.url ?? "");
    const emptyBody = Buffer.concat(chunks).length === 0;
    requests.push({ path: request.url ?? "", authorized, emptyBody });
    response.setHeader("content-type", "application/json");
    if (!authorized || !emptyBody) {
      response.writeHead(403);
      response.end("{}");
      return;
    }
    if (request.url === "/server")
      response.end(JSON.stringify({ ID: 1, Name: "Owned Postmark server" }));
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
    if (url.origin !== "https://api.postmarkapp.com")
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
    providerId: "postmark",
    displayName: "Outbound mail",
    parameters: {},
    credentials: { api_key: apiKey },
  });
  const driver = nativeConnectorDriver("api-key", "postmark");
  return {
    view,
    driver,
    read: () => driver.invoke(view.connectionId, "provider.messages.read", {}),
  };
}
function mount(onFlash = vi.fn()) {
  render(
    <MemoryRouter>
      <NativeConnectorPanels
        provider={integrationProvider("postmark")}
        connection={null}
        onFlash={onFlash}
        onChanged={() => {}}
      />
    </MemoryRouter>,
  );
  return onFlash;
}
it("reads actual native outbound records from saved shared form and cold sealed reload", async () => {
  const o = await oracle();
  mount();
  await userEvent.type(screen.getByLabelText("Postmark API key"), apiKey);
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and connect Postmark" }),
  );
  await screen.findByRole("button", { name: "List outbound messages" });
  expect(screen.queryByText("Check Postmark access")).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "List outbound messages" }),
  );
  const section = await screen.findByRole("region", {
    name: "Showing 2 of 194 messages in outbound stream",
  });
  expect(
    within(section)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["<img src=x onerror=alert(1)> — Sent", "Followup — Queued"]);
  expect(section.querySelector("img, a")).toBeNull();
  expect(section.textContent).not.toContain(apiKey);
  expect([...o.fixture.disk.files.values()].join()).not.toContain(apiKey);
  expect(JSON.stringify(readDeviceRows())).not.toContain(apiKey);
  expect(screen.getByLabelText("Postmark API key")).toHaveProperty("value", "");
  await o.fixture.reload();
  await userEvent.click(
    screen.getByRole("button", { name: "List outbound messages" }),
  );
  await waitFor(() => expect(o.requests).toHaveLength(3));
  expect(o.requests.map((request) => request.path)).toEqual([
    "/server",
    "/messages/outbound?count=20&offset=0&messagestream=outbound",
    "/messages/outbound?count=20&offset=0&messagestream=outbound",
  ]);
  expect(
    o.requests.every((request) => request.authorized && request.emptyBody),
  ).toBe(true);
  expect(
    (
      await screen.findByRole("region", {
        name: "Showing 2 of 194 messages in outbound stream",
      })
    ).textContent,
  ).toContain("Followup — Queued");
});
it("returns an actual empty collection as zero resources, not fabricated items", async () => {
  const o = await oracle();
  const s = await saved();
  o.reply({ TotalCount: 0, Messages: [] });
  expect(await s.read()).toEqual({
    label: "Showing 0 of 0 messages in outbound stream",
    items: [],
  });
});
it.each([
  { TotalCount: 1, Messages: [{ ...first, MessageID: 1 }] },
  { TotalCount: 0, Messages: [first] },
  { TotalCount: 2, Messages: [first, first] },
  { TotalCount: 1, Messages: [{ ...first, Subject: "bad\nlabel" }] },
  { TotalCount: 1, Messages: [{ ...first, Subject: "x".repeat(4097) }] },
  { TotalCount: 21, Messages: Array.from({ length: 21 }, () => first) },
  { TotalCount: 1, Messages: [{ ...first, MessageStream: "another" }] },
  { TotalCount: 1, Messages: [{ ...first, Status: "unknown" }] },
  { TotalCount: 1, Messages: [first], ErrorCode: 300, Message: apiKey },
  { TotalCount: 1, Messages: [{ ...first, Subject: apiKey }] },
  {
    TotalCount: 1,
    Messages: [{ ...first, Subject: encodeURIComponent(apiKey) }],
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
      s.driver.invoke(s.view.connectionId, "provider.messages.read", {
        [key]: value,
      }),
    ).rejects.toThrow("does not accept");
  await expect(
    s.driver.invoke(s.view.connectionId, "provider.messages.delete", {}),
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
      `{"TotalCount":1,"Messages":[{"MessageID":"${"x".repeat(256 * 1024)}`,
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
    response.write('{"TotalCount":1,"Messages":[');
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
it("rejects a late outbound result after the saved connection revision changes", async () => {
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
    providerId: "postmark",
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
