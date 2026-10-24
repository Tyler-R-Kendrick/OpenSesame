/** @vitest-environment jsdom */
import { rootCertificates } from "node:tls";
import { runtimeFixture } from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import {
  type TailscaleBrowserNode as BrowserNode,
  type TailscaleNodeSnapshot,
  bindTailscaleBrowserNode,
} from "@opensesame/app-core/lib/tailscale/browser-node-port.js";
import { savedBrowserNodeConfiguration } from "@opensesame/app-core/lib/tailscale/browser-node-store.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TailscaleBrowserNode } from "./TailscaleBrowserNode.js";

let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
const releases: (() => void)[] = [];
beforeEach(async () => {
  fixture = await runtimeFixture();
});
afterEach(async () => {
  cleanup();
  for (const release of releases.splice(0).reverse()) release();
  await fixture.close();
});
function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
function bindNode() {
  const snapshot: TailscaleNodeSnapshot = {
    status: "stopped",
    hostname: "",
    controlURL: "",
    authURL: "",
    addresses: [],
    peerCount: 0,
    failure: "",
  };
  const node: BrowserNode = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    forget: vi.fn(async () => {}),
    login: vi.fn(),
    get: vi.fn(async () => ({ status: 200, text: "" })),
  };
  releases.push(bindTailscaleBrowserNode(node));
  return node;
}
function editPeerRoute() {
  change("Browser node hostname", "typed-browser");
  change("Tailscale control server", "https://control.example.test");
  change("Integration HTTP transport", "native");
  change("Native HTTPS route", "peer");
  change("Approved peer stable ID", "n-typed-peer");
  change(
    "Integration origins and destination CIDRs",
    "https://api.example.test 100.64.0.1/32",
  );
  change("Integration TLS trust", "operator");
  change("Operator CA certificates (PEM)", rootCertificates[0] ?? "");
  change("Optional node auth key", "transient-typed-auth-key");
}
function expectTypedPeerRoute() {
  for (const [label, value] of [
    ["Browser node hostname", "typed-browser"],
    ["Tailscale control server", "https://control.example.test"],
    ["Integration HTTP transport", "native"],
    ["Native HTTPS route", "peer"],
    ["Approved peer stable ID", "n-typed-peer"],
    [
      "Integration origins and destination CIDRs",
      "https://api.example.test 100.64.0.1/32",
    ],
    ["Integration TLS trust", "operator"],
    ["Operator CA certificates (PEM)", rootCertificates[0]],
    ["Optional node auth key", "transient-typed-auth-key"],
  ])
    expect(screen.getByLabelText(label)).toHaveProperty("value", value);
}
async function save() {
  fireEvent.click(
    screen.getByRole("button", { name: "Save browser node configuration" }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Save browser node configuration" }),
    ).toHaveProperty("disabled", false),
  );
}
it("disables all editable public fields until hydration is ready, then allows configuration without starting or requiring a runtime", async () => {
  const view = render(<TailscaleBrowserNode ready={false} online />);
  for (const label of [
    "Browser node hostname",
    "Tailscale control server",
    "Optional node auth key",
  ])
    expect(screen.getByLabelText(label)).toHaveProperty("disabled", true);
  expect(
    screen.getByRole("group", { name: "Integration HTTP connections" }),
  ).toHaveProperty("disabled", true);
  for (const name of [
    "Save browser node configuration",
    "Connect browser node",
  ])
    expect(screen.getByRole("button", { name })).toHaveProperty(
      "disabled",
      true,
    );
  view.rerender(<TailscaleBrowserNode ready online />);
  expect(screen.getByLabelText("Browser node hostname")).toHaveProperty(
    "disabled",
    false,
  );
  expect(
    screen.getByRole("group", { name: "Integration HTTP connections" }),
  ).toHaveProperty("disabled", false);
  expect(
    screen.getByRole("button", { name: "Connect browser node" }),
  ).toHaveProperty("disabled", true);
  editPeerRoute();
  await save();
  expect(savedBrowserNodeConfiguration()).toMatchObject({
    hostname: "typed-browser",
    controlURL: "https://control.example.test",
    nativeHTTP: { version: 2, routeMode: "peer", peerID: "n-typed-peer" },
  });
  expect(screen.getByLabelText("Optional node auth key")).toHaveProperty(
    "value",
    "",
  );
});
it.each(["first registration", "replacement"])(
  "keeps a typed public peer route and transient key across later runtime %s without automatically starting it",
  async (cause) => {
    const original = cause === "replacement" ? bindNode() : null;
    render(<TailscaleBrowserNode ready online />);
    editPeerRoute();
    expectTypedPeerRoute();
    let next: BrowserNode | undefined;
    act(() => {
      next = bindNode();
    });
    expectTypedPeerRoute();
    if (!next) throw new Error("Runtime did not bind");
    expect(next.start).not.toHaveBeenCalled();
    if (original) expect(original.start).not.toHaveBeenCalled();
    expect(savedBrowserNodeConfiguration()).toBeNull();
    await save();
    expect(savedBrowserNodeConfiguration()).toMatchObject({
      hostname: "typed-browser",
      controlURL: "https://control.example.test",
      nativeHTTP: { version: 2, routeMode: "peer", peerID: "n-typed-peer" },
    });
    expect(next.start).not.toHaveBeenCalled();
  },
);
