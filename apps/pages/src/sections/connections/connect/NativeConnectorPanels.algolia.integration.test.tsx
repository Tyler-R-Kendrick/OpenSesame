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
import {
  nativeApiFingerprint,
  nativeApiTarget,
} from "@opensesame/app-core/lib/native-api-target.js";
import { nativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
  updateNativeConnector,
} from "@opensesame/app-core/lib/native-connector-store.js";
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
const apiKey = "algolia_private:resource~key";
const applicationId = "RESOURCE123";
const first = {
  name: "<img src=x onerror=alert(1)>",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-17T00:00:00Z",
  entries: 100,
  dataSize: 1000,
  fileSize: 2000,
  lastBuildTimeS: 3,
  numberOfPendingTasks: 0,
  pendingTask: false,
  replicas: [apiKey],
};
const second = { ...first, name: "products_public", replicas: [] };
const body = { nbPages: 19, items: [first, second] };
const draft = {
  providerId: "algolia",
  displayName: "Search indices",
  parameters: { application_id: applicationId },
  credentials: { api_key: apiKey },
};
const closed: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closed.splice(0)) await close();
});
function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "algolia-resource-"));
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
      request.headers["x-algolia-api-key"] === apiKey &&
      request.headers["x-algolia-application-id"] === applicationId &&
      request.headers.authorization === undefined &&
      request.headers.cookie === undefined &&
      request.url === "/1/indexes?page=0&hitsPerPage=20";
    const emptyBody = Buffer.concat(chunks).length === 0;
    requests.push({ path: request.url ?? "", authorized, emptyBody });
    response.setHeader("content-type", "application/json");
    if (!authorized || !emptyBody) {
      response.writeHead(403);
      response.end("{}");
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
    if (url.origin !== "https://resource123-dsn.algolia.net")
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
  const driver = nativeConnectorDriver("api-key", "algolia");
  return {
    view,
    driver,
    read: () => driver.invoke(view.connectionId, "provider.indices.read", {}),
  };
}
function mount(onFlash = vi.fn()) {
  render(
    <MemoryRouter>
      <NativeConnectorPanels
        provider={integrationProvider("algolia")}
        connection={null}
        onFlash={onFlash}
        onChanged={() => {}}
      />
    </MemoryRouter>,
  );
  return onFlash;
}
it("reads actual first-page indices with both saved headers through common UI and cold sealed reload", async () => {
  const o = await oracle();
  await testNativeApiCredential(draft);
  mount();
  expect(document.body.textContent).toContain("re-enter its API key");
  await userEvent.type(screen.getByLabelText("Application ID"), applicationId);
  await userEvent.type(screen.getByLabelText("Algolia API key"), apiKey);
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and connect Algolia" }),
  );
  await screen.findByRole("button", { name: "List indices" });
  expect(screen.queryByText("Check Algolia access")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "List indices" }));
  const section = await screen.findByRole("region", {
    name: "Showing 2 indices from first page",
  });
  expect(
    within(section)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["<img src=x onerror=alert(1)>", "products_public"]);
  expect(section.querySelector("img, a")).toBeNull();
  expect(section.textContent).not.toContain(apiKey);
  expect([...o.fixture.disk.files.values()].join()).not.toContain(apiKey);
  expect(JSON.stringify(readDeviceRows())).not.toContain(apiKey);
  expect(screen.getByLabelText("Algolia API key")).toHaveProperty("value", "");
  await o.fixture.reload();
  await userEvent.click(screen.getByRole("button", { name: "List indices" }));
  await waitFor(() => expect(o.requests).toHaveLength(4));
  expect(o.requests.map((request) => request.path)).toEqual(
    Array(4).fill("/1/indexes?page=0&hitsPerPage=20"),
  );
  expect(
    o.requests.every((request) => request.authorized && request.emptyBody),
  ).toBe(true);
  await screen.findByText("products_public", { selector: "li" });
});
it("returns an actual empty collection as zero resources, not fabricated items", async () => {
  const o = await oracle();
  const s = await saved();
  o.reply({ nbPages: 0, items: [] });
  expect(await s.read()).toEqual({
    label: "Showing 0 indices from first page",
    items: [],
  });
  o.reply({ items: [second] });
  expect(await s.read()).toEqual({
    label: "Showing 1 index from first page",
    items: [{ id: "products_public", label: "products_public" }],
  });
});
it.each([
  { nbPages: 1, items: [{ name: 1 }] },
  { nbPages: 1, items: [{ name: "" }] },
  { nbPages: 0, items: [first] },
  { nbPages: 1, items: [first, first] },
  { nbPages: 1, items: [{ name: "bad\nlabel" }] },
  { nbPages: 1, items: [{ name: "x".repeat(4097) }] },
  {
    nbPages: 1,
    items: Array.from({ length: 21 }, (_, index) => ({ name: String(index) })),
  },
  { nbPages: -1, items: [first] },
  { nbPages: 1.5, items: [first] },
  { nbPages: Number.MAX_SAFE_INTEGER + 1, items: [first] },
  { nbPages: 1, items: [first], status: 403, message: apiKey },
  { nbPages: 1, items: [{ name: apiKey }] },
  { nbPages: 1, items: [{ name: encodeURIComponent(apiKey) }] },
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
    ["application_id", "OTHERAPP"],
  ] as const;
  const read = (input: Parameters<typeof s.driver.invoke>[2]) =>
    s.driver.invoke(s.view.connectionId, "provider.indices.read", input);
  for (const [key, value] of invalidInputs)
    await expect(read({ [key]: value })).rejects.toThrow("does not accept");
  await expect(
    s.driver.invoke(s.view.connectionId, "provider.indices.delete", {}),
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
    response.write(`{"items":[{"name":"${"x".repeat(256 * 1024)}`);
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
    response.write('{"items":[');
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
it("rejects a late index result after the saved connection revision changes", async () => {
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
it("keeps legacy credentials sealed until explicit bounded retest of the same connection succeeds", async () => {
  const o = await oracle();
  const s = await saved();
  const target = nativeApiTarget("algolia", draft.parameters);
  const verify = target.profile.verify;
  if (!verify) throw new Error("Missing verification fixture");
  const oldVerify = { ...verify, url: verify.url.split("?")[0] };
  const fingerprint = await nativeApiFingerprint({
    ...target,
    profile: { ...target.profile, verify: oldVerify },
  });
  const legacy = await updateNativeConnector(
    s.view.connectionId,
    {
      revision: s.view.revision,
      fingerprint: s.view.fingerprint,
    },
    target.classification,
    (record) => {
      const proof = record.privateState.verification;
      const grant = record.privateState.grants.app;
      if (!proof || !grant) throw new Error("Missing legacy authority fixture");
      record.configuration.fingerprint = fingerprint;
      proof.fingerprint = fingerprint;
      grant.fingerprint = fingerprint;
      return record;
    },
  );
  const id = legacy.connectionId;
  const original = loadNativeConnectorRecord(id);
  expect(original?.privateState.credentials.api_key).toBe(apiKey);
  await expect(s.read()).rejects.toThrow("Provider contract changed");
  await expect(s.driver.verify(id)).rejects.toThrow(
    "Provider contract changed",
  );
  const retry = { ...draft, connectionId: id, revision: legacy.revision };
  await expect(
    configureNativeApiConnector({ ...retry, credentials: {} }),
  ).rejects.toThrow("required provider credentials");
  expect(loadNativeConnectorRecord(id)).toEqual(original);
  expect(o.requests).toHaveLength(1);
  const reverified = await configureNativeApiConnector(retry);
  expect(reverified.connectionId).toBe(id);
  expect(reverified.fingerprint).toBe(await nativeApiFingerprint(target));
  expect(reverified.fingerprint).not.toBe(fingerprint);
  await o.fixture.reload();
  const names = (await s.read()).items.map((item) => item.id);
  expect(names).toEqual([first.name, second.name]);
  expect(o.requests).toHaveLength(3);
});
