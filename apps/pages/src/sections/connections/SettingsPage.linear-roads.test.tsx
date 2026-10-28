/** @vitest-environment jsdom */
import { initialDraftState } from "@opensesame/app-core/lib/connect-draft.js";
import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { saveSelfHostedConnector } from "@opensesame/app-core/lib/self-hosted-connectors.js";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  draw,
  nameAHostWithALiveGrant,
  provider,
} from "./SettingsPage.roads.test-support.js";
import { nativeSettingsDescriptor } from "./connect/NativeConnectorPanels.js";
import { connectorIntegration } from "./connect/native-connector-integration.test-support.js";

describe("Linear retains configuration while its native owner is inactive", () => {
  it("labels Azure family surfaces from bundled catalog aliases", () => {
    draw("azure-key-vault-secrets");
    const family = screen.getByRole("combobox", { name: "API family" });
    expect(family).toHaveProperty("value", "azure-sm");
    expect(
      within(family).getByRole("option", { name: "Azure Key Vault Secrets" }),
    ).toHaveProperty("value", "azure-sm");
    expect(
      within(family).getByRole("option", { name: "Azure App Configuration" }),
    ).toHaveProperty("value", "azure-ac");
  });

  it("keeps advanced configuration reachable without inventing an authorization owner", () => {
    draw("linear");
    expect(
      within(screen.getByRole("region", { name: "Connector" })).getByRole(
        "heading",
        {
          name: "2 Connect",
          level: 2,
        },
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Save configuration/ }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /Connect Linear/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Sign in to Linear" }),
    ).toBeNull();
    expect(
      screen.getByText("Advanced: existing OAuth app or API key"),
    ).toBeTruthy();
    expect(
      screen.getByRole("img", { name: "Not available here" }),
    ).toBeTruthy();
  });
});

describe("a named Host does not substitute for the native Linear owner", () => {
  it("retains configuration and still requires the actual activation for MCP authorization", () => {
    nameAHostWithALiveGrant();
    draw("linear");
    expect(
      within(screen.getByRole("region", { name: "Connector" })).getByRole(
        "heading",
        { name: "2 Connect", level: 2 },
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Connect Linear/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Authorize with Linear/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Sign in to Linear" }),
    ).toBeNull();
    expect(
      screen.getByText("Advanced: existing OAuth app or API key"),
    ).toBeTruthy();
    expect(
      screen.getByRole("img", { name: "Not available here" }),
    ).toBeTruthy();
  });
});

describe("Linear's top-level native settings route", () => {
  it("uses the common MCP form and retains advanced OAuth/key configuration when nativeExperience is true", async () => {
    const integration = connectorIntegration();
    const descriptor = nativeSettingsDescriptor(provider("linear"));
    expect(descriptor?.methods.map((method) => method.id)).toEqual(["mcp"]);
    expect(descriptor?.methods[0]?.available).toBe(true);
    draw("linear");
    expect(
      screen.getByRole("button", { name: "Sign in to Linear" }),
    ).toHaveProperty("disabled", false);
    expect(screen.getByLabelText("MCP permissions").textContent).toContain(
      "1 selected",
    );
    expect(screen.queryByLabelText("Linear OAuth client ID")).toBeNull();
    await userEvent.click(
      screen.getByText("Advanced: existing OAuth app or API key"),
    );
    expect(screen.getByLabelText("Linear OAuth client ID")).toBeTruthy();
    await userEvent.click(screen.getByRole("radio", { name: "API key" }));
    expect(screen.getByLabelText("Linear API key")).toHaveProperty(
      "type",
      "password",
    );
    expect(
      screen.getByRole("button", { name: "Verify and connect Linear" }),
    ).toHaveProperty("disabled", true);
    expect(screen.queryByLabelText("Vercel access token")).toBeNull();
    expect(integration.requests).toHaveLength(0);
  });

  it("keeps a saved specialized Linear record on its original custody page", async () => {
    const integration = connectorIntegration();
    const plan = connectPlan("linear");
    if (!plan) throw new Error("Actual Linear plan required");
    const connection = await saveSelfHostedConnector(
      plan,
      {
        ...initialDraftState(plan, "api-key"),
        name: "Saved Linear",
        key: "synthetic-config-only",
      },
      {
        mode: "byo",
        workspace: "configured-workspace",
        appScopes: [],
        userScopes: [],
        webhookResourceTypes: [],
        icon: "",
      },
    );
    draw("linear", connection);
    expect(connection.status).toBe("pending");
    const header = screen
      .getByRole("heading", { name: "Linear", level: 1 })
      .closest("header");
    if (!header) throw new Error("Missing actual Linear settings header");
    expect(within(header).getByRole("img", { name: "Needs you" })).toBeTruthy();
    expect(header.textContent).toContain(
      "Created, but nobody has approved it yet. Authorize it to finish.",
    );
    expect(
      within(header).queryByRole("img", { name: "Not connected" }),
    ).toBeNull();
    expect(screen.getByLabelText("Linear API key")).toHaveProperty(
      "type",
      "password",
    );
    expect(screen.getByText("Linear saved connection actions")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Sign in to Linear" }),
    ).toBeNull();
    expect(
      screen.queryByText("Advanced: existing OAuth app or API key"),
    ).toBeNull();
    expect(integration.requests).toHaveLength(0);
  });

  it.each(["api-key", "oauth"] as const)(
    "retains the original saved native %s descriptor",
    (method) => {
      const integration = connectorIntegration();
      expect(
        nativeSettingsDescriptor(provider("linear"), method)?.methods.map(
          (entry) => entry.id,
        ),
      ).toEqual([method]);
      expect(integration.requests).toHaveLength(0);
    },
  );

  it("removes MCP authorization availability when its original activation retires", () => {
    const integration = connectorIntegration();
    expect(
      nativeSettingsDescriptor(provider("linear"))?.methods[0]?.available,
    ).toBe(true);
    integration.activation.dispose();
    expect(
      nativeSettingsDescriptor(provider("linear"))?.methods[0]?.available,
    ).toBe(false);
    expect(integration.requests).toHaveLength(0);
  });
});
