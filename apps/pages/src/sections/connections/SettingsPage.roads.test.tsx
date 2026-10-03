/** @vitest-environment jsdom */
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import {
  HOST_CONNECTIONS_WRITE,
  hostGrantSeams,
} from "@opensesame/app-core/lib/host-grant.js";
import { identitySeams } from "@opensesame/app-core/lib/identity.js";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { awsKmsConnectDependencies } from "./AwsKmsConnectPanel.js";
import { ConnectorSettingsPage } from "./SettingsPage.js";
import { declareConnectionsTutorial } from "./tutorial.test-support.js";

const originalIdentity = { ...identitySeams };
const originalGrant = { ...hostGrantSeams };
const originalVault = vaultHooksSeams.useVault;
const originalAws = { ...awsKmsConnectDependencies };

afterEach(() => {
  cleanup();
  Object.assign(identitySeams, originalIdentity);
  Object.assign(hostGrantSeams, originalGrant);
  vaultHooksSeams.useVault = originalVault;
  Object.assign(awsKmsConnectDependencies, originalAws);
});

declareConnectionsTutorial();

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

function openHostRoad() {
  identitySeams.hostBase = () => "https://host.test";
  identitySeams.hostLocalSessionEligible = () => true;
  hostGrantSeams.capabilities = () => [HOST_CONNECTIONS_WRITE];
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

describe("a key or a configuration seals on this device", () => {
  it("draws Better Auth's fields with no Host", () => {
    draw("better-auth");
    expect(
      screen.getByRole("heading", {
        name: (value: string) => value === "Connect",
      }),
    ).toBeTruthy();
    expect(screen.getByLabelText(/Base URL/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Save configuration/ }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("img", { name: "Not available here" }),
    ).toBeNull();
  });

  it("draws the same form once a Host is open", () => {
    openHostRoad();
    draw("better-auth");
    expect(
      screen.getByRole("heading", {
        name: (value: string) => value === "Connect",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Save configuration/ }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("img", { name: "Not available here" }),
    ).toBeNull();
  });

  it("asks for Anthropic's API key when Vercel also lists it", () => {
    draw("anthropic");
    expect(screen.getByLabelText("API key")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Connect Anthropic" }),
    ).toBeTruthy();
  });

  it("asks for Tailscale's tailnet and auth key", () => {
    draw("tailscale");
    expect(screen.getByLabelText(/Tailnet/)).toBeTruthy();
    expect(screen.getByLabelText(/Auth key/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Save configuration/ }),
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
