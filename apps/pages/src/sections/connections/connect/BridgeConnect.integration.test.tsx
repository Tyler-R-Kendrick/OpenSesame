import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import { resetNativeBridgeForTest } from "@opensesame/app-core/lib/native-bridge.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
/** @vitest-environment jsdom */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { declareConnectionsTutorial } from "../tutorial.test-support.js";
import { NativeConnectorPanels } from "./NativeConnectorPanels.js";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "./native-connector-integration.test-support.js";
import { installWindowBridge } from "./window-bridge.test-support.js";

declareConnectionsTutorial();
installConnectorIntegration();

const relays: { remove: () => void }[] = [];
afterEach(() => {
  for (const relay of relays.splice(0)) relay.remove();
  resetNativeBridgeForTest();
});

function sendgrid() {
  const found = catalogProvider("sendgrid");
  if (!found) throw new Error("Catalog row required: sendgrid");
  return found;
}

const panel = () => (
  <MemoryRouter>
    <NativeConnectorPanels
      provider={sendgrid()}
      connection={null}
      onFlash={vi.fn()}
      onChanged={vi.fn()}
    />
  </MemoryRouter>
);

it("says what to do while a provider that refuses web pages has no bridge, and draws no key field", async () => {
  connectorIntegration();
  render(panel());
  await waitFor(() =>
    expect(screen.getAllByText(/connector bridge/i).length).toBeGreaterThan(0),
  );
  expect(screen.queryByLabelText(/api key/i)).toBeNull();
  expect(
    screen.getAllByRole("link", { name: /connector bridge/i })[0],
  ).toBeTruthy();
});

it("connects a provider that refuses web pages once the bridge is there and holds its host, sending the key through the bridge and nowhere else", async () => {
  const fixture = connectorIntegration();
  const relay = installWindowBridge({
    granted: ["api.sendgrid.com"],
    onFetch: (request) =>
      request.headers.some(
        ([name, value]) =>
          name === "authorization" && value === "Bearer SG.good-key-0123456789",
      )
        ? {
            status: 200,
            headers: [["content-type", "application/json"]],
            body: '{"scopes":["mail.send"]}',
          }
        : {
            status: 401,
            headers: [["content-type", "application/json"]],
            body: '{"errors":[{"message":"nope"}]}',
          },
  });
  relays.push(relay);
  render(panel());
  // The page finds the bridge when its window is looked at again.
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  const key = await screen.findByLabelText("SendGrid API key");
  await userEvent.type(key, "SG.good-key-0123456789");
  await userEvent.click(
    screen.getByRole("button", { name: /verify and connect/i }),
  );
  await waitFor(() => expect(readDeviceRows()).toHaveLength(1));
  const row = readDeviceRows()[0];
  if (!row) throw new Error("Verified connection required");
  expect(readNativeConnector(row.connectionId)).toMatchObject({
    status: "connected",
    providerId: "sendgrid",
  });
  const fetched = relay.heard.flatMap((request) =>
    request.op === "fetch" ? [request.request] : [],
  );
  expect(fetched).toHaveLength(1);
  expect(fetched[0]).toMatchObject({
    providerId: "sendgrid",
    url: "https://api.sendgrid.com/v3/scopes",
    method: "GET",
  });
  // The page made no request of its own to the provider.
  expect(fixture.requests).toEqual([]);
});

it("offers the host to the bridge's popup when the bridge is there without it", async () => {
  connectorIntegration();
  const relay = installWindowBridge({ granted: [] });
  relays.push(relay);
  render(panel());
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  await waitFor(() =>
    expect(
      relay.heard.some(
        (request) =>
          request.op === "need" && request.hosts.includes("api.sendgrid.com"),
      ),
    ).toBe(true),
  );
  expect(
    screen.getAllByText(/allow api\.sendgrid\.com/i).length,
  ).toBeGreaterThan(0);
  expect(screen.queryByLabelText(/api key/i)).toBeNull();
});

it("connects a machine identity through the bridge: no key form without it, then a login that is the proof", async () => {
  const fixture = connectorIntegration();
  const infisical = catalogProvider("infisical");
  if (!infisical) throw new Error("Catalog row required: infisical");
  const panelFor = () => (
    <MemoryRouter>
      <NativeConnectorPanels
        provider={infisical}
        connection={null}
        onFlash={vi.fn()}
        onChanged={vi.fn()}
      />
    </MemoryRouter>
  );
  const relay = installWindowBridge({
    granted: ["app.infisical.com"],
    onFetch: (request) =>
      request.url.endsWith("/api/v1/auth/universal-auth/login")
        ? {
            status: 200,
            headers: [["content-type", "application/json"]],
            body: '{"accessToken":"eyJhbGciOiJIUzI1NiJ9.test-access-token-0123456789"}',
          }
        : { error: "network" },
  });
  relays.push(relay);
  render(panelFor());
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  await userEvent.type(
    await screen.findByLabelText("Client ID"),
    "11111111-2222-4333-8444-555555555555",
  );
  await userEvent.type(
    screen.getByLabelText("Client secret"),
    "universal-auth-secret-0123456789",
  );
  await userEvent.click(
    screen.getByRole("button", { name: /verify and connect/i }),
  );
  await waitFor(() => expect(readDeviceRows()).toHaveLength(1));
  expect(
    relay.heard.flatMap((request) =>
      request.op === "fetch" ? [request.request.url] : [],
    ),
  ).toEqual(["https://app.infisical.com/api/v1/auth/universal-auth/login"]);
  expect(fixture.requests).toEqual([]);
});
