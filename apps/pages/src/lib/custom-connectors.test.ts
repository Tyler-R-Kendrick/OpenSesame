import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authKindLabel } from "../sections/connections/CatalogPanel.js";
import { ConnectionsError, type Provider } from "./connections.js";
import {
  addCustomConnector,
  clearCustomConnectors,
  customConnectorSeams,
  listCustomConnectors,
  mergeCustomConnectors,
  removeCustomConnector,
} from "./custom-connectors.js";
import { kvDelete, kvSet } from "./kv.js";
import { isManagedConnector } from "./managed-connectors.js";

const originalCreate = customConnectorSeams.createRemote;
const originalDelete = customConnectorSeams.deleteRemote;

beforeEach(() => {
  customConnectorSeams.createRemote = vi
    .fn()
    .mockImplementation(async (input) => ({
      id: input.id,
    }));
  customConnectorSeams.deleteRemote = vi.fn().mockResolvedValue(undefined);
});

afterEach(() => {
  customConnectorSeams.createRemote = originalCreate;
  customConnectorSeams.deleteRemote = originalDelete;
  clearCustomConnectors();
  kvDelete("custom-connectors.v1");
});

describe("managed vs user-owned connectors", () => {
  it("labels Vercel managed connectors as Managed", () => {
    expect(isManagedConnector("slack")).toBe(true);
    expect(isManagedConnector("github")).toBe(true);
    expect(isManagedConnector("custom-acme")).toBe(false);
    expect(
      authKindLabel({
        id: "slack",
        authKind: "oauth2_authorization_code",
      } as Provider),
    ).toBe("Managed");
    expect(
      authKindLabel({ id: "custom-acme", authKind: "api_key" } as Provider),
    ).toBe("API key");
    expect(
      authKindLabel({
        id: "custom-oauth",
        authKind: "oauth2_authorization_code",
      } as Provider),
    ).toBe("OAuth");
  });

  it("stores and lists user-owned API key and OAuth connectors", async () => {
    customConnectorSeams.createRemote = vi
      .fn()
      .mockRejectedValue(
        new ConnectionsError(
          0,
          "unreachable",
          "Couldn't reach the connected service.",
        ),
      );
    const oauth = await addCustomConnector({
      id: "custom-acme",
      displayName: "Acme",
      baseUrl: "https://mcp.acme.dev",
      auth: {
        kind: "oauth2_authorization_code",
        authorizeUrl: "https://mcp.acme.dev/oauth/authorize",
        tokenUrl: "https://mcp.acme.dev/oauth/token",
        supportsRefresh: true,
        scopes: ["tools:read"],
      },
    });
    const key = await addCustomConnector({
      id: "custom-internal",
      displayName: "Internal API",
      baseUrl: "https://api.internal.dev",
      auth: {
        kind: "api_key",
        header: "Authorization",
        valuePrefix: "Bearer ",
      },
    });
    expect(oauth.authKind).toBe("oauth2_authorization_code");
    expect(oauth.configured).toBe(false);
    expect(key.authKind).toBe("api_key");
    expect(key.configured).toBe(false);
    expect(listCustomConnectors().map((row) => row.id)).toEqual([
      "custom-acme",
      "custom-internal",
    ]);
    const merged = mergeCustomConnectors([
      { id: "slack", displayName: "Slack" } as Provider,
    ]);
    expect(merged.map((row) => row.id)).toEqual([
      "slack",
      "custom-acme",
      "custom-internal",
    ]);
    await removeCustomConnector("custom-acme");
    expect(listCustomConnectors().map((row) => row.id)).toEqual([
      "custom-internal",
    ]);
  });

  it("refuses a duplicate custom connector id", async () => {
    customConnectorSeams.createRemote = vi
      .fn()
      .mockResolvedValue({ id: "custom-acme" });
    await addCustomConnector({
      id: "custom-acme",
      displayName: "Acme",
      baseUrl: "https://mcp.acme.dev",
      auth: {
        kind: "api_key",
        header: "Authorization",
        valuePrefix: "Bearer ",
      },
    });
    await expect(
      addCustomConnector({
        id: "custom-acme",
        displayName: "Acme 2",
        baseUrl: "https://mcp.acme.dev",
        auth: {
          kind: "api_key",
          header: "Authorization",
          valuePrefix: "Bearer ",
        },
      }),
    ).rejects.toThrow(/already exists/);
  });

  it("ignores stored rows that are not https origins", () => {
    kvSet(
      "custom-connectors.v1",
      JSON.stringify([
        {
          id: "custom-bad",
          displayName: "Bad",
          baseUrl: "http://evil.test",
          auth: { kind: "api_key", header: "Authorization", valuePrefix: "" },
        },
        {
          id: "custom-ok",
          displayName: "Ok",
          baseUrl: "https://ok.test",
          auth: { kind: "api_key", header: "Authorization", valuePrefix: "" },
        },
      ]),
    );
    clearCustomConnectors();
    expect(listCustomConnectors().map((row) => row.id)).toEqual(["custom-ok"]);
  });
});
