import { describe, expect, it } from "vitest";
import { isConnectionCatalogProvider } from "./catalog-provider.js";
import { connectPlan, isRefusedPlan } from "./connect-plan.js";
import {
  type ConnectorCardActionContext,
  connectorCardAction,
} from "./connector-action-capability.js";
import { getBundledProviders } from "./embedded-catalog.js";
import type { NativeConnectorView } from "./native-connector-view.js";
import { mergeVercelCatalog } from "./vercel-connect-catalog.js";
const NOW = 1000;
const provider = { id: "openrouter" };
const connection = {
  providerId: provider.id,
  connectionId: "native-openrouter",
  status: "active" as const,
};
function view(): NativeConnectorView {
  const fingerprint = "a".repeat(64);
  return {
    providerId: provider.id,
    connectionId: connection.connectionId,
    revision: 1,
    fingerprint,
    configuration: {
      version: 1,
      providerId: provider.id,
      method: "oauth",
      displayName: "OpenRouter",
      icon: "",
      parameters: {},
      requestedScopes: {},
      targetIds: {},
      fingerprint,
    },
    status: "connected",
    identity: {
      id: "verified-account",
      label: "Verified account",
      kind: "provider-account",
      assurance: "account-verified",
    },
    targets: [],
    grants: [
      {
        actor: "user",
        label: "Authorized user",
        permissionState: "provider-managed",
        grantedScopes: [],
        expiresAt: NOW + 1,
        needsReauth: false,
      },
    ],
    verifiedAt: NOW - 1,
    recovery: [],
  };
}
function context(
  overrides: Partial<ConnectorCardActionContext> = {},
): ConnectorCardActionContext {
  return { routes: [], now: NOW, ...overrides };
}
describe("connector card actions", () => {
  it("accepts a provider-verified Vault token that reports no account identity", () => {
    const record = view();
    record.providerId = record.configuration.providerId = "vault";
    record.configuration.method = "api-key";
    record.identity = null;
    const installed = { ...connection, providerId: "vault" };
    expect(
      connectorCardAction(
        { id: "vault" },
        context({ connection: installed, nativeView: record }),
      ).kind,
    ).toBe("configure");
    record.grants = [];
    expect(
      connectorCardAction(
        { id: "vault" },
        context({ connection: installed, nativeView: record }),
      ).kind,
    ).toBe("resume");
  });
  it("recognizes an actually verified MCP resource without inventing an account or credentials", () => {
    const method = connectPlan("notion")?.methods.find(
      (entry) => entry.kind === "mcp",
    );
    if (method?.kind !== "mcp" || method.mcp.status !== "ok")
      throw new Error("Expected published Notion resource");
    const resource = method.mcp.resource ?? method.mcp.url;
    const record = view();
    record.providerId = "notion";
    record.configuration.providerId = "notion";
    record.configuration.method = "mcp";
    record.configuration.parameters = { mcp_url: method.mcp.url };
    record.configuration.targetIds = { mcp: resource };
    record.targets = [{ id: resource, label: resource, kind: "mcp-resource" }];
    record.identity = null;
    record.grants = [];
    const stored = { ...connection, providerId: "notion" };
    expect(
      connectorCardAction(
        { id: "notion" },
        context({ connection: stored, nativeView: record }),
      ).kind,
    ).toBe("configure");
    const mutations: ((proof: NativeConnectorView) => void)[] = [
      (proof) => {
        proof.verifiedAt = null;
      },
      (proof) => {
        proof.targets = [];
      },
      (proof) => {
        proof.targets[0].kind = "configuration";
      },
      (proof) => {
        proof.targets[0].id = "https://different.example/mcp";
      },
      (proof) => {
        proof.configuration.targetIds.mcp = "https://different.example/mcp";
      },
      (proof) => {
        proof.configuration.parameters.mcp_url =
          "https://different.example/mcp";
      },
      (proof) => {
        proof.configuration.fingerprint = "c".repeat(64);
      },
      (proof) => {
        proof.status = "configuration";
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(record);
      mutate(changed);
      expect(
        connectorCardAction(
          { id: "notion" },
          context({ connection: stored, nativeView: changed }),
        ).kind,
      ).toBe("resume");
    }
  });
  it("offers Vault's approved OIDC login before a manually pasted token", () => {
    expect(
      connectorCardAction(
        { id: "vault" },
        context({
          routes: [
            { method: "api-key", available: true },
            { method: "oidc", available: true },
          ],
        }),
      ),
    ).toEqual({ kind: "connect", glyph: "plus", method: "oidc" });
  });
  it("does not advertise browser connection for any listed identity without an admitted route", () => {
    const providers = mergeVercelCatalog(getBundledProviders()).filter(
      isConnectionCatalogProvider,
    );
    expect(providers).toHaveLength(225);
    expect(new Set(providers.map((entry) => entry.id)).size).toBe(225);
    for (const entry of providers) {
      const action = connectorCardAction(
        entry,
        context({ routes: [], nativeRequired: true }),
      );
      expect(action.kind, entry.id).toBe(
        isRefusedPlan(entry.id) ? "unavailable" : "native",
      );
      expect(action.glyph, entry.id).not.toBe("plus");
      const saved = connectorCardAction(
        entry,
        context({
          routes: [],
          nativeRequired: true,
          connection: { ...connection, providerId: entry.id },
        }),
      );
      expect(saved.kind, entry.id).toBe(
        isRefusedPlan(entry.id) ? "unavailable" : "native",
      );
      expect(saved.glyph, entry.id).not.toBe("ellipsis");
    }
  });
  it("prefers actual provider consent over a credential field, independent of registry order", () => {
    expect(
      connectorCardAction(
        provider,
        context({
          routes: [
            { method: "api-key", available: true },
            { method: "mcp", available: true },
            { method: "oauth", available: true },
          ],
        }),
      ),
    ).toEqual({ kind: "connect", glyph: "plus", method: "oauth" });
  });
  it("does not turn unavailable OAuth or a missing driver into a connect button", () => {
    expect(
      connectorCardAction(
        { id: "google" },
        context({
          routes: [{ method: "oauth", available: false }],
          nativeRequired: true,
        }),
      ),
    ).toEqual({ kind: "native", glyph: "computer" });
    expect(connectorCardAction(provider, context())).toEqual({
      kind: "unavailable",
      glyph: "blocked",
    });
  });
  it("selects an admitted MCP route when the provider's REST OAuth is blocked", () => {
    expect(
      connectorCardAction(
        { id: "resend" },
        context({
          routes: [
            { method: "oauth", available: false },
            { method: "mcp", available: true },
          ],
        }),
      ),
    ).toEqual({ kind: "connect", glyph: "plus", method: "mcp" });
  });
  it("requires actual verified native access for the installed ellipsis", () => {
    expect(
      connectorCardAction(
        provider,
        context({ connection, nativeView: view() }),
      ),
    ).toEqual({
      kind: "configure",
      glyph: "ellipsis",
      connectionId: connection.connectionId,
    });
    expect(connectorCardAction(provider, context({ connection })).kind).toBe(
      "unavailable",
    );
    const draft = view();
    draft.status = "configuration";
    draft.verifiedAt = null;
    expect(
      connectorCardAction(provider, context({ connection, nativeView: draft }))
        .kind,
    ).toBe("resume");
  });
  it("refuses stale, expired, unbound, and mismatched installed proofs", () => {
    const mutations: ((record: NativeConnectorView) => void)[] = [
      (record) => {
        record.grants = [];
      },
      (record) => {
        record.recovery = [
          {
            id: "cleanup",
            kind: "revoke",
            label: "Cleanup",
            detail: "Cleanup",
          },
        ];
      },
      (record) => {
        record.verifiedAt = null;
      },
      (record) => {
        record.verifiedAt = Number.NaN;
      },
      (record) => {
        record.status = "reauthorize";
      },
      (record) => {
        record.providerId = "gitlab";
      },
      (record) => {
        record.configuration.providerId = "gitlab";
      },
      (record) => {
        record.connectionId = "other-connection";
      },
      (record) => {
        record.configuration.fingerprint = "b".repeat(64);
      },
      (record) => {
        record.grants[0].expiresAt = NOW;
      },
      (record) => {
        record.grants[0].needsReauth = true;
      },
    ];
    for (const mutate of mutations) {
      const record = view();
      mutate(record);
      expect(
        connectorCardAction(
          provider,
          context({ connection, nativeView: record }),
        ).kind,
      ).toBe("resume");
    }
  });
  it("does not let a specialized proof override a conflicting native record", () => {
    const record = view();
    record.status = "configuration";
    expect(
      connectorCardAction(
        provider,
        context({ connection, nativeView: record, specializedVerified: true }),
      ).kind,
    ).toBe("resume");
    expect(
      connectorCardAction(
        provider,
        context({ connection, specializedVerified: true }),
      ).kind,
    ).toBe("configure");
    expect(
      connectorCardAction(
        provider,
        context({
          connection: { ...connection, status: "expired" },
          specializedVerified: true,
        }),
      ).kind,
    ).toBe("resume");
  });
  it("does not confuse another provider or a revoked record with an installation", () => {
    const routes = [{ method: "oauth" as const, available: true }];
    expect(
      connectorCardAction(
        provider,
        context({
          routes,
          connection: { ...connection, providerId: "gitlab" },
        }),
      ).kind,
    ).toBe("connect");
    expect(
      connectorCardAction(
        provider,
        context({
          routes,
          connection: { ...connection, status: "revoked" },
          nativeView: view(),
        }),
      ).kind,
    ).toBe("connect");
  });
  it("keeps payment policy refusal even when a driver or saved record is supplied", () => {
    expect(
      connectorCardAction(
        { id: "stripe" },
        context({
          routes: [{ method: "oauth", available: true }],
          connection: { ...connection, providerId: "stripe" },
          specializedVerified: true,
          nativeRequired: true,
        }),
      ),
    ).toEqual({ kind: "unavailable", glyph: "blocked" });
  });
  it("represents outside-browser capability without inventing an installer", () => {
    expect(
      connectorCardAction(
        { id: "keychain" },
        context({ nativeRequired: true }),
      ),
    ).toEqual({ kind: "native", glyph: "computer" });
    const install = {
      kind: "pair" as const,
      href: "/settings/connections/tailscale",
      label: "Pair Tailscale daemon",
    };
    expect(
      connectorCardAction(
        { id: "tailscale" },
        context({ nativeInstall: install }),
      ),
    ).toEqual({ kind: "native", glyph: "computer", install });
    expect(
      connectorCardAction(
        provider,
        context({ nativeInstall: { ...install, href: "" } }),
      ).kind,
    ).toBe("unavailable");
  });
});
