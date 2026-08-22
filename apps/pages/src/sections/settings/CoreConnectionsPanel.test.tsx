import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConnectorStatus } from "../../lib/connectors.js";

type CoreConnectionsTestEnvironment = { connectors: ConnectorStatus[] };
const env: CoreConnectionsTestEnvironment = { connectors: [] };

import {
  CoreConnectionsPanel,
  coreConnectionsDependencies,
} from "./CoreConnectionsPanel.js";

Object.assign(coreConnectionsDependencies, {
  useConnectors: () => env.connectors,
  connectorGlyph: () => <svg data-testid="glyph" />,
  ConnectionCeremony: ({ id }: { id: string }) => (
    <div data-testid="ceremony">{id}</div>
  ),
});

function status(over: Partial<ConnectorStatus> = {}): ConnectorStatus {
  return {
    id: "host",
    name: "Host",
    tone: "live",
    detail: "127.0.0.1:18787",
    required: true,
    failure: null,
    lastCheckedAt: null,
    checking: false,
    ...over,
  };
}

function renderPanel(connectors: ConnectorStatus[]) {
  env.connectors = connectors;
  return render(
    <MemoryRouter>
      <CoreConnectionsPanel />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe("CoreConnectionsPanel", () => {
  it("states each connection instead of asking for it", () => {
    const { container } = renderPanel([
      status(),
      status({
        id: "machine",
        name: "This machine",
        tone: "attn",
        detail: "Not paired",
      }),
    ]);
    expect(container.querySelectorAll(".conn").length).toBe(2);
    expect(screen.getByText("127.0.0.1:18787")).toBeTruthy();
    expect(screen.getByText("Not paired")).toBeTruthy();
    // Nothing here is a text input any more.
    expect(container.querySelector("input")).toBeNull();
  });

  it("labels what each tile will do when opened", () => {
    renderPanel([
      status(),
      status({ id: "machine", tone: "attn", name: "This machine" }),
      status({ id: "keys", tone: "off", name: "Key vault", required: false }),
    ]);
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("Fix")).toBeTruthy();
    expect(screen.getByText("Set up")).toBeTruthy();
  });

  it("marks the built-in key vault as such, not as required", () => {
    renderPanel([status({ id: "keys", name: "Key vault", required: false })]);
    expect(screen.getByText("Built in")).toBeTruthy();
    expect(screen.queryByText("Required")).toBeNull();
  });

  it("marks git history as optional, not as a missing required connector", () => {
    renderPanel([
      status({
        id: "history",
        name: "Git history",
        required: false,
        tone: "off",
        detail: "Not connected",
      }),
    ]);
    expect(screen.getByText("Optional")).toBeTruthy();
    expect(screen.queryByText("Required")).toBeNull();
    expect(screen.getByText("All connected")).toBeTruthy();
  });

  it("summarises attention in the panel head", () => {
    renderPanel([
      status(),
      status({ id: "machine", name: "This machine", tone: "attn" }),
      status({ id: "history", name: "Git history", tone: "off" }),
    ]);
    expect(screen.getByText("2 need setup")).toBeTruthy();
  });

  it("says so plainly when nothing needs doing", () => {
    renderPanel([status()]);
    expect(screen.getByText("All connected")).toBeTruthy();
  });

  it("opens the same ceremony the connectivity bar opens", () => {
    renderPanel([
      status(),
      status({ id: "machine", name: "This machine", tone: "attn" }),
    ]);
    expect(screen.queryByTestId("ceremony")).toBeNull();
    fireEvent.click(screen.getByText("This machine"));
    expect(screen.getByTestId("ceremony").textContent).toBe("machine");
  });
});
