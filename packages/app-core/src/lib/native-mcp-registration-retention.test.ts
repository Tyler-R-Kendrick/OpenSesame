import { describe, expect, it, vi } from "vitest";
import { kvSeams } from "./kv.js";
import { removeNativeConnectorWithCleanup } from "./native-connector-lifecycle.js";
import { NativePrivateSchema } from "./native-connector-schema.js";
import { readNativeConnector } from "./native-connector-store.js";
import { beginNativeMcpAuthorization } from "./native-mcp-authorization.js";
import {
  installNativeMcpConnectorTests,
  mcpConnectorFixture,
} from "./native-mcp-connectors.test-support.js";
import { requireNativeMcpRecord } from "./native-mcp-records.js";
import { retryRetainedNativeMcpRegistration } from "./native-mcp-registration.js";

installNativeMcpConnectorTests();

/** The durable write rejects once, after the registration's record encoded. */
function failNextWrite(): void {
  vi.mocked(kvSeams.kvSetDurable).mockRejectedValueOnce(
    new Error("storage unavailable"),
  );
}
/** A transient write failure strands a minted registration in memory. */
async function strandedRegistration(management = false) {
  let fail = true;
  const context = await mcpConnectorFixture({
    management,
    onRegistration: () => {
      if (fail) failNextWrite();
      fail = false;
    },
  });
  await expect(beginNativeMcpAuthorization(context.id)).rejects.toMatchObject({
    code: "storage",
  });
  expect(requireNativeMcpRecord(context.id).privateState.recovery).toEqual([
    expect.objectContaining({ kind: "registration" }),
  ]);
  return context;
}
/** The sealed record refuses any copy of the registration it would carry. */
function refuseSealedRegistration() {
  const parse = NativePrivateSchema.parse;
  return vi.spyOn(NativePrivateSchema, "parse").mockImplementation((state) => {
    if (JSON.stringify(state).includes('"mcp_client"'))
      throw new Error("sealed slot rejected the record");
    return parse(state);
  });
}
function registrations(context: { requests: Request[] }): Request[] {
  return context.requests.filter(
    (request) => request.method === "POST" && request.url.endsWith("/register"),
  );
}

describe("a retained MCP registration that did not seal", () => {
  it("keeps the registration through repeated storage failures and seals the same one", async () => {
    const context = await strandedRegistration();
    failNextWrite();
    await expect(
      retryRetainedNativeMcpRegistration(context.id),
    ).rejects.toMatchObject({ code: "storage" });
    expect(
      requireNativeMcpRecord(context.id).privateState.recovery,
    ).toHaveLength(1);
    await retryRetainedNativeMcpRegistration(context.id);
    await beginNativeMcpAuthorization(context.id);
    expect(registrations(context)).toHaveLength(1);
    expect(readNativeConnector(context.id)?.status).toBe("authorizing");
  });

  it("deletes the stranded registration through its management receipt on removal", async () => {
    const context = await strandedRegistration(true);
    expect(await removeNativeConnectorWithCleanup(context.id)).toBe(true);
    const deletions = context.requests.filter(
      (request) => request.method === "DELETE",
    );
    expect(deletions).toHaveLength(1);
    expect(deletions[0]?.headers.get("authorization")).toBe(
      "Bearer private-management-token",
    );
    expect(registrations(context)).toHaveLength(1);
    expect(readNativeConnector(context.id)).toBeNull();
  });

  it("retains the obligation when a minted registration cannot be sealed", async () => {
    const context = await strandedRegistration();
    refuseSealedRegistration();
    await expect(
      retryRetainedNativeMcpRegistration(context.id),
    ).rejects.toMatchObject({ code: "metadata" });
    expect(
      requireNativeMcpRecord(context.id).privateState.recovery,
    ).toHaveLength(1);
    await expect(removeNativeConnectorWithCleanup(context.id)).rejects.toThrow(
      "Provider cleanup failed",
    );
    expect(
      requireNativeMcpRecord(context.id).privateState.recovery,
    ).toHaveLength(1);
    expect(readNativeConnector(context.id)).not.toBeNull();
  });
});
