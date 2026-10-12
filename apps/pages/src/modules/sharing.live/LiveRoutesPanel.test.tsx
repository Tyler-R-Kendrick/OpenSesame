/** @vitest-environment jsdom */
/**
 * The Routes panel and the start form on a profile that is not ordinary
 * (ADR 0150 §6): repeats, a TURN server removed under relay-only, a profile
 * that cannot be read, credentials that travel in the link, and a session
 * that will not start. The store under the panel is a fake; the panel is not.
 */
import { FakeBus, FakeNet } from "@opensesame/app-core/lib/live/live-fakes.js";
import { liveSeams } from "@opensesame/app-core/lib/live/session.js";
import { endHosting } from "@opensesame/app-core/lib/live/session.js";
import { TransportRefused } from "@opensesame/app-core/lib/live/transport-store.js";
import {
  DIRECT_TRANSPORT,
  type LiveTransport,
  type TransportRead,
} from "@opensesame/app-core/lib/live/transport.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { TRANSPORT_FILE } from "@opensesame/app-core/sections/settings/live-transport-files.js";
import { createItem } from "@opensesame/vault-core";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { SettingsFileContext } from "../../sections/settings/files/context.js";
import { LiveHostForm } from "./LiveHostForm.js";
import { LiveRoutesPanel } from "./LiveRoutesPanel.js";
import { liveUiSeams } from "./live-hooks.js";
import { transportSeams } from "./live-transport-hooks.js";

const github = createItem("account", "GitHub");
const original = {
  hooks: { ...vaultHooksSeams },
  live: { ...liveSeams },
  ui: { ...liveUiSeams },
  transport: { ...transportSeams },
};
let stored: LiveTransport;
let readError: Error | null;

beforeEach(() => {
  stored = DIRECT_TRANSPORT;
  readError = null;
  Object.assign(vaultHooksSeams, {
    useVault: () => ({
      ...vaultStore.getSnapshot(),
      status: "unlocked" as const,
      items: [github],
    }),
  });
  Object.assign(liveSeams, { items: () => [github] });
  Object.assign(liveUiSeams, {
    transport: new FakeNet().transports(),
    carriers: new FakeBus().factory(),
  });
  Object.assign(transportSeams, {
    tomb: () => "personal",
    read: async () => {
      if (readError) throw readError;
      return stored;
    },
    edit: async (
      _tomb: string,
      apply: (current: LiveTransport) => TransportRead,
    ) => {
      if (readError) throw readError;
      const next = apply(stored);
      if (next.ok) stored = next.transport;
      return next;
    },
  });
});

afterEach(() => {
  endHosting();
  cleanup();
  Object.assign(vaultHooksSeams, original.hooks);
  Object.assign(liveSeams, original.live);
  Object.assign(liveUiSeams, original.ui);
  Object.assign(transportSeams, original.transport);
});

const type = (where: ReturnType<typeof within>, label: string, value: string) =>
  fireEvent.change(where.getByLabelText(label), { target: { value } });

describe("the Routes panel", () => {
  it("takes a repeated address once: one row, one key, one Remove", async () => {
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const panel = within(render(<LiveRoutesPanel />).container);
    await panel.findByLabelText("Tailnet, VPN or LAN address");
    for (const _ of [1, 2]) {
      type(panel, "Tailnet, VPN or LAN address", "100.64.0.1");
      fireEvent.click(panel.getByRole("button", { name: "Add the address" }));
      await waitFor(() =>
        expect(
          panel.getByLabelText("Tailnet, VPN or LAN address"),
        ).toHaveProperty("value", ""),
      );
    }
    expect(panel.getAllByText("100.64.0.1")).toHaveLength(1);
    expect(stored.addresses).toEqual(["100.64.0.1"]);
    fireEvent.click(panel.getByRole("button", { name: "Remove 100.64.0.1" }));
    await waitFor(() => expect(stored.addresses).toEqual([]));
    expect(errors.mock.calls.flat().join(" ")).not.toContain("same key");
    errors.mockRestore();
  });

  it("takes the same carrier and the same server once", async () => {
    const panel = within(render(<LiveRoutesPanel />).container);
    await panel.findByLabelText("Code carrier");
    for (const _ of [1, 2]) {
      type(panel, "Server (https://)", "https://ntfy.example.com");
      fireEvent.click(panel.getByRole("button", { name: "Add the carrier" }));
      await waitFor(() => expect(stored.carriers).toHaveLength(1));
      await panel.findByText("https://ntfy.example.com");
    }
    for (const _ of [1, 2]) {
      type(panel, "STUN or TURN server", "stun:stun.example.com:3478");
      fireEvent.click(panel.getByRole("button", { name: "Add the server" }));
      await waitFor(() => expect(stored.ice).toHaveLength(1));
      await panel.findByText("stun:stun.example.com:3478");
    }
    expect(stored.carriers).toHaveLength(1);
    expect(stored.ice).toHaveLength(1);
  });

  it("removes the last TURN server under relay only, and relay only goes with it", async () => {
    stored = {
      ...DIRECT_TRANSPORT,
      ice: [
        { urls: ["stun:stun.example.com"] },
        { urls: ["turn:turn.example.com"], username: "u", credential: "c" },
      ],
      relay: true,
    };
    const panel = within(render(<LiveRoutesPanel />).container);
    fireEvent.click(
      await panel.findByRole("button", {
        name: "Remove turn:turn.example.com",
      }),
    );
    await waitFor(() => expect(stored.ice).toHaveLength(1));
    expect(stored.relay).toBe(false);
    expect(panel.queryByRole("img", { name: /TURN/ })).toBeNull();
  });

  it("shows a profile it cannot read, not an empty one to be saved over", async () => {
    readError = new TransportRefused("The profile is not valid JSON.");
    const panel = within(render(<LiveRoutesPanel />).container);
    await panel.findByRole("img", { name: "The profile is not valid JSON." });
    expect(panel.queryByLabelText("Tailnet, VPN or LAN address")).toBeNull();
    expect(
      panel.queryByRole("img", { name: "Reading this vault's routes" }),
    ).toBeNull();
  });

  it("opens its file from the heading, where a TURN REST secret is written", async () => {
    const openFile = vi.fn();
    const panel = within(
      render(
        <SettingsFileContext.Provider value={{ openFile }}>
          <LiveRoutesPanel />
        </SettingsFileContext.Provider>,
      ).container,
    );
    fireEvent.click(
      await panel.findByRole("button", { name: "Open transport.json" }),
    );
    expect(openFile).toHaveBeenCalledWith(TRANSPORT_FILE);
  });

  it("offers the file over a profile it cannot read, where it is fixed", async () => {
    readError = new TransportRefused("The profile is not valid JSON.");
    const openFile = vi.fn();
    const panel = within(
      render(
        <SettingsFileContext.Provider value={{ openFile }}>
          <LiveRoutesPanel />
        </SettingsFileContext.Provider>,
      ).container,
    );
    await panel.findByRole("img", { name: "The profile is not valid JSON." });
    fireEvent.click(panel.getByRole("button", { name: "Open transport.json" }));
    expect(openFile).toHaveBeenCalledWith(TRANSPORT_FILE);
  });

  it("says when the profile's credentials travel in the link, and only then", async () => {
    const view = render(<LiveRoutesPanel />);
    const panel = within(view.container);
    await panel.findByLabelText("Code carrier");
    const warning = "Credentials in this profile travel in the link";
    expect(panel.queryByRole("img", { name: warning })).toBeNull();
    stored = {
      ...DIRECT_TRANSPORT,
      carriers: [{ kind: "nats", url: "wss://n.example.com", token: "t" }],
    };
    cleanup();
    const again = within(render(<LiveRoutesPanel />).container);
    await again.findByRole("img", { name: warning });
  });
});

describe("the start form", () => {
  async function fill(form: ReturnType<typeof within>) {
    await form.findByLabelText("Session name");
    type(form, "Session name", "Team");
    fireEvent.click(form.getByRole("checkbox", { name: "GitHub" }));
  }
  const start = (form: ReturnType<typeof within>) =>
    form.getByRole("button", { name: /^Start the live session/ });

  it("does not start on a profile it cannot read, and says why", async () => {
    readError = new TransportRefused("relay needs at least one TURN server.");
    const form = within(render(<LiveHostForm />).container);
    await form.findByRole("img", {
      name: "relay needs at least one TURN server.",
    });
    type(form, "Session name", "Team");
    fireEvent.click(form.getByRole("checkbox", { name: "GitHub" }));
    expect(start(form)).toHaveProperty("disabled", true);
    expect(form.queryByRole("img", { name: "Direct only" })).toBeNull();
  });

  it("says when a link cannot carry the routes, and starts nothing", async () => {
    stored = {
      ...DIRECT_TRANSPORT,
      carriers: Array.from({ length: 5 }, (_, at) => ({
        kind: "nats" as const,
        url: `wss://n${at}.example.com`,
        username: "u".repeat(500),
        password: "p".repeat(500),
        token: "t".repeat(500),
      })),
    };
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const form = within(render(<LiveHostForm />).container);
    await fill(form);
    fireEvent.click(start(form));
    await form.findByRole("img", { name: /too long for a link/ });
    expect(start(form)).toHaveProperty("disabled", false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unhandled).not.toHaveBeenCalled();
    process.off("unhandledRejection", unhandled);
  });

  it("names a failure to start, never leaves it unhandled", async () => {
    Object.assign(liveSeams, {
      onLock: () => {
        throw new Error("boom");
      },
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const form = within(render(<LiveHostForm />).container);
    await fill(form);
    fireEvent.click(start(form));
    await form.findByRole("img", { name: "The live session could not start" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unhandled).not.toHaveBeenCalled();
    process.off("unhandledRejection", unhandled);
  });
});
