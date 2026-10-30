import { describe, expect, it } from "vitest";
import { removeNativeConnectorWithCleanup } from "./native-connector-lifecycle.js";
import { updateNativeConnector } from "./native-connector-store.js";
import {
  beginNativeMcpAuthorization,
  finishNativeMcpAuthorization,
} from "./native-mcp-authorization.js";
import {
  installNativeMcpConnectorTests,
  mcpConnectorFixture,
} from "./native-mcp-connectors.test-support.js";
import { MCP_CLASSIFICATION } from "./native-mcp-profile.js";
import { requireNativeMcpRecord } from "./native-mcp-records.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";
installNativeMcpConnectorTests();
describe("MCP registration lifecycle", () => {
  it("retains a DCR registration lacking management credentials after revoking a grant", async () => {
    const context = await mcpConnectorFixture();
    await beginNativeMcpAuthorization(context.id);
    const pending = requireNativeMcpRecord(context.id).privateState.pending
      .user;
    await finishNativeMcpAuthorization(
      `?native_state=${pending.state}&native_code=actual-provider-code`,
    );
    await expect(
      removeNativeConnectorWithCleanup(context.id),
    ).rejects.toThrow();
    const record = requireNativeMcpRecord(context.id);
    expect(
      record.privateState.recovery.some(
        (entry) => entry.kind === "registration",
      ),
    ).toBe(true);
    expect(record.privateState.credentials.mcp_client).toBeTruthy();
  });
  it("revokes every token before deleting the DCR registration", async () => {
    const context = await mcpConnectorFixture({ management: true });
    await beginNativeMcpAuthorization(context.id);
    const pending = requireNativeMcpRecord(context.id).privateState.pending
      .user;
    await finishNativeMcpAuthorization(
      `?native_state=${pending.state}&native_code=actual-provider-code`,
    );
    const initial = requireNativeMcpRecord(context.id);
    const grant = initial.privateState.grants.user;
    await updateNativeConnector(
      context.id,
      nativeOAuthGuard(initial),
      MCP_CLASSIFICATION,
      (current) => {
        current.privateState.recovery.push({
          id: "extra-token-revoke",
          kind: "revoke",
          providerId: grant.providerId,
          actor: grant.actor,
          fingerprint: grant.fingerprint,
          targetId: grant.targetId ?? grant.resource ?? grant.providerId,
          grant,
          credentials: {
            mcp_client: current.privateState.credentials.mcp_client,
          },
        });
        return current;
      },
    );
    const before = context.requests.length;
    expect(await removeNativeConnectorWithCleanup(context.id)).toBe(true);
    const cleanup = context.requests
      .slice(before)
      .filter(
        (request) => request.method === "POST" || request.method === "DELETE",
      );
    expect(
      cleanup.filter((request) => request.method === "POST").length,
    ).toBeGreaterThanOrEqual(2);
    expect(cleanup.at(-1)?.method).toBe("DELETE");
  });
  it("forgets a CIMD-only client through the normal removal lifecycle", async () => {
    const context = await mcpConnectorFixture({ providerId: "airtable" });
    await beginNativeMcpAuthorization(context.id);
    expect(
      requireNativeMcpRecord(context.id).privateState.credentials
        .mcp_registration_mode,
    ).toBe("cimd");
    expect(await removeNativeConnectorWithCleanup(context.id)).toBe(true);
    expect(
      context.requests.filter((request) => request.method === "DELETE"),
    ).toHaveLength(0);
  });
  it("tracks a CIMD provider's live fallback to DCR and deletes that registration", async () => {
    const context = await mcpConnectorFixture({
      providerId: "airtable",
      management: true,
      liveMetadata: { client_id_metadata_document_supported: false },
    });
    await beginNativeMcpAuthorization(context.id);
    expect(
      requireNativeMcpRecord(context.id).privateState.credentials
        .mcp_registration_mode,
    ).toBe("dcr");
    expect(await removeNativeConnectorWithCleanup(context.id)).toBe(true);
    expect(
      context.requests.filter((request) => request.method === "DELETE"),
    ).toHaveLength(1);
  });
  it("retains a legacy client with unknown DCR provenance when deletion cannot be proved", async () => {
    const context = await mcpConnectorFixture();
    await beginNativeMcpAuthorization(context.id);
    const record = requireNativeMcpRecord(context.id);
    await updateNativeConnector(
      context.id,
      nativeOAuthGuard(record),
      MCP_CLASSIFICATION,
      (current) => {
        const { mcp_registration_mode: _removed, ...credentials } =
          current.privateState.credentials;
        current.privateState.credentials = credentials;
        return current;
      },
    );
    await expect(
      removeNativeConnectorWithCleanup(context.id),
    ).rejects.toThrow();
    const unresolved = requireNativeMcpRecord(context.id);
    expect(unresolved.privateState.credentials.mcp_client).toBeTruthy();
    expect(
      unresolved.privateState.recovery[0].credentials?.registration_mode,
    ).toBe("unknown");
  });
  it("forgets a sealed manual-only client through the removal lifecycle", async () => {
    const context = await mcpConnectorFixture({ providerId: "airtable" });
    await beginNativeMcpAuthorization(context.id);
    const record = requireNativeMcpRecord(context.id);
    await updateNativeConnector(
      context.id,
      nativeOAuthGuard(record),
      MCP_CLASSIFICATION,
      (current) => {
        current.privateState.credentials.mcp_registration_mode = "manual";
        return current;
      },
    );
    expect(await removeNativeConnectorWithCleanup(context.id)).toBe(true);
    expect(
      context.requests.filter((request) => request.method === "DELETE"),
    ).toHaveLength(0);
  });
});
