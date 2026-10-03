import { registerContributionForTest } from "@opensesame/app-core/lib/contributions.js";
/** @vitest-environment jsdom */
import { pluginById } from "@opensesame/app-core/lib/plugins/catalog.js";
import {
  type PluginDaemon,
  PluginError,
} from "@opensesame/app-core/lib/plugins/client.js";
import { createPluginSession } from "@opensesame/app-core/lib/plugins/session.js";
import { SURROGATE_TARGETS } from "@opensesame/app-core/tutorial/registry/plugins-catalog.js";
import type { BoundaryObject } from "@opensesame/os-domain";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginPanel } from "./PluginPanel.js";

const CODE = "opensesame-plugins:v1:eyJjb2RlIjoiLi4uIn0";

function wireState(overrides: BoundaryObject = {}) {
  return {
    id: "surrogate-proxy",
    capability: "agents.surrogate-credentials",
    installed: true,
    version: "0.1.0",
    enabled: false,
    forced_off: false,
    active: false,
    ...overrides,
  };
}

type Daemon = Readonly<{ open: boolean; accept: boolean }>;

function mount(daemonState: Daemon = { open: true, accept: true }) {
  const { open, accept } = daemonState;
  let paired = false;
  const listeners = new Set<() => void>();
  const moved = () => {
    for (const listener of listeners) listener();
  };
  const sent: string[] = [];
  const pair = vi.fn(async (_code: string, _signal: AbortSignal) => {
    if (!accept) throw new PluginError("pairing-refused");
    paired = true;
    moved();
  });
  const forget = vi.fn(async () => {
    paired = false;
    moved();
  });
  const daemon: PluginDaemon = {
    target: () =>
      paired ? { label: "Desk", host: "desk.tail.ts.net", revision: 1 } : null,
    request: async (path, init) => {
      sent.push(`${init.method} ${path}`);
      const body =
        path === "/v1/plugins" ? { plugins: [wireState()] } : { notices: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    canPair: () => open,
    pair,
    forget,
  };
  const session = createPluginSession(pluginById("surrogate-proxy"), daemon);
  render(
    <PluginPanel session={session} guideId="settings.surrogate-credentials" />,
  );
  return { pair, forget, sent };
}

const field = () => screen.getByLabelText("Pairing code");
const PAIR = { name: "Pair with the daemon" };
const pairKey = () => screen.getByRole("button", PAIR);
const noPairKey = () => screen.queryByRole("button", PAIR);

describe("PluginPanel pairing", () => {
  let undeclare: Array<() => void> = [];
  beforeEach(() => {
    undeclare = SURROGATE_TARGETS.map((target) =>
      registerContributionForTest("tutorial-target", target),
    );
  });
  afterEach(() => {
    cleanup();
    for (const revoke of undeclare) revoke();
  });

  it("takes a pasted code with one icon key, then draws the daemon's answer", async () => {
    const { pair, sent } = mount();
    expect(screen.getByLabelText("No daemon paired")).toBeTruthy();
    expect(noPairKey()).toBeNull();
    fireEvent.change(field(), { target: { value: CODE } });
    expect(pairKey().getAttribute("title")).toBe("Pair with the daemon");
    fireEvent.click(pairKey());
    await waitFor(() => expect(pair).toHaveBeenCalledTimes(1));
    expect(pair.mock.calls[0]?.[0]).toBe(CODE);
    expect(await screen.findByLabelText("Installed, off")).toBeTruthy();
    expect(screen.queryByLabelText("Pairing code")).toBeNull();
    expect(sent).toContain("GET /v1/plugins");
    expect(document.body.textContent).not.toContain(CODE);
  });

  it("names a refused code in the mark, keeps the field, and draws no box", async () => {
    mount({ open: true, accept: false });
    fireEvent.change(field(), { target: { value: CODE } });
    fireEvent.click(pairKey());
    expect(
      await screen.findByLabelText("The daemon would not take that code"),
    ).toBeTruthy();
    expect(field()).toBeTruthy();
    expect(document.querySelector(".note, .conn-flash")).toBeNull();
  });

  it("draws no field and no key with no vault to keep the key in", async () => {
    const { sent } = mount({ open: false, accept: true });
    expect(screen.getByLabelText("No daemon paired")).toBeTruthy();
    expect(screen.queryByLabelText("Pairing code")).toBeNull();
    expect(noPairKey()).toBeNull();
    expect(document.querySelector("form, input")).toBeNull();
    expect(sent).toEqual([]);
  });

  it("draws the key only once there is a code to send, and keeps focus on the field", () => {
    mount();
    field().focus();
    expect(noPairKey()).toBeNull();
    fireEvent.change(field(), { target: { value: "  " } });
    expect(noPairKey()).toBeNull();
    fireEvent.change(field(), { target: { value: CODE } });
    expect(pairKey().hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(field());
  });

  it("sends nothing for an empty code submitted with Enter", () => {
    const { pair } = mount();
    fireEvent.submit(field());
    expect(pair).not.toHaveBeenCalled();
  });

  it("keeps focus inside the tile when pairing takes the field away", async () => {
    mount();
    fireEvent.change(field(), { target: { value: CODE } });
    pairKey().focus();
    fireEvent.click(pairKey());
    await screen.findByLabelText("Installed, off");
    expect(screen.queryByLabelText("Pairing code")).toBeNull();
    const tile = document.getElementById("plugin-surrogate-proxy");
    expect(tile?.contains(document.activeElement)).toBe(true);
  });

  it("keeps focus inside the tile when forgetting takes its key away", async () => {
    mount();
    fireEvent.change(field(), { target: { value: CODE } });
    fireEvent.click(pairKey());
    const key = await screen.findByRole("button", {
      name: "Forget the paired daemon",
    });
    key.focus();
    fireEvent.click(key);
    await screen.findByLabelText("Pairing code");
    expect(
      screen.queryByRole("button", { name: "Forget the paired daemon" }),
    ).toBeNull();
    const tile = document.getElementById("plugin-surrogate-proxy");
    expect(tile?.contains(document.activeElement)).toBe(true);
  });

  it("forgets the pairing with one icon key and offers the field again", async () => {
    const { forget } = mount();
    fireEvent.change(field(), { target: { value: CODE } });
    fireEvent.click(pairKey());
    const key = await screen.findByRole("button", {
      name: "Forget the paired daemon",
    });
    expect(key.getAttribute("title")).toBe("Forget the paired daemon");
    fireEvent.click(key);
    await waitFor(() => expect(forget).toHaveBeenCalledTimes(1));
    expect(await screen.findByLabelText("Pairing code")).toBeTruthy();
    expect(screen.getByLabelText("No daemon paired")).toBeTruthy();
  });
});
