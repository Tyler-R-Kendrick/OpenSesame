/** @vitest-environment jsdom */
import { registerLegacyShellData } from "@opensesame/app-core/lib/contributions.test-support.js";
import { subscribeDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import { kvFileName } from "@opensesame/app-core/lib/kv.js";
import { nativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "../sections/connections/connect/native-connector-integration.test-support.js";
import { Crumbs } from "./Crumbs.js";

installConnectorIntegration();
let releaseShell = () => {};
beforeAll(() => {
  releaseShell = registerLegacyShellData();
});
afterAll(() => releaseShell());

function RouteAddress() {
  return <output aria-label="Route address">{useLocation().pathname}</output>;
}

function draw(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Crumbs />
      <RouteAddress />
    </MemoryRouter>,
  );
}

const input = {
  providerId: "adobe",
  method: "mcp" as const,
  displayName: "Adobe protocol proof",
  parameters: {},
  credentials: {},
  requestedScopes: { user: [] },
  targetIds: {},
};

it("uses the actual saved MCP name after encrypted reload while retaining its provider crumb and ID route", async () => {
  const fixture = connectorIntegration();
  const saved = await nativeConnectorDriver("mcp", "adobe").configure(input);
  await fixture.reload();
  const path = `/connections/adobe/${saved.connectionId}`;
  draw(path);
  const trail = screen.getByRole("navigation", { name: "Breadcrumb" });
  expect(trail.querySelector('[aria-current="page"]')?.textContent).toBe(
    "Adobe protocol proof",
  );
  expect(trail.textContent).not.toContain(saved.connectionId);
  expect(screen.getByRole("link", { name: "adobe" }).getAttribute("href")).toBe(
    "/connections/adobe",
  );
  expect(screen.getByLabelText("Route address").textContent).toBe(path);
  expect(fixture.requests).toHaveLength(0);
});

it("updates a mounted record heading only after a committed rename and retains it when a durable write fails", async () => {
  const fixture = connectorIntegration();
  const driver = nativeConnectorDriver("mcp", "adobe");
  const saved = await driver.configure(input);
  const path = `/connections/adobe/${saved.connectionId}`;
  draw(path);
  await act(async () => {
    await driver.configure({
      ...input,
      displayName: "Adobe production tools",
      connectionId: saved.connectionId,
      revision: saved.revision,
    });
  });
  expect(screen.getByText("Adobe production tools")).toBeTruthy();
  const publicChanges = vi.fn();
  const unsubscribe = subscribeDeviceRows(publicChanges);
  const original = fixture.disk.getFileHandle.bind(fixture.disk);
  const brokenDisk = vi
    .spyOn(fixture.disk, "getFileHandle")
    .mockImplementation(async (name, options) => {
      if (
        options?.create &&
        name === kvFileName("opensesame.self-hosted-connectors.v1")
      )
        throw new Error("Device storage write failed");
      return original(name, options);
    });
  await act(async () => {
    await expect(
      driver.configure({
        ...input,
        displayName: "Unsaved name",
        connectionId: saved.connectionId,
        revision: saved.revision + 1,
      }),
    ).rejects.toThrow("Device storage write failed");
  });
  expect(publicChanges).not.toHaveBeenCalled();
  unsubscribe();
  brokenDisk.mockRestore();
  expect(screen.queryByText("Unsaved name")).toBeNull();
  expect(screen.getByText("Adobe production tools")).toBeTruthy();
  expect(screen.getByLabelText("Route address").textContent).toBe(path);
  cleanup();
  await fixture.reload();
  draw(path);
  expect(screen.getByText("Adobe production tools")).toBeTruthy();
});

it("uses the saved name on Settings connector routes and cannot borrow another provider's record label", async () => {
  connectorIntegration();
  const saved = await nativeConnectorDriver("mcp", "adobe").configure(input);
  draw(`/settings/connections/adobe/${saved.connectionId}`);
  expect(screen.getByText("Adobe protocol proof")).toBeTruthy();
  expect(screen.getByRole("link", { name: "adobe" }).getAttribute("href")).toBe(
    "/settings/connections/adobe",
  );
  cleanup();
  draw(`/connections/notion/${saved.connectionId}`);
  expect(screen.queryByText("Adobe protocol proof")).toBeNull();
  const trail = screen.getByRole("navigation", { name: "Breadcrumb" });
  expect(trail.querySelector('[aria-current="page"]')?.textContent).toBe(
    "Connection",
  );
  expect(trail.textContent).not.toContain(saved.connectionId);
});
