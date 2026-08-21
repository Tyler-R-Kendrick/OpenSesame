import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PagesSettings } from "../../lib/settings.js";
import {
  EndpointsPanel,
  TursoSyncPanel,
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
    tursoUrl: "",
    mfaAppUrl: "",
    capabilityConnectors: {
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
const checkTurso = vi.fn();
const setTursoSessionToken = vi.fn();

Object.assign(endpointsPanelDependencies, {
  loadSettings,
  saveSettings,
  pageIsLoopback: () => env.loopbackPage,
  checkTurso,
  setTursoSessionToken,
});

const BASE: PagesSettings = {
  hostApi: "http://127.0.0.1:18787",
  identityApi: "http://127.0.0.1:18788",
  daemonApi: "",
  tursoUrl: "",
  mfaAppUrl: "",
  capabilityConnectors: {
    encryption: { providerId: "webcrypto" },
    history: { providerId: "github" },
  },
};

beforeEach(() => {
  env.loopbackPage = true;
  env.settings = { ...BASE };
  loadSettings.mockClear();
  saveSettings.mockClear();
  checkTurso.mockResolvedValue("embedded");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function open() {
  render(<EndpointsPanel />);
  fireEvent.click(screen.getByRole("button", { name: "Edit by hand" }));
}

describe("EndpointsPanel", () => {
  it("opens collapsed — pairing already wrote these", () => {
    render(<EndpointsPanel />);
    expect(screen.queryByLabelText("Host API")).toBeNull();
    const toggle = screen.getByRole("button", { name: "Edit by hand" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("reveals the fields when asked", () => {
    open();
    expect(screen.getByLabelText("Host API")).toBeTruthy();
    expect(screen.getByLabelText("Identity API")).toBeTruthy();
    expect(screen.getByLabelText("Daemon on this machine")).toBeTruthy();
    expect(screen.getByLabelText("Mobile MFA app")).toBeTruthy();
  });

  it("has no Save button — a settings pane cannot be half-entered", () => {
    open();
    expect(
      screen.queryByRole("button", { name: /Save endpoints/i }),
    ).toBeNull();
  });

  it("commits a trimmed value on blur and says so beside the label", async () => {
    open();
    const host = screen.getByLabelText("Host API");
    await userEvent.clear(host);
    await userEvent.type(host, "  https://host.example.com/  ");
    fireEvent.blur(host);

    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ hostApi: "https://host.example.com" }),
    );
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("commits on Enter without submitting anything", async () => {
    open();
    const daemon = screen.getByLabelText("Daemon on this machine");
    await userEvent.type(daemon, "https://box.tailnet.ts.net{Enter}");
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ daemonApi: "https://box.tailnet.ts.net" }),
    );
  });

  it("does not write when the value did not actually change", async () => {
    open();
    const host = screen.getByLabelText("Host API");
    fireEvent.blur(host);
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("offers the shipped default as a fill, and drops it once applied", async () => {
    open();
    const fill = screen.getByRole("button", { name: "http://127.0.0.1:18790" });
    await userEvent.click(fill);
    expect(
      // SAFETY: the label names the text input rendered by EndpointsPanel.
      (screen.getByLabelText("Daemon on this machine") as HTMLInputElement)
        .value,
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
    open();
    const mfa = screen.getByLabelText("Mobile MFA app");
    await userEvent.type(mfa, "http://127.0.0.1:5177");
    fireEvent.blur(mfa);
    expect(screen.getByText("Saved")).toBeTruthy();
    await userEvent.type(mfa, "8");
    expect(screen.queryByText("Saved")).toBeNull();
  });
});

describe("TursoSyncPanel", () => {
  it("keeps the token out of persisted settings", async () => {
    render(<TursoSyncPanel />);
    await userEvent.type(
      screen.getByLabelText("Sync URL"),
      "libsql://db.turso.io",
    );
    await userEvent.type(
      screen.getByLabelText("Auth token (this tab only)"),
      "secret-token",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Apply and check/i }),
    );

    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ tursoUrl: "libsql://db.turso.io" }),
    );
    const persisted = saveSettings.mock.calls[0]?.[0] ?? BASE;
    expect(JSON.stringify(persisted)).not.toContain("secret-token");
    expect(setTursoSessionToken).toHaveBeenCalledWith("secret-token");
  });

  it("reports the resulting catalog mode", async () => {
    checkTurso.mockResolvedValue("remote");
    render(<TursoSyncPanel />);
    await userEvent.click(
      screen.getByRole("button", { name: /Apply and check/i }),
    );
    expect(
      await screen.findByText(/synchronized with the configured remote/),
    ).toBeTruthy();
  });

  it("treats an in-memory fallback as an error", async () => {
    checkTurso.mockResolvedValue("memory");
    render(<TursoSyncPanel />);
    await userEvent.click(
      screen.getByRole("button", { name: /Apply and check/i }),
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /bundled connector catalog in memory/,
    );
  });
});
