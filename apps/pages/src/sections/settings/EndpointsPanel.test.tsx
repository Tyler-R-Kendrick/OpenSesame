import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultCapabilityConnectors } from "../../lib/capabilities.js";
import type { PagesSettings } from "../../lib/settings.js";
import {
  EndpointsPanel,
  endpointsPanelDependencies,
} from "./EndpointsPanel.js";

type EndpointTestEnvironment = {
  settings: PagesSettings;
  loopbackPage: boolean;
};
const env: EndpointTestEnvironment = {
  settings: {
    hostApi: "",
    identityApi: "",
    daemonApi: "",
    mfaAppUrl: "",
    capabilityConnectors: {
      ...defaultCapabilityConnectors(),
      encryption: { providerId: "webcrypto" },
      history: { providerId: "github" },
    },
  },
  loopbackPage: true,
};

const loadSettings = vi.fn(() => ({ ...env.settings }));
const saveSettings = vi.fn((next: PagesSettings) => {
  env.settings = { ...next };
});
Object.assign(endpointsPanelDependencies, {
  loadSettings,
  saveSettings,
  pageIsLoopback: () => env.loopbackPage,
});

const BASE: PagesSettings = {
  hostApi: "http://127.0.0.1:18787",
  identityApi: "http://127.0.0.1:18788",
  daemonApi: "",
  mfaAppUrl: "",
  capabilityConnectors: {
    ...defaultCapabilityConnectors(),
    encryption: { providerId: "webcrypto" },
    history: { providerId: "github" },
  },
};

beforeEach(() => {
  env.loopbackPage = true;
  env.settings = { ...BASE };
  loadSettings.mockClear();
  saveSettings.mockClear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function open(name = "Host API") {
  render(<EndpointsPanel />);
  fireEvent.click(screen.getByRole("button", { name }));
}

describe("EndpointsPanel", () => {
  it("opens collapsed — pairing already wrote these", () => {
    render(<EndpointsPanel />);
    expect(screen.queryByRole("textbox", { name: "Host API" })).toBeNull();
    const toggle = screen.getByRole("button", { name: "Host API" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("reveals one endpoint at a time", () => {
    render(<EndpointsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Host API" }));
    expect(screen.getByRole("textbox", { name: "Host API" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Identity API" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Identity API" }));
    expect(screen.queryByRole("textbox", { name: "Host API" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Identity API" })).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Daemon on this machine" }),
    );
    expect(
      screen.getByRole("textbox", { name: "Daemon on this machine" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mobile MFA app" }));
    expect(
      screen.getByRole("textbox", { name: "Mobile MFA app" }),
    ).toBeTruthy();
  });

  it("has no Save button — a settings pane cannot be half-entered", () => {
    open();
    expect(
      screen.queryByRole("button", { name: /Save endpoints/i }),
    ).toBeNull();
  });

  it("commits a trimmed value on blur and says so beside the label", async () => {
    open();
    const host = screen.getByRole("textbox", { name: "Host API" });
    await userEvent.clear(host);
    await userEvent.type(host, "  https://host.example.com/  ");
    fireEvent.blur(host);

    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ hostApi: "https://host.example.com" }),
    );
    expect(
      screen.getAllByRole("img", { name: "Saved" }).length,
    ).toBeGreaterThan(0);
  });

  it("commits on Enter without submitting anything", async () => {
    open("Daemon on this machine");
    const daemon = screen.getByRole("textbox", {
      name: "Daemon on this machine",
    });
    await userEvent.type(daemon, "https://box.tailnet.ts.net{Enter}");
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ daemonApi: "https://box.tailnet.ts.net" }),
    );
  });

  it("does not write when the value did not actually change", async () => {
    open();
    const host = screen.getByRole("textbox", { name: "Host API" });
    fireEvent.blur(host);
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("offers the shipped default as a fill, and drops it once applied", async () => {
    open("Daemon on this machine");
    const fill = screen.getByRole("button", { name: "http://127.0.0.1:18790" });
    await userEvent.click(fill);
    expect(
      // SAFETY: the label names the text input rendered by EndpointsPanel.
      (
        screen.getByRole("textbox", {
          name: "Daemon on this machine",
        }) as HTMLInputElement
      ).value,
    ).toBe("http://127.0.0.1:18790");
    expect(
      screen.queryByRole("button", { name: "http://127.0.0.1:18790" }),
    ).toBeNull();
  });

  it("offers no loopback fills on a page that could never call them", () => {
    env.loopbackPage = false;
    env.settings = { ...BASE, hostApi: "", identityApi: "" };
    open();
    expect(
      screen.queryByRole("button", { name: "http://127.0.0.1:18790" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "http://127.0.0.1:18787" }),
    ).toBeNull();
  });

  it("clears the Saved chip once the field is edited again", async () => {
    open("Mobile MFA app");
    const mfa = screen.getByRole("textbox", { name: "Mobile MFA app" });
    await userEvent.type(mfa, "http://127.0.0.1:5177");
    fireEvent.blur(mfa);
    expect(
      screen.getAllByRole("img", { name: "Saved" }).length,
    ).toBeGreaterThan(0);
    await userEvent.type(mfa, "8");
    expect(screen.queryAllByRole("img", { name: "Saved" })).toHaveLength(0);
  });
});
