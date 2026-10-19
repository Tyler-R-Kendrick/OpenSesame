/** @vitest-environment jsdom */
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { configureNativeApiConnector } from "@opensesame/app-core/lib/native-api-connectors.js";
import { bindNativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-binding.js";
import { nativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import { tlsFetch } from "@opensesame/app-core/lib/test/native-s3-backup-fixtures.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { BoundaryValue } from "@opensesame/os-domain";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
function mount(onFlash = vi.fn(), onChanged = vi.fn()) {
  const view = render(
    <MemoryRouter>
      <NativeConnectorPanels
        provider={integrationProvider("postmark")}
        connection={null}
        onFlash={onFlash}
        onChanged={onChanged}
      />
    </MemoryRouter>,
  );
  return { ...view, onFlash, onChanged };
}
it.each([false, true])(
  "caller-owned API resource physically drains before15s, generic binder=%s",
  async (bound) => {
    const o = await oracle();
    const s = await saved();
    mount();
    const driver = bound
      ? bindNativeConnectorDriver(s.driver, { assertCurrent() {} })
      : s.driver;
    const caller = new AbortController();
    const arrived = deferred();
    const state = { closed: false };
    o.hold((response) => {
      response.once("close", () => {
        state.closed = true;
      });
      response.write('{"TotalCount":1,"Messages":[');
      arrived.resolve();
    });
    const pending = driver.invoke(
      s.view.connectionId,
      "provider.messages.read",
      {},
      caller.signal,
    );
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await arrived.promise;
    await delay(250);
    expect(state.closed).toBe(false);
    const started = performance.now();
    caller.abort();
    await waitFor(() => expect(state.closed).toBe(true), {
      timeout: 2000,
      interval: 10,
    });
    await rejected;
    expect(performance.now() - started).toBeLessThan(2000);
    expect(o.requests).toHaveLength(2);
  },
);
it("an already ended caller sends no resource request", async () => {
  const o = await oracle();
  const s = await saved();
  const caller = new AbortController();
  caller.abort();
  await expect(
    s.driver.invoke(
      s.view.connectionId,
      "provider.messages.read",
      {},
      caller.signal,
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(o.requests).toHaveLength(1);
});
it("generic binder preserves legacy invocation arity when caller is omitted", async () => {
  await oracle();
  const s = await saved();
  const invoke = vi.spyOn(s.driver, "invoke");
  const bound = bindNativeConnectorDriver(s.driver, { assertCurrent() {} });
  expect(
    await bound.invoke(s.view.connectionId, "provider.messages.read", {}),
  ).toMatchObject({ label: "Showing 2 of 194 messages in outbound stream" });
  expect(invoke).toHaveBeenCalledWith(
    s.view.connectionId,
    "provider.messages.read",
    {},
  );
});

it.each(["unmount", "provider", "vault", "activation"])(
  "actual mounted saved action drains within2s on %s, before unchanged15s deadline",
  async (withdrawal) => {
    const o = await oracle();
    const ui = mount();
    await userEvent.type(screen.getByLabelText("Postmark API key"), apiKey);
    await userEvent.click(
      screen.getByRole("button", { name: "Verify and connect Postmark" }),
    );
    const action = await screen.findByRole("button", {
      name: "List outbound messages",
    });
    ui.onFlash.mockClear();
    ui.onChanged.mockClear();
    const arrived = deferred();
    const state = { closed: false };
    o.hold((response) => {
      response.once("close", () => {
        state.closed = true;
      });
      response.write('{"TotalCount":1,"Messages":[');
      arrived.resolve();
    });
    await userEvent.click(action);
    await arrived.promise;
    await delay(250);
    expect(state.closed).toBe(false);
    expect(action.getAttribute("aria-busy")).toBe("true");
    const started = performance.now();
    await act(async () => {
      if (withdrawal === "unmount") ui.unmount();
      if (withdrawal === "provider")
        ui.rerender(
          <MemoryRouter>
            <NativeConnectorPanels
              provider={integrationProvider("algolia")}
              connection={null}
              onFlash={ui.onFlash}
              onChanged={ui.onChanged}
            />
          </MemoryRouter>,
        );
      if (withdrawal === "vault") vaultStore.lock({ recordLastVault: false });
      if (withdrawal === "activation") o.fixture.activation.dispose();
    });
    await waitFor(() => expect(state.closed).toBe(true), {
      timeout: 2000,
      interval: 10,
    });
    expect(performance.now() - started).toBeLessThan(2000);
    await delay(25);
    expect(ui.onFlash).not.toHaveBeenCalled();
    expect(ui.onChanged).not.toHaveBeenCalled();
    expect(
      screen.queryByText("Showing 2 of 194 messages in outbound stream"),
    ).toBeNull();
    expect(o.requests).toHaveLength(2);
    expect(
      o.requests.every((request) => request.authorized && request.emptyBody),
    ).toBe(true);
    cleanup();
  },
);

it.each([401, 500])(
  "actual mounted provider HTTP%s remains an error with a current action owner",
  async (status) => {
    const o = await oracle();
    const ui = mount();
    await userEvent.type(screen.getByLabelText("Postmark API key"), apiKey);
    await userEvent.click(
      screen.getByRole("button", { name: "Verify and connect Postmark" }),
    );
    const action = await screen.findByRole("button", {
      name: "List outbound messages",
    });
    ui.onFlash.mockClear();
    ui.onChanged.mockClear();
    o.reply({ error: apiKey }, status);
    await userEvent.click(action);
    await waitFor(() => expect(ui.onFlash).toHaveBeenCalledOnce());
    expect(ui.onFlash).toHaveBeenCalledWith({
      tone: "err",
      text:
        status === 401
          ? "Provider authorization was refused; verify or replace the saved credential"
          : "Provider did not return the expected response",
    });
    expect(ui.onChanged).toHaveBeenCalledOnce();
    expect(
      screen.queryByText("Showing 2 of 194 messages in outbound stream"),
    ).toBeNull();
    expect(ui.container.textContent).not.toContain(apiKey);
  },
);
