import { registerContributionForTest } from "@opensesame/app-core/lib/contributions.js";
/** @vitest-environment jsdom */
import { pluginById } from "@opensesame/app-core/lib/plugins/catalog.js";
import type { PluginDaemon } from "@opensesame/app-core/lib/plugins/client.js";
import { createPluginSession } from "@opensesame/app-core/lib/plugins/session.js";
import { SURROGATE_TARGETS } from "@opensesame/app-core/tutorial/registry/plugins-catalog.js";
import type { BoundaryObject, BoundaryValue } from "@opensesame/os-domain";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluginPanel } from "./PluginPanel.js";

const SURROGATE = "osr_7Hq2mV9xK3pL8wN4rT6yB1cD5fG0jZ";

const json = (body: BoundaryValue, status = 200) =>
  new Response(JSON.stringify(body), { status });

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

function mount(
  state: BoundaryObject | null,
  notices: BoundaryValue[] = [],
  paired = true,
) {
  const sent: string[] = [];
  const daemon: PluginDaemon = {
    target: () =>
      !paired ? null : { label: "desk", host: "desk.tail.ts.net" },
    request: async (path, init) => {
      sent.push(`${init.method} ${path}`);
      if (path === "/v1/plugins")
        return json({ plugins: state === null ? [] : [state] });
      if (path.endsWith("/notices")) return json({ notices });
      return json(wireState({ enabled: true, active: true }));
    },
  };
  const session = createPluginSession(pluginById("surrogate-proxy"), daemon);
  render(
    <PluginPanel session={session} guideId="settings.surrogate-credentials" />,
  );
  return { sent, session };
}

const toggle = () =>
  screen.getByRole("button", { name: "Surrogate proxy on the paired daemon" });

describe("PluginPanel", () => {
  // The tile is a tutorial target its module declares on activation.
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

  it("asks nothing and offers no switch with no daemon paired", async () => {
    const { sent } = mount(wireState(), [], false);
    expect(await screen.findByLabelText("No daemon paired")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /paired daemon/ })).toBeNull();
    expect(sent).toEqual([]);
  });

  it("shows an uninstalled plugin's mark and the command, and cannot switch it", async () => {
    mount(wireState({ installed: false, version: null }));
    expect(await screen.findByLabelText("Not installed")).toBeTruthy();
    expect(
      screen.getByText(
        "opensesame plugins install surrogate-proxy --from <file-or-url> --sha256 <sha256>",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Copy the install command" }),
    ).toBeTruthy();
    expect(toggle()).toHaveProperty("disabled", true);
  });

  it("a forced-off plugin reads as off and cannot be turned on from here", async () => {
    const { sent } = mount(
      wireState({ enabled: true, forced_off: true, active: false }),
    );
    expect(
      await screen.findByLabelText("Forced off on the daemon"),
    ).toBeTruthy();
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(toggle()).toHaveProperty("disabled", true);
    fireEvent.click(toggle());
    expect(sent.some((line) => line.startsWith("PUT"))).toBe(false);
  });

  it("switches an installed plugin on the paired daemon with one icon key", async () => {
    const { sent } = mount(wireState());
    expect(await screen.findByLabelText("Installed, off")).toBeTruthy();
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(toggle().getAttribute("title")).toBe(
      "Surrogate proxy on the paired daemon",
    );
    fireEvent.click(toggle());
    await waitFor(() => expect(screen.getByLabelText("On")).toBeTruthy());
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(sent).toContain("PUT /v1/plugins/surrogate-proxy");
  });

  it("lists tripwires by event, time and subject — and never a surrogate or a summary", async () => {
    mount(wireState({ enabled: true, active: true }), [
      {
        event_type: "surrogate.wrong_host",
        severity: "high",
        occurred_at: "2026-09-28T10:00:00Z",
        summary: "a summary the page never draws",
        subject_id: "run-4f2a",
      },
      {
        event_type: "surrogate.wrong_caller",
        severity: "high",
        occurred_at: "2026-09-28T09:00:00Z",
        summary: SURROGATE,
        subject_id: SURROGATE,
      },
    ]);
    const list = await screen.findByRole("list", { name: "Recent tripwires" });
    expect(list.textContent).toContain("surrogate.wrong_host");
    expect(list.textContent).toContain("run-4f2a");
    expect(list.querySelectorAll("time")).toHaveLength(2);
    expect(document.body.textContent).not.toContain("osr_");
    expect(document.body.textContent).not.toContain("a summary");
  });

  it("says the daemon refused in a mark, not a box", async () => {
    const daemon: PluginDaemon = {
      target: () => ({ label: "desk", host: "desk.tail.ts.net" }),
      request: async () => json({ error: "operator_unauthorized" }, 401),
    };
    const session = createPluginSession(pluginById("surrogate-proxy"), daemon);
    render(
      <PluginPanel
        session={session}
        guideId="settings.surrogate-credentials"
      />,
    );
    expect(
      await screen.findByLabelText("The daemon did not let this device in"),
    ).toBeTruthy();
    expect(document.querySelector(".note, .conn-flash")).toBeNull();
  });
});
