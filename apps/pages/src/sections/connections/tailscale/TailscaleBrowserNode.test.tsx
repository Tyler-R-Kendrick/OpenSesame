/** @vitest-environment jsdom */
import {
  dismissNotice,
  listNotices,
} from "@opensesame/app-core/lib/notices.js";
import { deferred } from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import {
  type TailscaleBrowserNode as BrowserNodePort,
  type TailscaleNodeSnapshot,
  bindTailscaleBrowserNode,
} from "@opensesame/app-core/lib/tailscale/browser-node-port.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { statusFixture } from "../../../modules/networking.tailnet/browser/authorization.test-support.js";
import { TailscaleBrowserNode } from "./TailscaleBrowserNode.js";
let release = () => {};
const actual: Awaited<ReturnType<typeof statusFixture>>[] = [];
afterEach(async () => {
  cleanup();
  release();
  dismissNotice("tailscale-browser-node");
  vi.restoreAllMocks();
  for (const fixture of actual.splice(0).reverse()) await fixture.close();
});
function controlledNode(status: "stopped" | "connected" = "stopped") {
  let snapshot: TailscaleNodeSnapshot = {
    status,
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
  const get = vi.fn<BrowserNodePort["get"]>(async () => ({
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
  return { get, publish, start, stop };
}
it("composes shared fields, keeps auth keys concealed and clears the transient key after starting the actual runtime port", async () => {
  const { get, publish, start, stop } = controlledNode();
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

function testService() {
  fireEvent.click(screen.getByRole("button", { name: "Test tailnet service" }));
}
function drawProbe() {
  const view = render(<TailscaleBrowserNode ready online />);
  fireEvent.change(screen.getByLabelText("Tailnet service URL"), {
    target: { value: "http://100.64.0.1/service" },
  });
  return view;
}
function noProbe() {
  expect(screen.queryByRole("img", { name: /^HTTP / })).toBeNull();
  expect(
    listNotices().some((notice) => notice.id === "tailscale-browser-node"),
  ).toBe(false);
}
it.each([200, 204, 299, 300, 401, 404, 500])(
  "reports HTTP %s as service health without exposing the body or changing node membership",
  async (status) => {
    const fixture = controlledNode("connected");
    fixture.get.mockResolvedValueOnce({
      status,
      text: "private-service-response",
    });
    drawProbe();
    testService();
    if (status < 300)
      await screen.findByRole("img", { name: new RegExp(`^HTTP ${status} `) });
    else {
      const failed = await screen.findByRole("img", {
        name: `Tailnet service returned HTTP ${status}.`,
      });
      for (const control of [
        screen.getByRole("button", { name: "Connect browser node" }),
        screen.getByLabelText("Tailnet service URL"),
        screen.getByRole("button", { name: "Test tailnet service" }),
      ])
        expect(
          control.compareDocumentPosition(failed) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      expect(
        listNotices().find((notice) => notice.id === "tailscale-browser-node")
          ?.body,
      ).toBe(`Tailnet service returned HTTP ${status}.`);
      expect(screen.queryByRole("img", { name: /^HTTP / })).toBeNull();
    }
    expect(document.body.textContent).not.toContain("private-service-response");
    expect(
      screen.getByRole("button", { name: "Disconnect browser node" }),
    ).toBeTruthy();
    expect(fixture.stop).not.toHaveBeenCalled();
  },
);
it("clears the previous service failure before retry and removes it after success", async () => {
  const fixture = controlledNode("connected");
  fixture.get.mockResolvedValueOnce({ status: 500, text: "hidden" });
  drawProbe();
  testService();
  await screen.findByRole("img", {
    name: "Tailnet service returned HTTP 500.",
  });
  const pending = deferred<{ status: number; text: string }>();
  fixture.get.mockReturnValueOnce(pending.promise);
  testService();
  noProbe();
  await act(async () => {
    pending.resolve({ status: 204, text: "" });
  });
  expect(screen.getByRole("img", { name: /^HTTP 204 / })).toBeTruthy();
  expect(
    listNotices().some((notice) => notice.id === "tailscale-browser-node"),
  ).toBe(false);
});
it("clears a previous successful result when the service URL changes", async () => {
  controlledNode("connected");
  drawProbe();
  testService();
  await screen.findByRole("img", { name: /^HTTP 200 / });
  fireEvent.change(screen.getByLabelText("Tailnet service URL"), {
    target: { value: "http://100.64.0.2/new-service" },
  });
  noProbe();
});
it.each(
  ["URL", "retry", "stop-reconnect", "replacement", "unmount"].flatMap(
    (cause) => ["success", "failure"].map((outcome) => ({ cause, outcome })),
  ),
)("ignores a stale $outcome after $cause", async ({ cause, outcome }) => {
  const fixture = controlledNode("connected");
  let fail = (_error: Error) => {};
  const success = deferred<{ status: number; text: string }>();
  const failure = new Promise<never>((_resolve, reject) => {
    fail = reject;
  });
  fixture.get.mockReturnValueOnce(Promise.race([success.promise, failure]));
  const view = drawProbe();
  testService();
  if (cause === "URL")
    fireEvent.change(screen.getByLabelText("Tailnet service URL"), {
      target: { value: "http://100.64.0.2/edited" },
    });
  if (cause === "retry") {
    fixture.get.mockResolvedValueOnce({ status: 204, text: "" });
    testService();
    await screen.findByRole("img", { name: /^HTTP 204 / });
  }
  if (cause === "stop-reconnect")
    act(() => {
      fixture.publish({ status: "stopped" });
      fixture.publish({ status: "connected" });
    });
  if (cause === "replacement")
    act(() => {
      controlledNode("connected");
    });
  if (cause === "unmount") view.unmount();
  await act(async () => {
    if (outcome === "success")
      success.resolve({ status: 200, text: "stale-response-body" });
    else fail(new Error("not-an-error-body"));
  });
  if (cause === "retry")
    expect(screen.getByRole("img", { name: /^HTTP 204 / })).toBeTruthy();
  else noProbe();
  expect(
    listNotices().some((notice) => notice.id === "tailscale-browser-node"),
  ).toBe(false);
  expect(document.body.textContent).not.toContain("stale-response-body");
});
it.each(
  ["lock", "restart"].flatMap((cause) =>
    ["success", "failure"].map((outcome) => ({ cause, outcome })),
  ),
)(
  "ignores late $outcome after actual runtime $cause",
  async ({ cause, outcome }) => {
    const fixture = await statusFixture();
    actual.push(fixture);
    await fixture.connect();
    let fail = (_error: Error) => {};
    const response = deferred<{ status: number; text: string }>();
    const failure = new Promise<never>((_resolve, reject) => {
      fail = reject;
    });
    vi.spyOn(fixture.node, "get").mockReturnValueOnce(
      Promise.race([response.promise, failure]),
    );
    drawProbe();
    testService();
    await act(async () => {
      if (cause === "lock") vaultStore.lock();
      else {
        fixture.node.stop();
        await fixture.connect();
      }
    });
    await act(async () => {
      if (outcome === "success")
        response.resolve({ status: 200, text: "late-private-body" });
      else fail(new Error("late-private-error"));
    });
    noProbe();
    expect(document.body.textContent).not.toContain("late-private");
  },
);
it("keeps a new current request when an older port release fires", async () => {
  controlledNode("connected");
  const oldRelease = release;
  const fixture = controlledNode("connected");
  const response = deferred<{ status: number; text: string }>();
  fixture.get.mockReturnValueOnce(response.promise);
  drawProbe();
  testService();
  act(() => oldRelease());
  await act(async () => {
    response.resolve({ status: 200, text: "" });
  });
  expect(screen.getByRole("img", { name: /^HTTP 200 / })).toBeTruthy();
});
it.each(["synchronous throw", "rejected Promise"])(
  "reports %s safely without echoing error data",
  async (mode) => {
    const fixture = controlledNode("connected");
    if (mode === "synchronous throw")
      fixture.get.mockImplementationOnce(() => {
        throw new Error("private-unknown-error-body");
      });
    else
      fixture.get.mockRejectedValueOnce({ body: "private-unknown-error-body" });
    drawProbe();
    testService();
    await screen.findByRole("img", {
      name: "The tailnet service request failed. Check the address and try again.",
    });
    expect(document.body.textContent).not.toContain(
      "private-unknown-error-body",
    );
  },
);
