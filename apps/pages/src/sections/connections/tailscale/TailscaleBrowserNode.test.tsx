/** @vitest-environment jsdom */
import {
  dismissNotice,
  listNotices,
} from "@opensesame/app-core/lib/notices.js";
import {
  type TailscaleNodeSnapshot,
  bindTailscaleBrowserNode,
} from "@opensesame/app-core/lib/tailscale/browser-node-port.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TailscaleBrowserNode } from "./TailscaleBrowserNode.js";
let release = () => {};
afterEach(() => {
  cleanup();
  release();
  dismissNotice("tailscale-browser-node");
  vi.restoreAllMocks();
});
it("composes shared fields, keeps auth keys concealed and clears the transient key after starting the actual runtime port", async () => {
  let snapshot: TailscaleNodeSnapshot = {
    status: "stopped",
    hostname: "",
    controlURL: "",
    authURL: "",
    addresses: [],
    peerCount: 0,
    failure: "",
  };
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<TailscaleNodeSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };
  const start = vi.fn(async () => {
    publish({ status: "starting" });
  });
  const stop = vi.fn(() =>
    publish({ status: "stopped", addresses: [], authURL: "" }),
  );
  const get = vi.fn(async () => ({
    status: 200,
    text: "service-response-is-not-rendered",
  }));
  release = bindTailscaleBrowserNode({
    snapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start,
    stop,
    get,
    login: vi.fn(),
    forget: vi.fn(async () => {}),
  });
  render(<TailscaleBrowserNode ready online />);
  fireEvent.change(screen.getByLabelText("Browser node hostname"), {
    target: { value: "operator-browser" },
  });
  fireEvent.change(screen.getByLabelText("Optional node auth key"), {
    target: { value: "fixture-transient-auth-key" },
  });
  expect(
    screen.getByLabelText("Optional node auth key").getAttribute("type"),
  ).toBe("password");
  fireEvent.click(screen.getByRole("button", { name: "Connect browser node" }));
  await waitFor(() =>
    expect(start).toHaveBeenCalledWith({
      hostname: "operator-browser",
      controlURL: "https://controlplane.tailscale.com",
      authKey: "fixture-transient-auth-key",
    }),
  );
  await waitFor(() =>
    expect(
      screen.getByLabelText("Optional node auth key").getAttribute("value"),
    ).toBe(""),
  );
  act(() =>
    publish({ status: "connected", addresses: ["100.64.0.2"], peerCount: 1 }),
  );
  expect(
    screen.getByRole("img", { name: "Connected: 100.64.0.2 · 1 peers" }),
  ).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Tailnet service URL"), {
    target: { value: "http://100.64.0.1:8080/proof" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Test tailnet service" }));
  await waitFor(() =>
    expect(get).toHaveBeenCalledWith("http://100.64.0.1:8080/proof"),
  );
  expect(document.body.textContent).not.toContain(
    "service-response-is-not-rendered",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Disconnect browser node" }),
  );
  expect(stop).toHaveBeenCalled();
});
it("keeps configuration visible and routes Networking enablement to Features when its runtime is absent", () => {
  render(<TailscaleBrowserNode ready online />);
  expect(screen.getByLabelText("Tailscale control server")).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: "Connect browser node" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(
    screen.getByRole("img", {
      name: "Enable Networking in Features to connect this browser node.",
    }),
  ).toBeTruthy();
});

it("publishes SDK failures to the shared notification tray with a consistent row status", async () => {
  const snapshot: TailscaleNodeSnapshot = {
    status: "error",
    hostname: "operator",
    controlURL: "https://controlplane.tailscale.com",
    authURL: "",
    addresses: [],
    peerCount: 0,
    failure: "The browser node is unavailable. Reconnect.",
  };
  release = bindTailscaleBrowserNode({
    snapshot: () => snapshot,
    subscribe: () => () => {},
    start: async () => {},
    stop: () => {},
    login: () => {},
    get: async () => ({ status: 200, text: "" }),
    forget: async () => {},
  });
  render(<TailscaleBrowserNode ready online />);
  await waitFor(() =>
    expect(
      listNotices().find((notice) => notice.id === "tailscale-browser-node"),
    ).toMatchObject({ title: "Tailscale", body: snapshot.failure }),
  );
  expect(screen.getByRole("img", { name: snapshot.failure })).toBeTruthy();
});
