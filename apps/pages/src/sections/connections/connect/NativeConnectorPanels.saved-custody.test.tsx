/** @vitest-environment jsdom */
import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import type { Connection } from "@opensesame/app-core/lib/connections.js";
import { deviceConnection } from "@opensesame/app-core/lib/device-connectors.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { configureNativeApiConnector } from "@opensesame/app-core/lib/native-api-connectors.js";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorSettingsPage } from "../SettingsPage.js";
import { declareConnectionsTutorial } from "../tutorial.test-support.js";
import { nativeSettingsDescriptor } from "./NativeConnectorPanels.js";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "./native-connector-integration.test-support.js";
import { nativeScopeDefaults } from "./native-connector-ui-values.js";
import { nativeProviderDescriptor } from "./native-provider-descriptor.js";

afterEach(cleanup);
declareConnectionsTutorial();
installConnectorIntegration();

function provider(id: string) {
  const found = getBundledProviders().find((row) => row.id === id);
  if (!found) throw new Error(`${id} is not bundled`);
  return found;
}

function draw(id: string, connection: Connection) {
  render(
    <MemoryRouter initialEntries={[`/settings/connections/${id}`]}>
      <ConnectorSettingsPage
        provider={provider(id)}
        providerId={id}
        connection={connection}
        connections={[connection]}
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

describe("native Linear custody and advertised scopes", () => {
  it("keeps a sealed native Linear API key on its saved custody road", async () => {
    const integration = connectorIntegration();
    const secret = "lin_api_saved-native-custody-fixture";
    integration.replies.push({
      body: { data: { viewer: { id: "owned-viewer", name: "Owner" } } },
    });
    const saved = await configureNativeApiConnector({
      providerId: "linear",
      displayName: "Saved native Linear",
      parameters: {},
      credentials: { api_key: secret },
    });
    const connection = deviceConnection(saved.connectionId);
    if (!connection) throw new Error("Missing sealed native Linear connection");
    const requests = integration.requests.length;
    draw("linear", connection);
    expect(saved.configuration.method).toBe("api-key");
    expect(screen.getByLabelText("Linear API key")).toHaveProperty(
      "type",
      "password",
    );
    expect(screen.getByLabelText("Linear API key")).toHaveProperty("value", "");
    expect(screen.queryByLabelText("MCP authentication")).toBeNull();
    expect(document.body.textContent).not.toContain(secret);
    expect(integration.requests).toHaveLength(requests);
  });

  it("inherits advertised defaults while allowing shared callers to clear them", () => {
    connectorIntegration();
    const method = nativeSettingsDescriptor(provider("linear"))?.methods[0];
    if (!method) throw new Error("Actual Linear MCP descriptor required");
    expect(nativeScopeDefaults(method)).toEqual({ user: ["read"] });
    const plan = connectPlan("linear");
    if (!plan) throw new Error("Actual Linear plan required");
    for (const { defaults, expected } of [
      { defaults: undefined, expected: ["read"] },
      { defaults: [], expected: [] },
      { defaults: ["not-advertised"], expected: [] },
    ]) {
      const descriptor = nativeProviderDescriptor(plan, {
        callbackUrl: "https://app.example/auth/native-connector.html",
        apiKey: { available: false },
        oauth: { available: false },
        mcp: { available: true, actor: "user", defaultScopes: defaults },
      });
      const sharedMethod = descriptor.methods.find(
        (entry) => entry.id === "mcp",
      );
      if (!sharedMethod) throw new Error("Actual Linear MCP metadata required");
      expect(nativeScopeDefaults(sharedMethod)).toEqual({ user: expected });
      expect(
        sharedMethod.scopeGroups
          .flatMap((group) => group.choices)
          .some((choice) => choice.name === "not-advertised"),
      ).toBe(false);
    }
  });
});
