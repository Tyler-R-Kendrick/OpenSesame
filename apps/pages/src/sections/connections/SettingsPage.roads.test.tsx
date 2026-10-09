/** @vitest-environment jsdom */
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { identitySeams } from "@opensesame/app-core/lib/identity.js";
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
    "refuses unsupported Better Auth configuration with a named Host=%s",
    (namedHost) => {
      if (namedHost) nameAHostWithALiveGrant();
      draw("better-auth");
      expect(screen.queryByLabelText(/Base URL/)).toBeNull();
      expect(
        screen.queryByRole("button", {
          name: /Save configuration|Verify and connect/,
        }),
      ).toBeNull();
      expect(
        screen.getByText(/Better Auth has no supported browser driver/),
      ).toBeTruthy();
    },
  );

  it("asks for Anthropic's API key when Vercel also lists it", () => {
    connectorIntegration();
    draw("anthropic");
    expect(screen.getByLabelText("Anthropic API key")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Verify and connect Anthropic" }),
    ).toBeTruthy();
  });

  it("explains Tailscale's native daemon requirement without collecting an auth key", () => {
    draw("tailscale");
    expect(screen.queryByLabelText(/Tailnet|Auth key/)).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: /Save configuration|Verify and connect/,
      }),
    ).toBeNull();
    expect(
      screen.getByText(/device enrollment requires tailscaled/),
    ).toBeTruthy();
  });
});

describe("a connector page that seals in the vault", () => {
  it("draws nothing for a guest or a locked vault", () => {
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

  it("offers GitHub's App, and nothing that needs a Host", () => {
    draw("github");
    expect(
      screen.getByRole("button", {
        name: /Create GitHub App for this organization/i,
      }),
    ).toBeTruthy();
    expect(screen.queryByLabelText(/personal access token/i)).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Authorize with GitHub/i }),
    ).toBeNull();
  });
});
