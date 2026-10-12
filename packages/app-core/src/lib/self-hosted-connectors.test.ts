import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialDraftState } from "./connect-draft.js";
import { connectPlan } from "./connect-plan.js";
import { catalogProvider } from "./connector-catalog.js";
import {
  readDeviceRows,
  readDeviceSecrets,
} from "./device-connector-records.js";
import {
  deviceConnection,
  listDeviceConnections,
  runFeatureConnector,
} from "./device-connectors.js";
import { featureRequest } from "./feature-request.js";
import { kvForgetAll } from "./kv.js";
import {
  type SelfHostedConnectorOptions,
  isSelfHostedConnector,
  readSelfHostedConnector,
  saveSelfHostedConnector,
  selfHostedConnectorProblems,
} from "./self-hosted-connectors.js";

const plan = connectPlan("linear");
if (!plan) throw new Error("Linear preset not found");
const linear = plan;
const options: SelfHostedConnectorOptions = {
  mode: "managed",
  workspace: "example-workspace",
  appScopes: ["read", "write"],
  userScopes: ["read"],
  webhookResourceTypes: ["Issue", "Comment"],
  icon: "",
};

function oauthState() {
  const state = initialDraftState(linear, "oauth");
  return {
    ...state,
    name: "My Linear connector",
    oauth: {
      ...state.oauth,
      clientId: "linear-client",
      clientSecret: "oauth-secret",
    },
  };
}

beforeEach(() => {
  kvForgetAll();
});

describe("self-hosted connector configuration", async () => {
  it("stores provider config locally without a Vercel request or exposed secrets", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const state = {
      ...oauthState(),
      key: "inactive-key",
      mcpClientSecret: "inactive-secret",
    };
    const connection = await saveSelfHostedConnector(linear, state, options);
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
    expect(connection.providerId).toBe("linear");
    expect(connection.status).toBe("pending");
    expect(connection.grantedScopes).toEqual([]);
    expect(connection.statusDetail).toContain("authorization required");
    expect(JSON.stringify(readDeviceRows())).not.toContain("oauth-secret");
    expect(JSON.stringify(readDeviceRows())).not.toContain("inactive-key");
    expect(JSON.stringify(readDeviceRows())).not.toContain("inactive-secret");
    expect(readDeviceSecrets()[connection.connectionId]).toEqual({
      oauth_client_secret: "oauth-secret",
    });
    const held = readSelfHostedConnector(connection.connectionId);
    expect(held?.options).toEqual(options);
    expect(held?.state.oauth.clientSecret).toBe("");
    expect(held?.state.key).toBe("");
    expect(held?.state.mcpClientSecret).toBe("");
    expect(held?.hasCredential).toBe(true);
    expect(isSelfHostedConnector(connection)).toBe(true);
    expect(deviceConnection(connection.connectionId)?.status).toBe("pending");
    expect(listDeviceConnections()[0]?.status).toBe("pending");
  });

  it("updates the same row and preserves blank sealed credentials", async () => {
    const created = await saveSelfHostedConnector(
      linear,
      oauthState(),
      options,
    );
    const held = readSelfHostedConnector(created.connectionId);
    if (!held) throw new Error("Saved configuration missing");
    const updatedState = { ...held.state, name: "Renamed Linear" };
    expect(
      selfHostedConnectorProblems(
        linear,
        updatedState,
        held.options,
        created.connectionId,
      ),
    ).toEqual([]);
    const updated = await saveSelfHostedConnector(
      linear,
      updatedState,
      held.options,
      created.connectionId,
    );
    expect(updated.connectionId).toBe(created.connectionId);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.displayName).toBe("Renamed Linear");
    expect(listDeviceConnections()).toHaveLength(1);
    expect(readDeviceSecrets()[created.connectionId]).toEqual({
      oauth_client_secret: "oauth-secret",
    });
  });

  it("replaces incompatible secrets when changing the authentication method", async () => {
    const created = await saveSelfHostedConnector(
      linear,
      oauthState(),
      options,
    );
    const state = {
      ...oauthState(),
      method: "api-key" as const,
      key: "linear-api-key",
      serviceUrls: ["https://api.linear.app/graphql"],
    };
    const updated = await saveSelfHostedConnector(
      linear,
      state,
      { ...options, mode: "byo" },
      created.connectionId,
    );
    expect(updated.requestedScopes).toEqual([]);
    expect(readDeviceSecrets()[created.connectionId]).toEqual({
      api_key: "linear-api-key",
    });
    expect(JSON.stringify(readDeviceRows())).not.toContain("linear-api-key");
    const held = readSelfHostedConnector(created.connectionId);
    expect(held?.state.key).toBe("");
    expect(held?.hasCredential).toBe(true);
  });

  it("requires a fresh confidential credential when the client or token endpoint changes", async () => {
    const created = await saveSelfHostedConnector(
      linear,
      oauthState(),
      options,
    );
    const state = oauthState();
    state.oauth.clientSecret = "";
    state.oauth.clientId = "different-client";
    expect(
      selfHostedConnectorProblems(linear, state, options, created.connectionId),
    ).toContain("Enter your provider OAuth client secret");
    state.oauth.clientId = "linear-client";
    state.oauth.tokenEndpoint = "https://other.example/token";
    expect(
      selfHostedConnectorProblems(
        linear,
        state,
        { ...options, mode: "byo" },
        created.connectionId,
      ),
    ).toContain("Enter your provider OAuth client secret");
  });

  it("preserves a sealed credential when switching configuration mode for the same app", async () => {
    const created = await saveSelfHostedConnector(
      linear,
      oauthState(),
      options,
    );
    const held = readSelfHostedConnector(created.connectionId);
    if (!held) throw new Error("Saved configuration missing");
    for (const mode of ["byo", "managed"] as const) {
      const nextOptions = { ...options, mode };
      expect(
        selfHostedConnectorProblems(
          linear,
          held.state,
          nextOptions,
          created.connectionId,
        ),
      ).toEqual([]);
      await saveSelfHostedConnector(
        linear,
        held.state,
        nextOptions,
        created.connectionId,
      );
      expect(readDeviceSecrets()[created.connectionId]).toEqual({
        oauth_client_secret: "oauth-secret",
      });
      expect(
        readSelfHostedConnector(created.connectionId)?.state.oauth.clientSecret,
      ).toBe("");
    }
  });

  it("refuses to execute configuration as a provider authorization", async () => {
    const provider = catalogProvider(linear.id);
    if (!provider) throw new Error("Linear provider missing");
    await saveSelfHostedConnector(linear, oauthState(), options);
    expect(runFeatureConnector(provider)).toEqual({
      ok: false,
      providerId: linear.id,
    });
    expect(featureRequest(provider)).toEqual({
      ok: false,
      providerId: linear.id,
    });
  });

  it("preserves MCP secrets after unrelated OAuth draft edits, but clears them for a new MCP client", async () => {
    const mcpPlan = {
      ...linear,
      methods: [
        ...linear.methods.filter((method) => method.kind !== "mcp"),
        {
          kind: "mcp" as const,
          mcp: {
            status: "no_metadata" as const,
            url: "https://mcp.example.com/",
          },
        },
      ],
    };
    const state = {
      ...initialDraftState(mcpPlan, "mcp"),
      mcpClientId: "mcp-client",
      mcpClientSecret: "mcp-secret",
    };
    const byo = { ...options, mode: "byo" as const };
    const created = await saveSelfHostedConnector(mcpPlan, state, byo);
    const held = readSelfHostedConnector(created.connectionId);
    if (!held) throw new Error("Saved configuration missing");
    const edited = {
      ...held.state,
      oauth: {
        ...held.state.oauth,
        clientId: "unrelated-oauth-client",
        serverUrl: "https://unrelated.example/",
        tokenEndpoint: "https://unrelated.example/token",
      },
    };
    await saveSelfHostedConnector(mcpPlan, edited, byo, created.connectionId);
    expect(readDeviceSecrets()[created.connectionId]).toEqual({
      mcp_client_secret: "mcp-secret",
    });
    expect(JSON.stringify(readDeviceRows())).not.toContain("mcp-secret");
    await saveSelfHostedConnector(
      mcpPlan,
      { ...edited, mcpClientId: "different-mcp-client" },
      byo,
      created.connectionId,
    );
    expect(readDeviceSecrets()[created.connectionId]).toBeUndefined();
  });

  it("saves unknown MCP authorization metadata as pending configuration", async () => {
    const mcpPlan = {
      ...linear,
      methods: [
        ...linear.methods.filter((method) => method.kind !== "mcp"),
        {
          kind: "mcp" as const,
          mcp: {
            status: "no_metadata" as const,
            url: "https://mcp.example.com/",
          },
        },
      ],
    };
    const state = initialDraftState(mcpPlan, "mcp");
    expect(state.mcpClientId).toBe("");
    const saved = await saveSelfHostedConnector(mcpPlan, state, {
      ...options,
      mode: "byo",
    });
    expect(saved.status).toBe("pending");
    expect(saved.grantedScopes).toEqual([]);
  });

  it("does not publish inactive OAuth scopes for an MCP configuration", async () => {
    const mcpPlan = {
      ...linear,
      methods: [
        ...linear.methods,
        {
          kind: "mcp" as const,
          mcp: {
            status: "no_metadata" as const,
            url: "https://mcp.example.com/",
          },
        },
      ],
    };
    const state = {
      ...oauthState(),
      method: "mcp" as const,
      mcpClientId: "mcp-client",
      mcpRegistration: "manual" as const,
    };
    const connection = await saveSelfHostedConnector(mcpPlan, state, {
      ...options,
      mode: "byo",
    });
    expect(connection.requestedScopes).toEqual([]);
  });

  it("rejects bare managed services and unresolved or insecure endpoints", async () => {
    await expect(
      saveSelfHostedConnector(
        linear,
        initialDraftState(linear, "managed"),
        options,
      ),
    ).rejects.toThrow("supported OAuth");
    const state = oauthState();
    state.oauth.tokenEndpoint = "http://api.linear.app/token";
    await expect(
      saveSelfHostedConnector(linear, state, options),
    ).rejects.toThrow("HTTPS OAuth");
    state.oauth.tokenEndpoint = "https://{domain}/token";
    await expect(
      saveSelfHostedConnector(linear, state, options),
    ).rejects.toThrow("HTTPS OAuth");
    expect(listDeviceConnections()).toHaveLength(0);
  });

  it("rejects unknown updates instead of silently creating duplicates", async () => {
    await expect(
      saveSelfHostedConnector(linear, oauthState(), options, "device-missing"),
    ).rejects.toThrow("Saved connector not found");
    expect(listDeviceConnections()).toHaveLength(0);
  });

  it("requires provider metadata fields and supported selections", async () => {
    expect(
      selfHostedConnectorProblems(linear, oauthState(), {
        ...options,
        workspace: "",
      }),
    ).toContain("Enter your provider workspace");
    expect(
      selfHostedConnectorProblems(linear, oauthState(), {
        ...options,
        appScopes: ["invented:scope"],
      }),
    ).toContain("Select supported app scopes for this provider");
    expect(
      selfHostedConnectorProblems(linear, oauthState(), {
        ...options,
        webhookResourceTypes: ["Secret"],
      }),
    ).toContain("Select supported webhook resource types for this provider");
    expect(listDeviceConnections()).toHaveLength(0);
  });

  it("does not preserve an OAuth secret when changing to a public client", async () => {
    const connection = await saveSelfHostedConnector(
      linear,
      oauthState(),
      options,
    );
    const state = oauthState();
    state.oauth.tokenAuth = "none";
    state.oauth.clientSecret = "";
    await saveSelfHostedConnector(
      linear,
      state,
      options,
      connection.connectionId,
    );
    expect(readDeviceSecrets()[connection.connectionId]).toBeUndefined();
    expect(
      readSelfHostedConnector(connection.connectionId)?.hasCredential,
    ).toBe(false);
  });
});
