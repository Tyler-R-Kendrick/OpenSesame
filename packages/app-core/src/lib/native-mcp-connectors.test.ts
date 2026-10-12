import { vi } from "vitest";
import { describe, expect, it } from "vitest";
import { readDeviceRows } from "./device-connector-records.js";
import { kvSeams } from "./kv.js";
import {
  removeNativeConnectorWithCleanup,
  retryNativeConnectorCleanup,
} from "./native-connector-lifecycle.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import {
  attestNativeMcpRevocation,
  nativeMcpRevocationInstructions,
} from "./native-mcp-attestation.js";
import {
  beginNativeMcpAuthorization,
  finishNativeMcpAuthorization,
} from "./native-mcp-authorization.js";
import { configureNativeMcpConnector } from "./native-mcp-config.js";
import {
  advertisedTool,
  installNativeMcpConnectorTests,
  mcpConnectorFixture,
} from "./native-mcp-connectors.test-support.js";
import {
  invokeNativeMcpTool,
  listNativeMcpTools,
} from "./native-mcp-operations.js";
import { MCP_CLASSIFICATION } from "./native-mcp-profile.js";
import { requireNativeMcpRecord } from "./native-mcp-records.js";
import { retryRetainedNativeMcpRegistration } from "./native-mcp-registration.js";
import { verifyNativeMcpConnector } from "./native-mcp-verification.js";
import { markNativeOAuthMutationInFlight } from "./native-oauth-session.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";

installNativeMcpConnectorTests();
function callback(id: string): string {
  const pending = requireNativeMcpRecord(id).privateState.pending.user;
  if (!pending) throw new Error("Expected sealed pending consent");
  return `?native_state=${pending.state}&native_code=actual-provider-code`;
}
async function authorized(
  options: Parameters<typeof mcpConnectorFixture>[0] = {},
) {
  const context = await mcpConnectorFixture(options);
  await beginNativeMcpAuthorization(context.id);
  await finishNativeMcpAuthorization(callback(context.id));
  return context;
}
describe("sealed native MCP connector lifecycle", () => {
  it("saves configuration without pretending it verified a provider", async () => {
    const context = await mcpConnectorFixture();
    expect(context.saved.status).toBe("configuration");
    expect(context.requests).toHaveLength(0);
    await expect(
      invokeNativeMcpTool(context.id, advertisedTool.name, { query: "query" }),
    ).rejects.toThrow();
  });
  it("seals real S256 consent, single-use callback and tokens, then verifies initialize and actual tools", async () => {
    const context = await mcpConnectorFixture();
    await beginNativeMcpAuthorization(context.id);
    const pending = requireNativeMcpRecord(context.id).privateState.pending
      .user;
    const url = new URL(context.navigate.mock.calls[0]?.[0] ?? "");
    expect(url.searchParams.get("state")).toBe(pending?.state);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(pending?.resource).toBe(url.searchParams.get("resource"));
    const query = callback(context.id);
    const view = await finishNativeMcpAuthorization(query);
    expect(view.status).toBe("connected");
    expect(view.identity).toBeNull();
    expect(context.methods).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    expect(JSON.stringify(view)).not.toContain("issued-access");
    expect(JSON.stringify(readDeviceRows())).not.toContain("rotated-refresh");
    expect(
      loadNativeConnectorRecord(context.id)?.privateState.grants.user
        .refreshToken,
    ).toBe("rotated-refresh");
    await expect(finishNativeMcpAuthorization(query)).rejects.toThrow();
  });
  it("invokes only actual advertised schemas and receives the real provider result", async () => {
    const context = await authorized();
    expect((await listNativeMcpTools(context.id)).tools).toEqual([
      advertisedTool,
    ]);
    await expect(
      invokeNativeMcpTool(context.id, "invented.tool", {}),
    ).rejects.toMatchObject({ code: "tool" });
    await expect(
      invokeNativeMcpTool(context.id, advertisedTool.name, { query: 3 }),
    ).rejects.toMatchObject({ code: "arguments" });
    const result = await invokeNativeMcpTool(context.id, advertisedTool.name, {
      query: "actual query",
    });
    expect(result.content).toEqual([
      { type: "text", text: "Actual provider tool result" },
    ]);
    expect(
      context.methods.filter((method) => method === "tools/call"),
    ).toHaveLength(1);
  });
  it("clears verified state after provider 401 without replaying a mutating tool", async () => {
    const context = await authorized({ unauthorized: true });
    await expect(
      invokeNativeMcpTool(context.id, advertisedTool.name, {
        query: "actual query",
      }),
    ).rejects.toMatchObject({ code: "authorization" });
    expect(readNativeConnector(context.id)?.status).toBe("reauthorize");
    expect(
      context.methods.filter((method) => method === "tools/call"),
    ).toHaveLength(1);
  });
  it("retains minted tokens for cleanup when the activation disappears during exchange", async () => {
    let disable: () => void = () => undefined;
    const context = await mcpConnectorFixture({ onToken: () => disable() });
    disable = context.disable;
    await beginNativeMcpAuthorization(context.id);
    await expect(
      finishNativeMcpAuthorization(callback(context.id)),
    ).rejects.toThrow();
    const record = requireNativeMcpRecord(context.id);
    expect(record.privateState.grants).toEqual({});
    expect(record.privateState.recovery[0]?.grant?.accessToken).toBe(
      "issued-access",
    );
    expect(readNativeConnector(context.id)?.status).toBe("cleanup");
    expect(context.methods).toEqual([]);
  });
  it("requires initialize/tools support rather than accepting successful metadata or token HTTP", async () => {
    const context = await mcpConnectorFixture({ noTools: true });
    await beginNativeMcpAuthorization(context.id);
    await expect(
      finishNativeMcpAuthorization(callback(context.id)),
    ).rejects.toMatchObject({ code: "response" });
    expect(readNativeConnector(context.id)?.status).toBe("cleanup");
  });
  it("refuses target replacement while sealed authorization exists", async () => {
    const context = await authorized();
    const current = requireNativeMcpRecord(context.id);
    await expect(
      configureNativeMcpConnector({
        ...context.draft,
        connectionId: context.id,
        revision: current.revision,
        parameters: { mcp_url: "https://other.example.org/mcp" },
      }),
    ).rejects.toThrow();
    expect(requireNativeMcpRecord(context.id).configuration.fingerprint).toBe(
      current.configuration.fingerprint,
    );
  });
  it("does not dispatch a tool after discovery changed the saved revision", async () => {
    let replace = false;
    let id = "";
    const context = await authorized({
      onList: async () => {
        if (!replace) return;
        const current = requireNativeMcpRecord(id);
        await updateNativeConnector(
          id,
          nativeOAuthGuard(current),
          MCP_CLASSIFICATION,
          (record) => {
            record.configuration.displayName = "Changed in another tab";
            return record;
          },
        );
      },
    });
    id = context.id;
    replace = true;
    await expect(
      invokeNativeMcpTool(id, advertisedTool.name, { query: "actual query" }),
    ).rejects.toThrow();
    expect(context.methods).not.toContain("tools/call");
  });
  it("verifies an anonymous resource through the protocol without fabricating credentials", async () => {
    const context = await mcpConnectorFixture();
    const view = await verifyNativeMcpConnector(context.id);
    expect(view.status).toBe("connected");
    expect(view.grants).toEqual([]);
    expect(view.identity).toBeNull();
    expect(requireNativeMcpRecord(context.id).privateState.grants).toEqual({});
    expect(
      context.requests.every(
        (request) => !request.headers.has("authorization"),
      ),
    ).toBe(true);
  });
  it("refreshes an expired actor only after journaling its actual rotated pair", async () => {
    const context = await authorized();
    const initial = requireNativeMcpRecord(context.id);
    await updateNativeConnector(
      context.id,
      nativeOAuthGuard(initial),
      MCP_CLASSIFICATION,
      (record) => {
        record.privateState.grants.user.expiresAt = 1;
        record.runtime.grants[0].expiresAt = 1;
        return record;
      },
    );
    const view = await verifyNativeMcpConnector(context.id);
    expect(view.status).toBe("connected");
    expect(requireNativeMcpRecord(context.id).privateState.recovery).toEqual(
      [],
    );
    const posts = context.requests.filter(
      (request) =>
        request.method === "POST" &&
        request.url !== initial.configuration.parameters.mcp_url,
    );
    const refreshed = await Promise.all(
      posts.map(async (request) =>
        new URLSearchParams(await request.text()).get("grant_type"),
      ),
    );
    expect(refreshed).toContain("refresh_token");
  });
  it("retains a DCR response across failed sealing and resumes consent without creating another registration", async () => {
    let fail = true;
    const context = await mcpConnectorFixture({
      onRegistration: () => {
        if (fail)
          vi.mocked(kvSeams.kvSetDurable).mockRejectedValueOnce(
            new Error("storage unavailable"),
          );
      },
    });
    await expect(beginNativeMcpAuthorization(context.id)).rejects.toThrow();
    expect(context.navigate).not.toHaveBeenCalled();
    fail = false;
    await retryRetainedNativeMcpRegistration(context.id);
    await beginNativeMcpAuthorization(context.id);
    expect(
      context.requests.filter((request) => request.url.endsWith("/register")),
    ).toHaveLength(1);
    expect(readNativeConnector(context.id)?.status).toBe("authorizing");
  });
  it("deletes the real registration on disconnect and removes its management token from public data", async () => {
    const context = await authorized({ management: true });
    expect(
      requireNativeMcpRecord(context.id).privateState.credentials.mcp_client,
    ).toContain("private-management-token");
    expect(JSON.stringify(readDeviceRows())).not.toContain(
      "private-management-token",
    );
    expect(await removeNativeConnectorWithCleanup(context.id)).toBe(true);
    const management = context.requests.filter(
      (request) => request.method === "DELETE",
    );
    expect(management).toHaveLength(1);
    expect(management[0]?.headers.get("authorization")).toBe(
      "Bearer private-management-token",
    );
    expect(readNativeConnector(context.id)).toBeNull();
  });
  it("keeps failed registration cleanup durable until the provider accepts a retry", async () => {
    const options = { management: true, deleteFailure: true };
    const context = await authorized(options);
    await expect(
      removeNativeConnectorWithCleanup(context.id),
    ).rejects.toThrow();
    expect(readNativeConnector(context.id)?.status).toBe("cleanup");
    expect(
      requireNativeMcpRecord(context.id).privateState.credentials.mcp_client,
    ).toContain("private-management-token");
    options.deleteFailure = false;
    await retryNativeConnectorCleanup(context.id);
    expect(requireNativeMcpRecord(context.id).privateState.recovery).toEqual(
      [],
    );
    expect(
      requireNativeMcpRecord(context.id).privateState.credentials.mcp_client,
    ).toBeUndefined();
  });
  it("rejects tool results that reflect a saved private token", async () => {
    const context = await authorized({ echoToken: true });
    await expect(
      invokeNativeMcpTool(context.id, advertisedTool.name, {
        query: "actual query",
      }),
    ).rejects.toMatchObject({ code: "response" });
  });
  it("offers explicit provider-side confirmation for an indeterminate exchange after its deadline", async () => {
    const context = await mcpConnectorFixture({ tokenFailure: true });
    await beginNativeMcpAuthorization(context.id);
    await expect(
      finishNativeMcpAuthorization(callback(context.id)),
    ).rejects.toThrow();
    const initial = requireNativeMcpRecord(context.id);
    const recoveryId = initial.privateState.recovery[0].id;
    expect(
      nativeMcpRevocationInstructions(context.id, recoveryId).canConfirm,
    ).toBe(false);
    await expect(
      attestNativeMcpRevocation(context.id, recoveryId),
    ).rejects.toThrow();
    await updateNativeConnector(
      context.id,
      nativeOAuthGuard(initial),
      MCP_CLASSIFICATION,
      (record) => {
        const entry = record.privateState.recovery[0];
        entry.credentials = { ...entry.credentials, deadline: "0" };
        return record;
      },
    );
    const instructions = nativeMcpRevocationInstructions(
      context.id,
      recoveryId,
    );
    expect(instructions.canConfirm).toBe(true);
    expect(instructions.message).toContain(
      "does not verify provider revocation",
    );
    const confirmed = await attestNativeMcpRevocation(context.id, recoveryId);
    expect(confirmed.status).toBe("configuration");
    expect(confirmed.verifiedAt).toBeNull();
    expect(confirmed.grants).toEqual([]);
    expect(requireNativeMcpRecord(context.id).privateState.recovery).toEqual(
      [],
    );
  });
  it("refuses human attestation while an already submitted credential mutation remains in flight", async () => {
    const context = await mcpConnectorFixture({ tokenFailure: true });
    await beginNativeMcpAuthorization(context.id);
    await expect(
      finishNativeMcpAuthorization(callback(context.id)),
    ).rejects.toThrow();
    const initial = requireNativeMcpRecord(context.id);
    const recoveryId = initial.privateState.recovery[0].id;
    await updateNativeConnector(
      context.id,
      nativeOAuthGuard(initial),
      MCP_CLASSIFICATION,
      (record) => {
        record.privateState.recovery[0].credentials = {
          deadline: "0",
          phase: "exchange",
        };
        return record;
      },
    );
    const release = markNativeOAuthMutationInFlight(context.id, recoveryId);
    try {
      await expect(
        attestNativeMcpRevocation(context.id, recoveryId),
      ).rejects.toThrow();
    } finally {
      release();
    }
    expect(
      nativeMcpRevocationInstructions(context.id, recoveryId).canConfirm,
    ).toBe(true);
  });
});
