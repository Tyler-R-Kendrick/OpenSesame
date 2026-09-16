/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultCapabilityConnectors } from "../../../lib/capabilities.js";
import { planeSeams } from "../../../lib/planes.js";
import { settingsSeams } from "../../../lib/settings.js";
import { createSetupSeams } from "../test-seams.js";
import { MfaStep } from "./MfaStep.js";

const seams = createSetupSeams();

let capabilityConnectors = defaultCapabilityConnectors();

beforeEach(() => {
  seams.reset();
  capabilityConnectors = defaultCapabilityConnectors();
  planeSeams.usePlaneStatus = () => ({
    host: "down",
    hostBase: "",
    identity: "down",
    identityBase: "",
  });
  settingsSeams.saveSettings = (next) => {
    capabilityConnectors = next.capabilityConnectors ?? capabilityConnectors;
  };
});

afterEach(() => {
  cleanup();
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

    expect(screen.getByRole("button", { name: /This vault/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Bitwarden/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Resend/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /SendGrid/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Twilio/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /MessageBird/ })).toBeTruthy();
  });

  it("binds this-vault authenticator instantly without a Host", () => {
    render(<MfaStep />);
    fireEvent.click(screen.getByRole("button", { name: /This vault/ }));
    expect(capabilityConnectors.mfa_authenticator.providerId).toBe(
      "vault-self",
    );
    expect(screen.getByText("Ready")).toBeTruthy();
  });
});
