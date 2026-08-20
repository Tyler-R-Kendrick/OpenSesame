import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConnectorStatus } from "../lib/connectors.js";

const env = vi.hoisted(() => ({
  connectors: [] as ConnectorStatus[],
}));

vi.mock("../lib/connectors.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/connectors.js")>();
  return { ...actual, useConnectors: () => env.connectors };
});

vi.mock("../lib/identity.js", () => ({
  probeHost: vi.fn(async () => "reachable"),
  probeIdentity: vi.fn(async () => "unreachable"),
  useConnect: () => ({ connect: vi.fn(), connecting: false, error: null }),
}));

vi.mock("./PlaneNote.js", () => ({
  ConnectThisMachine: () => <div data-testid="pairing-ceremony" />,
}));

import { ConnectivityBar } from "./ConnectivityBar.js";

function status(over: Partial<ConnectorStatus> = {}): ConnectorStatus {
  return {
    id: "host",
    name: "Host",
    tone: "live",
    detail: "127.0.0.1:18787",
    required: true,
    ...over,
  };
}

const ALL: ConnectorStatus[] = [
  status(),
  status({ id: "identity", name: "Identity", detail: "127.0.0.1:18788" }),
  status({
    id: "machine",
    name: "This machine",
    tone: "attn",
    detail: "Not paired",
  }),
  status({
    id: "history",
    name: "Git history",
    detail: "GitHub · owner/store",
  }),
  status({
    id: "keys",
    name: "Key vault",
    detail: "WebCrypto (this device)",
    required: false,
  }),
];

function renderBar(connectors = ALL) {
  env.connectors = connectors;
  return render(
    <MemoryRouter>
      <ConnectivityBar />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe("ConnectivityBar", () => {
  it("renders one glyph per connector, toned by state", () => {
    const { container } = renderBar();
    expect(container.querySelectorAll(".cx__btn").length).toBe(5);
    expect(container.querySelectorAll(".cx__btn--live").length).toBe(4);
    expect(container.querySelectorAll(".cx__btn--attn").length).toBe(1);
  });

  it("carries the whole status in the accessible name, since the glyph has none", () => {
    renderBar();
    expect(
      screen.getByRole("button", { name: "This machine — Not paired" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Host — 127.0.0.1:18787" }),
    ).toBeTruthy();
  });

  it("summarises how many required connectors are asking for something", () => {
    renderBar();
    expect(screen.getByRole("group", { name: /1 needs setup/ })).toBeTruthy();
  });

  it("does not count the optional key vault towards attention", () => {
    renderBar([
      status(),
      status({ id: "keys", name: "Key vault", tone: "attn", required: false }),
    ]);
    expect(screen.getByRole("group", { name: /all connected/i })).toBeTruthy();
  });

  it("opens the pairing ceremony from the machine glyph", () => {
    renderBar();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "This machine — Not paired" }),
    );
    expect(
      screen.getByRole("dialog", { name: "This machine connection" }),
    ).toBeTruthy();
    expect(screen.getByTestId("pairing-ceremony")).toBeTruthy();
  });

  it("closes the ceremony on Escape and on the scrim", () => {
    renderBar();
    const open = () =>
      fireEvent.click(
        screen.getByRole("button", { name: "This machine — Not paired" }),
      );

    open();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    open();
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("re-probes a plane rather than offering to reconfigure it", async () => {
    renderBar();
    fireEvent.click(
      screen.getByRole("button", { name: "Host — 127.0.0.1:18787" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByText("Answered just now.")).toBeTruthy();
    // Endpoints are edited in one place, and it is not here.
    expect(
      screen
        .getByRole("link", { name: /Settings → Connectivity → Endpoints/ })
        .getAttribute("href"),
    ).toBe("/settings#connectivity");
  });

  it("hands capability connectors to the panel that owns them", () => {
    renderBar();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Git history — GitHub · owner/store",
      }),
    );
    expect(
      screen
        .getByRole("link", { name: "Change connector" })
        .getAttribute("href"),
    ).toBe("/settings#connectivity");
  });
});
