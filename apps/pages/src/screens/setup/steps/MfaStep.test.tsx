import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
/** @vitest-environment jsdom */
import { planeHookSeams } from "../../../bindings/planes.js";

import { defaultCapabilityConnectors } from "@opensesame/app-core/lib/capabilities.js";
import {
  connectRoadSeams,
  notifyConnectRoads,
  resetConnectRoadSeams,
} from "@opensesame/app-core/lib/connect-roads.js";
import { settingsSeams } from "@opensesame/app-core/lib/settings.js";
import { hasConnectRoute } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import {
  setVercelConnectAuth,
  usesConnect,
} from "@opensesame/app-core/lib/vercel-connect.js";
import { createSetupSeams } from "../test-seams.js";
import { MfaStep } from "./MfaStep.js";

const seams = createSetupSeams();

let capabilityConnectors = defaultCapabilityConnectors();

beforeEach(() => {
  seams.reset();
  capabilityConnectors = defaultCapabilityConnectors();
  planeHookSeams.usePlaneStatus = () => ({
    identity: "down",
    identityBase: "",
  });
  // Settings round-trip through the local map, so a pick is read back.
  settingsSeams.loadSettings = () => ({
    ...seams.currentSettings(),
    capabilityConnectors,
  });
  settingsSeams.saveSettings = (next) => {
    capabilityConnectors = next.capabilityConnectors ?? capabilityConnectors;
  };
});

afterEach(() => {
  cleanup();
  resetConnectRoadSeams();
  notifyConnectRoads();
});

describe("MfaStep", () => {
  it("lists configurable connectors for each of the three MFA families", () => {
    render(<MfaStep />);

    expect(
      screen.queryByRole("heading", { name: "Should a code follow the key?" }),
    ).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Authenticator app" }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Email code" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Text message" })).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Authenticator app" }),
    ).toBeTruthy();
    expect(screen.getByRole("region", { name: "Email code" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Text message" })).toBeTruthy();

    // Every connector is a choice object to pick; the vault's own
    // authenticator needs no account, so it carries no connect key.
    expect(screen.getByRole("button", { name: /^This vault/ })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Connect This vault" }),
    ).toBeNull();
    // One that needs an account is a choice object; it carries a connect icon
    // key only where a road exists to connect through (ADR 0150, ADR 0151).
    // With no Connect credential and no Host, no key could succeed, so none is
    // drawn.
    for (const name of ["Bitwarden", "Resend", "SendGrid", "Twilio"]) {
      expect(
        screen.getByRole("button", { name: new RegExp(`^${name}`) }),
      ).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: `Connect ${name}` }),
      ).toBeNull();
    }
    expect(screen.getByRole("button", { name: /^MessageBird/ })).toBeTruthy();
  });

  it("offers the connect key on a Connect-reachable connector once Connect is set up", () => {
    setVercelConnectAuth({ token: "vercel_token" });
    connectRoadSeams.usesConnect = usesConnect;
    connectRoadSeams.hasConnectRoute = hasConnectRoute;
    notifyConnectRoads();
    try {
      render(<MfaStep />);
      for (const name of ["Resend", "SendGrid", "Twilio"]) {
        expect(
          screen.getByRole("button", { name: `Connect ${name}` }),
        ).toBeTruthy();
      }
      // Host-only, so still no key: Connect cannot authorize it.
      expect(
        screen.queryByRole("button", { name: "Connect Bitwarden" }),
      ).toBeNull();
    } finally {
      setVercelConnectAuth(null);
    }
  });

  it("binds this-vault authenticator instantly without a Host", () => {
    // Start the binding elsewhere so the pick is observable.
    capabilityConnectors = {
      ...capabilityConnectors,
      mfa_authenticator: { providerId: "bitwarden" },
    };
    render(<MfaStep />);
    const pick = screen.getByRole("button", { name: /^This vault/ });
    expect(pick.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("img", { name: "Instant" })).toBeTruthy();
    fireEvent.click(pick);
    expect(capabilityConnectors.mfa_authenticator.providerId).toBe(
      "vault-self",
    );
    expect(pick.getAttribute("aria-pressed")).toBe("true");
    // The status is a glyph whose sentence is its accessible name.
    expect(screen.getByRole("img", { name: "Ready" })).toBeTruthy();
  });
});
