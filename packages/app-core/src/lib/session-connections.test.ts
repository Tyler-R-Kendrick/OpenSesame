/**
 * What a device may be offered of the app's connections, and what it gets back
 * (ADR 0196): a closed table of read-only operations, nothing a driver kept
 * for itself, and a store read afresh on every call.
 */
import { describe, expect, it, vi } from "vitest";
import type { Connection } from "./connections.js";
import { InvalidCall } from "./live/connection-port.js";
import type { NativeConnectorView } from "./native-connector-view.js";
import {
  type SessionConnectionSources,
  nativeOperations,
  sessionConnectionPort,
} from "./session-connections.js";

function connection(
  id: string,
  providerId: string,
  over: Partial<Connection> = {},
): Connection {
  return {
    connectionId: id,
    connectionRef: `local/connector/${id}`,
    logicalName: id,
    displayName: `${providerId} (${id})`,
    providerId,
    integrationId: null,
    status: "active",
    statusDetail: null,
    organizationId: "local",
    projectId: null,
    ownerKind: "user",
    shareability: "private",
    requestedScopes: [],
    grantedScopes: [],
    accountLabel: null,
    expiresAt: null,
    refreshable: false,
    lastRefreshedAt: null,
    maxInvokeLevel: 0,
    egress: { scheme: "none", authorities: [], pathPrefixes: [] },
    bindings: [],
    createdAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T00:00:00.000Z",
    ...over,
  };
}

function view(
  id: string,
  providerId: string,
  method: NativeConnectorView["configuration"]["method"] = "api-key",
  over: Partial<NativeConnectorView> = {},
): NativeConnectorView {
  const fingerprint = "a".repeat(64);
  return {
    providerId,
    connectionId: id,
    revision: 1,
    fingerprint,
    configuration: {
      version: 1,
      providerId,
      method,
      displayName: providerId,
      icon: "",
      parameters: {},
      requestedScopes: {},
      targetIds: {},
      fingerprint,
    },
    status: "connected",
    identity: null,
    targets: [],
    grants: [],
    verifiedAt: 1,
    recovery: [],
    ...over,
  };
}

type World = {
  connections: Connection[];
  views: Record<string, NativeConnectorView>;
  invoked: [string, string][];
};

function world(entries: [Connection, NativeConnectorView | null][]) {
  const held: World = { connections: [], views: {}, invoked: [] };
  for (const [made, native] of entries) {
    held.connections.push(made);
    if (native) held.views[made.connectionId] = native;
  }
  const sources: SessionConnectionSources = {
    connections: () => held.connections,
    native: (id) => held.views[id] ?? null,
    allowed: () => true,
    invokeNative: async (native, operation) => {
      held.invoked.push([native.connectionId, operation]);
      return {
        label: "Account verified",
        items: [
          {
            id: "user",
            label: "ada",
            url: "https://x.test/ada",
            // What a driver keeps for itself must not get through.
            ...{ secretValue: "hunter2", inputSchema: "{}" },
          },
        ],
      };
    },
    invokeLinear: vi.fn(async () => ({ label: "Linear issues", items: [] })),
  };
  return { held, sources, port: sessionConnectionPort(sources) };
}

const NEVER = new AbortController().signal;
const call = (connectionId: string, operation: string, input = {}) => ({
  connection: connectionId,
  operation,
  input,
  signal: NEVER,
});

describe("which operations a native connection offers", () => {
  it("is the account read for most, with the provider's own listing beside it", () => {
    const ops = (
      providerId: string,
      method: NativeConnectorView["configuration"]["method"] = "api-key",
    ) => nativeOperations(view("c", providerId, method));
    expect(ops("openrouter")).toEqual(["provider.read"]);
    expect(ops("github")).toEqual([
      "provider.read",
      "provider.repositories.read",
    ]);
    expect(ops("codeberg", "oauth")).toEqual([
      "provider.read",
      "provider.repositories.read",
    ]);
    expect(ops("s3")).toEqual(["provider.read", "provider.objects.read"]);
  });

  it("lists an MCP server's tools and calls none of them", () => {
    expect(nativeOperations(view("c", "linear-mcp", "mcp"))).toEqual([
      "mcp.tools.list",
    ]);
  });

  it("offers a Discord server list only with the permission to read it", () => {
    const grant = (grantedScopes: string[]) => ({
      actor: "user",
      label: "me",
      permissionState: "known" as const,
      grantedScopes,
      expiresAt: null,
      needsReauth: false,
    });
    expect(
      nativeOperations(
        view("c", "discord", "oauth", { grants: [grant(["identify"])] }),
      ),
    ).toEqual(["provider.read"]);
    expect(
      nativeOperations(
        view("c", "discord", "oauth", { grants: [grant(["guilds"])] }),
      ),
    ).toEqual(["provider.read", "provider.guilds.read"]);
  });

  it("never names an operation that reads a secret", () => {
    for (const provider of ["vault", "openbao", "github", "s3", "discord"])
      for (const method of ["api-key", "oauth", "mcp", "oidc"] as const)
        for (const operation of nativeOperations(view("c", provider, method)))
          expect(operation).not.toMatch(/secret/);
  });
});

describe("the connections offered", () => {
  it("offers connected native connections and an active Linear one", () => {
    const { port } = world([
      [connection("c-gh", "github"), view("c-gh", "github")],
      [connection("c-lin", "linear"), null],
    ]);
    expect(port.list()).toEqual([
      {
        id: "c-gh",
        label: "github (c-gh)",
        provider: "github",
        operations: ["provider.read", "provider.repositories.read"],
      },
      {
        id: "c-lin",
        label: "linear (c-lin)",
        provider: "linear",
        operations: ["issues.list", "projects.list", "teams.list"],
      },
    ]);
  });

  it("does not offer what is not usable", () => {
    const { port, held, sources } = world([
      [
        connection("c-wait", "github"),
        view("c-wait", "github", "api-key", { status: "reauthorize" }),
      ],
      [
        connection("c-cfg", "github"),
        view("c-cfg", "github", "api-key", { status: "configuration" }),
      ],
      [connection("c-lin", "linear", { status: "pending" }), null],
      [connection("c-other", "openai"), null],
      [connection("c-ok", "github"), view("c-ok", "github")],
    ]);
    expect(port.list().map((entry) => entry.id)).toEqual(["c-ok"]);
    // Nor where this browser may not use the method.
    const refused = sessionConnectionPort({ ...sources, allowed: () => false });
    expect(refused.list().map((entry) => entry.id)).toEqual([]);
    expect(held.invoked).toEqual([]);
  });

  it("reads the stores afresh each time", () => {
    const { port, held } = world([
      [connection("c-gh", "github"), view("c-gh", "github")],
    ]);
    expect(port.list()).toHaveLength(1);
    held.connections = [];
    expect(port.list()).toEqual([]);
  });
});

describe("a call through the port", () => {
  it("returns lines with nothing a driver kept for itself", async () => {
    const { port, held } = world([
      [connection("c-gh", "github"), view("c-gh", "github")],
    ]);
    const result = await port.invoke(call("c-gh", "provider.read"));
    expect(result).toEqual({
      label: "Account verified",
      items: [{ id: "user", label: "ada", url: "https://x.test/ada" }],
    });
    expect(JSON.stringify(result)).not.toMatch(/hunter2|inputSchema/);
    expect(held.invoked).toEqual([["c-gh", "provider.read"]]);
  });

  it("refuses an operation that is not on its table, a secret read among them", async () => {
    const { port, held } = world([
      [connection("c-gh", "github"), view("c-gh", "github")],
    ]);
    for (const operation of [
      "provider.secret.read",
      "provider.objects.read",
      "provider.delete",
      "provider.repositories.write",
      "mcp.tool:anything",
    ])
      await expect(port.invoke(call("c-gh", operation))).rejects.toThrow();
    expect(held.invoked).toEqual([]);
  });

  it("refuses a connection it does not offer, and input nothing takes", async () => {
    const { port, held } = world([
      [connection("c-gh", "github"), view("c-gh", "github")],
    ]);
    await expect(
      port.invoke(call("c-none", "provider.read")),
    ).rejects.toThrow();
    await expect(
      port.invoke(call("c-gh", "provider.read", { mount: "secret" })),
    ).rejects.toBeInstanceOf(InvalidCall);
    expect(held.invoked).toEqual([]);
  });

  it("refuses a connection that stopped being usable since it was granted", async () => {
    const { port, held } = world([
      [connection("c-gh", "github"), view("c-gh", "github")],
    ]);
    held.views["c-gh"] = view("c-gh", "github", "api-key", {
      status: "reauthorize",
    });
    await expect(port.invoke(call("c-gh", "provider.read"))).rejects.toThrow();
  });

  it("stops waiting for work that cannot be stopped when the call is aborted", async () => {
    const { sources } = world([
      [connection("c-gh", "github"), view("c-gh", "github")],
    ]);
    const stuck = sessionConnectionPort({
      ...sources,
      invokeNative: () => new Promise(() => undefined),
    });
    const controller = new AbortController();
    const running = stuck.invoke({
      ...call("c-gh", "provider.read"),
      signal: controller.signal,
    });
    controller.abort();
    await expect(running).rejects.toThrow("aborted");
    await expect(
      stuck.invoke({
        ...call("c-gh", "provider.read"),
        signal: controller.signal,
      }),
    ).rejects.toThrow("aborted");
  });

  it("runs a Linear read through Linear's own operations", async () => {
    const { port, sources } = world([[connection("c-lin", "linear"), null]]);
    await port.invoke(call("c-lin", "teams.list"));
    expect(sources.invokeLinear).toHaveBeenCalledWith("c-lin", "teams.list");
    await expect(port.invoke(call("c-lin", "issue.create"))).rejects.toThrow();
    expect(sources.invokeLinear).toHaveBeenCalledTimes(1);
  });
});
