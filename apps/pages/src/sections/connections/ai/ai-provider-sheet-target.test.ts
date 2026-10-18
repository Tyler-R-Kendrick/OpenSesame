/** @vitest-environment jsdom */
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { describe, expect, it } from "vitest";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "../connect/native-connector-integration.test-support.js";
import { aiProviderSheetTarget } from "./ai-provider-sheet-target.js";

installConnectorIntegration();

const provider = (id: string) => {
  const row = getBundledProviders().find((item) => item.id === id);
  if (!row) throw new Error(`no bundled row ${id}`);
  return row;
};
const open = {
  connections: [],
  connectionId: undefined,
  pathname: "/connections/xai",
};

describe("when a model provider opens the Add sheet", () => {
  it("opens for a first connection the browser can make", () => {
    connectorIntegration();
    const target = aiProviderSheetTarget({
      ...open,
      provider: provider("xai"),
    });
    expect(target?.provider.id).toBe("xai");
    expect(target?.method.id).toBe("api-key");
    expect(target?.method.fields.some((field) => field.secret)).toBe(true);
  });

  it("stays a page for a connection that exists, and for a revoked one it opens", () => {
    connectorIntegration();
    const xai = provider("xai");
    expect(
      aiProviderSheetTarget({
        ...open,
        provider: xai,
        connections: [{ status: "active" }],
      }),
    ).toBeNull();
    expect(
      aiProviderSheetTarget({
        ...open,
        provider: xai,
        connections: [{ status: "revoked" }],
      })?.provider.id,
    ).toBe("xai");
  });

  it("never opens for a connection the route names, or from Settings", () => {
    connectorIntegration();
    const xai = provider("xai");
    expect(
      aiProviderSheetTarget({ ...open, provider: xai, connectionId: "conn_1" }),
    ).toBeNull();
    expect(
      aiProviderSheetTarget({
        ...open,
        provider: xai,
        pathname: "/settings/connections/xai",
      }),
    ).toBeNull();
  });

  it("is only for model providers", () => {
    connectorIntegration();
    expect(
      aiProviderSheetTarget({
        ...open,
        provider: provider("github"),
        pathname: "/connections/github",
      }),
    ).toBeNull();
    expect(aiProviderSheetTarget({ ...open, provider: null })).toBeNull();
  });

  it("opens the configured NVIDIA API route without verifying or sending a key", () => {
    const runtime = connectorIntegration();
    const target = aiProviderSheetTarget({
      ...open,
      provider: provider("nvidia"),
      pathname: "/connections/nvidia",
    });
    expect(target?.provider.id).toBe("nvidia");
    expect(target?.method.id).toBe("api-key");
    expect(target?.method.available).toBe(true);
    expect(target?.method.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "api_key",
          secret: true,
          required: true,
        }),
      ]),
    );
    expect(runtime.requests).toEqual([]);
  });

  it("keeps providers without a configured API-key contract on their page", () => {
    connectorIntegration();
    for (const id of ["litellm", "google-vertex"]) {
      expect(
        aiProviderSheetTarget({
          ...open,
          provider: provider(id),
          pathname: `/connections/${id}`,
        }),
        id,
      ).toBeNull();
    }
  });
});
