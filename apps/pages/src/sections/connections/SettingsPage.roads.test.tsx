/** @vitest-environment jsdom */
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { identitySeams } from "@opensesame/app-core/lib/identity.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { awsKmsConnectDependencies } from "./AwsKmsConnectPanel.js";
import { ConnectorSettingsPage } from "./SettingsPage.js";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "./connect/native-connector-integration.test-support.js";
import { declareConnectionsTutorial } from "./tutorial.test-support.js";

const originalIdentity = { ...identitySeams };
const originalVault = vaultHooksSeams.useVault;
const originalAws = { ...awsKmsConnectDependencies };

afterEach(() => {
  cleanup();
  Object.assign(identitySeams, originalIdentity);
  vaultHooksSeams.useVault = originalVault;
  Object.assign(awsKmsConnectDependencies, originalAws);
});

declareConnectionsTutorial();
installConnectorIntegration();

function provider(id: string): Provider {
  const found = getBundledProviders().find((row) => row.id === id);
  if (!found) throw new Error(`${id} is not bundled`);
  return found;
}

function draw(id: string) {
  render(
    <MemoryRouter initialEntries={[`/settings/connections/${id}`]}>
      <ConnectorSettingsPage
        provider={provider(id)}
        providerId={id}
        connection={null}
        connections={[]}
        loading={false}
        online
        canConfigure
        configureHint=""
        flash={null}
        rememberOffer={null}
        onFlash={vi.fn()}
        onRememberOffer={vi.fn()}
        onChanged={vi.fn()}
      />
    </MemoryRouter>,
  );
}

/** A Host is named and a grant to it is live: it opens no connector road. */
function nameAHostWithALiveGrant() {
  identitySeams.hostBase = () => "https://host.test";
  identitySeams.hostLocalSessionEligible = () => true;
}

function unlocked() {
  awsKmsConnectDependencies.readAwsKmsConfig = async () => ({
    keyArn: "",
    region: "",
    accessKeyId: "",
    secretAccessKey: "",
    sessionToken: null,
    label: null,
    configVersion: "0",
  });
  vaultHooksSeams.useVault = () => ({
    ...originalVault(),
    status: "unlocked",
    guest: false,
    tomb: "personal",
  });
}

describe("a connector page whose only road is closed on this device", () => {
  it("draws no Connect panel and no key, and its mark says nothing is here", () => {
    draw("linear");
    expect(
      screen.queryByRole("heading", {
        name: (value: string) => value === "Connect",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Save configuration/ }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /Connect Linear/ })).toBeNull();
    expect(
      screen.getByRole("img", { name: "Not available here" }),
    ).toBeTruthy();
  });
});

describe("a Host opens no road", () => {
  it("leaves an authorize-only connector with nothing to do, grant or not", () => {
    nameAHostWithALiveGrant();
    draw("linear");
    expect(screen.queryByRole("heading", { name: "Connect" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Connect Linear/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Authorize with Linear/ }),
    ).toBeNull();
    expect(
      screen.getByRole("img", { name: "Not available here" }),
    ).toBeTruthy();
  });
});

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
    expect(screen.getByRole("heading", { name: "Connect" })).toBeTruthy();
    expect(
      screen.queryByRole("img", { name: "Not available here" }),
    ).toBeNull();
  });
});

describe("a connector page the browser acts on alone", () => {
  it("keeps its Connect panel with no Host at all", () => {
    draw("git");
    expect(screen.getByRole("heading", { name: "Connect" })).toBeTruthy();
    expect(screen.getByLabelText(/Remote URL/i)).toBeTruthy();
  });

  it("keeps GitHub unavailable without its browser driver and never offers server-backed App registration", () => {
    draw("github");
    expect(
      screen.queryByRole("button", {
        name: /Create GitHub App for this organization/i,
      }),
    ).toBeNull();
    expect(
      screen.getByRole("img", { name: "Not available here" }),
    ).toBeTruthy();
    expect(screen.queryByLabelText("GitHub personal access token")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Authorize with GitHub/i }),
    ).toBeNull();
  });
});
