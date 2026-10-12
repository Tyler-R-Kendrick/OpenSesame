/** @vitest-environment jsdom */
import { listDeviceConnections } from "@opensesame/app-core/lib/device-connectors.js";
import { nativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { ConnectedPanel } from "./ConnectedPanel.js";
import { NeedsAttention } from "./NeedsAttention.js";
import {
  connectorIntegration,
  installConnectorIntegration,
  integrationProvider,
} from "./connect/native-connector-integration.test-support.js";
import { connectedPageItems } from "./page-tree.js";
import { makeConnection } from "./section-fixtures.test-support.js";
import { declareConnectionsTutorial } from "./tutorial.test-support.js";
installConnectorIntegration();
declareConnectionsTutorial();
function draw() {
  const connections = listDeviceConnections();
  render(
    <MemoryRouter>
      <NeedsAttention
        connections={connections}
        providers={[]}
        onFlash={() => {}}
        onChanged={() => {}}
      />
      <ConnectedPanel
        connections={connections}
        providers={[]}
        loading={false}
        setupRequired={false}
      />
    </MemoryRouter>,
  );
  return connections;
}
function connectedPanel() {
  const panel = screen
    .getByRole("heading", { name: "Connected" })
    .closest("section");
  if (!panel) throw new Error("Missing Connected section");
  return within(panel);
}
it("keeps configured MCP out of Connected and its rail until real provider proof exists", async () => {
  const fixture = connectorIntegration();
  const configured = await nativeConnectorDriver("mcp", "adobe").configure({
    providerId: "adobe",
    method: "mcp",
    displayName: "Adobe protocol proof",
    parameters: {},
    credentials: {},
    requestedScopes: { user: [] },
    targetIds: {},
  });
  expect(configured.status).toBe("configuration");
  const rows = draw();
  expect(connectedPanel().queryByText("Adobe protocol proof")).toBeNull();
  expect(screen.getByRole("region", { name: "Needs attention" })).toBeTruthy();
  expect(
    screen.getByText(
      "Configured on this device; provider authorization or verification required",
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/nobody has approved/)).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Finish authorization" }),
  ).toBeNull();
  expect(connectedPageItems([], rows)).toEqual([]);
  expect(fixture.requests).toHaveLength(0);
});
it("lists a real verified API-key connection once and removes it from Connected after authorization failure or capability disposal", async () => {
  const fixture = connectorIntegration();
  fixture.replies.push({ body: { id: "bot-1", name: "Team integration" } });
  const driver = nativeConnectorDriver("api-key", "notion");
  const saved = await driver.configure({
    providerId: "notion",
    method: "api-key",
    displayName: "Verified Notion",
    parameters: {},
    credentials: { api_key: "private-notion-key" },
    requestedScopes: {},
    targetIds: {},
  });
  const verified = draw();
  expect(connectedPanel().getByText("Verified Notion")).toBeTruthy();
  expect(
    connectedPanel().getByText("Connection verified on this device."),
  ).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Needs attention" })).toBeNull();
  expect(
    connectedPageItems([integrationProvider("notion")], verified).map(
      (row) => row.id,
    ),
  ).toEqual([saved.connectionId]);
  cleanup();
  fixture.replies.push({ body: { code: "unauthorized" }, status: 401 });
  await expect(driver.verify(saved.connectionId)).rejects.toThrow();
  const refused = draw();
  expect(connectedPanel().queryByText("Verified Notion")).toBeNull();
  expect(connectedPageItems([], refused)).toEqual([]);
  expect(
    screen.getByText(
      "Provider authorization expired or changed; authorize again",
    ),
  ).toBeTruthy();
  cleanup();
  fixture.activation.dispose();
  const inactive = draw();
  expect(connectedPanel().queryByText("Verified Notion")).toBeNull();
  expect(connectedPageItems([], inactive)).toEqual([]);
  expect(
    screen.getByText("Enable External connectors to verify this connection"),
  ).toBeTruthy();
});
it("keeps legacy and Linear pending listing behavior unchanged", () => {
  const legacy = makeConnection({
    connectionId: "legacy-pending",
    status: "pending",
  });
  const linear = makeConnection({
    connectionId: "linear-pending",
    providerId: "linear",
    status: "pending",
  });
  const revoked = makeConnection({
    connectionId: "revoked",
    status: "revoked",
  });
  expect(
    connectedPageItems([], [legacy, linear, revoked]).map((row) => row.id),
  ).toEqual([legacy.connectionId, linear.connectionId]);
});
