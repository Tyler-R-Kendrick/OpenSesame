/** @vitest-environment jsdom */
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  draw,
  nameAHostWithALiveGrant,
  unlocked,
} from "./SettingsPage.roads.test-support.js";
import { connectorIntegration } from "./connect/native-connector-integration.test-support.js";

describe("a key or a configuration seals on this device", () => {
  it.each([false, true])(
    "configures Better Auth through shared identity fields with a named Host=%s",
    (namedHost) => {
      if (namedHost) nameAHostWithALiveGrant();
      draw("better-auth");
      expect(screen.getByLabelText("Auth API base URL")).toBeTruthy();
      expect(screen.getByLabelText("Protocol")).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Save identity connection" }),
      ).toBeTruthy();
      expect(
        screen.queryByText(
          /OpenSesame has no browser connection for Better Auth/,
        ),
      ).toBeNull();
    },
  );

  it("configures Anthropic through the shared inference form when Vercel also lists it", () => {
    connectorIntegration();
    draw("anthropic");
    expect(screen.getByLabelText("API key", { exact: true })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Save AI connection" }),
    ).toBeTruthy();
  });

  it("composes only browser peering without OAuth management, the legacy daemon refusal or a duplicate generic form", () => {
    draw("tailscale");
    expect(
      screen.getAllByRole("region", { name: "Tailscale browser node" }),
    ).toHaveLength(1);
    expect(screen.getAllByLabelText("Browser node hostname")).toHaveLength(1);
    expect(screen.getAllByLabelText("Tailscale control server")).toHaveLength(
      1,
    );
    expect(screen.getAllByLabelText("Optional node auth key")).toHaveLength(1);
    expect(
      screen.getByLabelText("Optional node auth key").getAttribute("type"),
    ).toBe("password");
    for (const field of [
      "Tailscale API base URL",
      "App name",
      "Provisioned node attributes",
      "Redirect URI to register",
      "Returned OAuth app JSON",
      "Admin API access token",
      "Issued device auth key",
      "Tailnet",
    ])
      expect(screen.queryByLabelText(field, { exact: true })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Connect browser node" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: /Download registration request|Register app with Tailscale|Save returned Tailscale app|Prepare device key handoff/,
      }),
    ).toBeNull();
    expect(
      screen.queryByText(/device enrollment requires tailscaled/),
    ).toBeNull();
    expect(screen.queryByLabelText("Auth key (required)")).toBeNull();
    expect(
      screen.queryByRole("region", {
        name: "Tailscale OAuth app configuration",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("region", { name: "Tailscale device provisioning" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Save configuration" }),
    ).toBeNull();
  });
});

describe("a connector page that seals in the vault", () => {
  it("draws nothing for a guest or a locked vault", () => {
    vaultStore.lock();
    draw("aws-kms");
    expect(screen.queryByRole("heading", { name: "Connect" })).toBeNull();
    expect(
      screen.getByRole("img", { name: "Not available here" }),
    ).toBeTruthy();
  });

  it("draws its panel once a vault is unlocked", () => {
    unlocked();
    draw("aws-kms");
    expect(screen.getByRole("heading", { name: /Connect/ })).toBeTruthy();
    expect(
      screen.queryByRole("img", { name: "Not available here" }),
    ).toBeNull();
  });
});

describe("API family selection", () => {
  for (const id of ["aws", "gcp", "azure-kms", "cloudflare"]) {
    it(`keeps the family selector on the ${id} configuration page`, () => {
      draw(id);
      expect(screen.getByLabelText("API family")).toBeTruthy();
    });
  }
});

describe("a connector page the browser acts on alone", () => {
  it("keeps its Connect panel with no Host at all", () => {
    draw("git");
    expect(screen.getByRole("heading", { name: /Connect/ })).toBeTruthy();
    expect(screen.getByLabelText(/Remote URL/i)).toBeTruthy();
  });

  it("offers GitHub's compiled token route with no runtime bound, and never server-backed App registration", () => {
    // No `connectorIntegration()` here: no driver has activated. The compiled
    // contract still configures, so the page must not say "Not available here".
    draw("github");
    expect(
      screen.queryByRole("button", {
        name: /Create GitHub App for this organization/i,
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("img", { name: "Not available here" }),
    ).toBeNull();
    expect(screen.getByRole("img", { name: "Not connected" })).toBeTruthy();
    expect(screen.getByLabelText("GitHub personal access token")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Authorize with GitHub/i }),
    ).toBeNull();
  });
});
