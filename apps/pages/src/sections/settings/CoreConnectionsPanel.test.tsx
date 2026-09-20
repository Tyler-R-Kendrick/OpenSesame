import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";

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
    id: "identity",
    name: "Identity",
    tone: "live",
    detail: "This device",
    rttMs: 12,
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
        id: "keys",
        name: "Key vault",
        tone: "live",
        detail: "WebCrypto (this device)",
      }),
    ]);
    expect(container.querySelectorAll(".conn-tile").length).toBe(2);
    expect(screen.getByRole("img", { name: "This device" })).toBeTruthy();
    expect(
      screen.getByRole("img", { name: "WebCrypto (this device)" }),
    ).toBeTruthy();
    expect(container.querySelector("input")).toBeNull();
  });

  it("marks tone without painting a verb", () => {
    renderPanel([
      status(),
      status({
        id: "keys",
        tone: "off",
        name: "Key vault",
        detail: "Not set up",
      }),
    ]);
    expect(screen.getByRole("button", { name: "Identity" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Not set up" })).toBeTruthy();
    expect(screen.queryByText("Connected")).toBeNull();
    expect(screen.queryByText("Set up")).toBeNull();
  });

  it("does not paint a built-in chip", () => {
    renderPanel([status({ id: "keys", name: "Key vault" })]);
    expect(screen.queryByText("Built in")).toBeNull();
    expect(screen.getByRole("img", { name: "This device" })).toBeTruthy();
  });

  it("summarises attention in the panel head", () => {
    renderPanel([status({ tone: "attn" })]);
    expect(screen.getByRole("img", { name: "1 needs attention" })).toBeTruthy();
  });

  it("says so plainly when nothing needs doing", () => {
    renderPanel([status()]);
    expect(screen.getByRole("img", { name: "All connected" })).toBeTruthy();
  });

  it("opens the same ceremony the connectivity bar opens", () => {
    renderPanel([
      status(),
      status({ id: "keys", name: "Key vault", tone: "attn" }),
    ]);
    expect(screen.queryByTestId("ceremony")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Key vault" }));
    expect(screen.getByTestId("ceremony").textContent).toBe("keys");
  });
});
