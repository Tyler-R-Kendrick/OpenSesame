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
    target: () => (paired ? { label: "Desk", host: "desk.tail.ts.net" } : null),
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
const pairKey = () =>
  screen.getByRole("button", { name: "Pair with the daemon" });

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
    expect(pairKey()).toHaveProperty("disabled", true);
    expect(pairKey().getAttribute("title")).toBe("Pair with the daemon");
    fireEvent.change(field(), { target: { value: CODE } });
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

  it("offers the field but no way to submit with no vault to keep the key in", () => {
    mount({ open: false, accept: true });
    expect(field()).toHaveProperty("disabled", true);
    expect(pairKey()).toHaveProperty("disabled", true);
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
