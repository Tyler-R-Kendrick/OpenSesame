import { expect, it, vi } from "vitest";
import { kvSeams } from "./kv.js";
import { readNativeConnector } from "./native-connector-store.js";
import {
  beginNativeMcpAuthorization,
  finishNativeMcpAuthorization,
} from "./native-mcp-authorization.js";
import {
  installNativeMcpConnectorTests,
  mcpConnectorFixture,
} from "./native-mcp-connectors.test-support.js";
import { requireNativeMcpRecord } from "./native-mcp-records.js";
import { verifyNativeMcpConnector } from "./native-mcp-verification.js";
installNativeMcpConnectorTests();
function callback(id: string) {
  const pending = requireNativeMcpRecord(id).privateState.pending.user;
  if (!pending) throw new Error("Missing sealed consent");
  return `?native_state=${pending.state}&native_code=actual-provider-code`;
}
for (const mode of ["authorize", "verify"] as const) {
  it(`rejects ${mode} activation cancelled while its final durable commit is staged`, async () => {
    const context = await mcpConnectorFixture();
    await beginNativeMcpAuthorization(context.id);
    const query = callback(context.id);
    if (mode === "verify") await finishNativeMcpAuthorization(query);
    const previous = readNativeConnector(context.id);
    let resume: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const write = vi.spyOn(kvSeams, "kvSetDurable");
    const original = write.getMockImplementation();
    if (!original) throw new Error("Missing durable fixture store");
    write.mockImplementation(async (key, value, beforeCommit) => {
      if (beforeCommit) {
        entered();
        await blocked;
        beforeCommit();
      }
      await original(key, value, beforeCommit);
    });
    try {
      const attempt =
        mode === "verify"
          ? verifyNativeMcpConnector(context.id)
          : finishNativeMcpAuthorization(query);
      const rejected = expect(attempt).rejects.toThrow(
        "Disposed connector activation",
      );
      await reached;
      context.disable();
      resume();
      await rejected;
      const saved = readNativeConnector(context.id);
      expect(saved?.verifiedAt).toBe(previous?.verifiedAt);
      if (mode === "authorize") {
        expect(saved?.status).toBe("cleanup");
        expect(saved?.grants).toEqual([]);
        expect(
          requireNativeMcpRecord(context.id).privateState.recovery.some(
            (entry) => !!entry.grant?.accessToken,
          ),
        ).toBe(true);
      } else expect(saved?.status).toBe("connected");
    } finally {
      resume();
    }
  });
}
