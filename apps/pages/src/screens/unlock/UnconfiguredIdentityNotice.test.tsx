/** @vitest-environment jsdom */
/**
 * The "no identity service" notice: shows only on a non-loopback page with no
 * Identity API, folds away once one exists, refuses junk input, and saves a
 * valid URL through the settings layer.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultCapabilityConnectors } from "../../lib/capabilities.js";
import type { PagesSettings } from "../../lib/settings.js";
import {
  UnconfiguredIdentityNotice,
  identityUnconfigured,
  unconfiguredNoticeDependencies,
} from "./UnconfiguredIdentityNotice.js";

const REAL = { ...unconfiguredNoticeDependencies };

function settings(identityApi: string): PagesSettings {
  return {
    hostApi: "",
    identityApi,
    daemonApi: "",
    tursoUrl: "",
    mfaAppUrl: "",
    capabilityConnectors: defaultCapabilityConnectors(),
    activeProjectId: "",
  };
}

afterEach(() => {
  cleanup();
  Object.assign(unconfiguredNoticeDependencies, REAL);
  vi.restoreAllMocks();
});

describe("identityUnconfigured", () => {
  it("is false on a loopback page whatever the settings say", () => {
    Object.assign(unconfiguredNoticeDependencies, {
      pageIsLoopback: () => true,
      loadSettings: () => settings(""),
    });
    expect(identityUnconfigured()).toBe(false);
  });

  it("is true on a remote page with no Identity API", () => {
    Object.assign(unconfiguredNoticeDependencies, {
      pageIsLoopback: () => false,
      loadSettings: () => settings(""),
    });
    expect(identityUnconfigured()).toBe(true);
  });

  it("is false once an Identity API is set", () => {
    Object.assign(unconfiguredNoticeDependencies, {
      pageIsLoopback: () => false,
      loadSettings: () => settings("https://id.example.com"),
    });
    expect(identityUnconfigured()).toBe(false);
  });
});

describe("UnconfiguredIdentityNotice", () => {
  it("renders nothing when an Identity API is configured", () => {
    Object.assign(unconfiguredNoticeDependencies, {
      pageIsLoopback: () => false,
      loadSettings: () => settings("https://id.example.com"),
    });

    const { container } = render(<UnconfiguredIdentityNotice />);

    expect(container.firstChild).toBeNull();
  });

  it("says sign-in is unavailable and offers the connect field", () => {
    Object.assign(unconfiguredNoticeDependencies, {
      pageIsLoopback: () => false,
      loadSettings: () => settings(""),
    });

    render(<UnconfiguredIdentityNotice />);

    expect(
      screen.getByText(/Not connected to an identity service/),
    ).toBeTruthy();
    expect(screen.getByLabelText("Identity API URL")).toBeTruthy();
  });

  it("refuses an input that is not a URL", () => {
    const saveSettings = vi.fn();
    Object.assign(unconfiguredNoticeDependencies, {
      pageIsLoopback: () => false,
      loadSettings: () => settings(""),
      saveSettings,
    });

    render(<UnconfiguredIdentityNotice />);
    fireEvent.change(screen.getByLabelText("Identity API URL"), {
      target: { value: "not a url" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(saveSettings).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("full URL");
  });

  it("saves a valid URL, trimmed of its trailing slash", () => {
    const saveSettings = vi.fn();
    Object.assign(unconfiguredNoticeDependencies, {
      pageIsLoopback: () => false,
      loadSettings: () => settings(""),
      saveSettings,
    });

    render(<UnconfiguredIdentityNotice />);
    fireEvent.change(screen.getByLabelText("Identity API URL"), {
      target: { value: "https://id.example.com/" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ identityApi: "https://id.example.com" }),
    );
  });
});
