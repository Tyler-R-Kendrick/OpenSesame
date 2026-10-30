import { describe, expect, it } from "vitest";
import { lockManager } from "../ports.js";
import { removeNativeConnectorWithCleanup } from "./native-connector-lifecycle.js";
import { updateNativeConnector } from "./native-connector-store.js";
import {
  attestNativeMcpRevocation,
  nativeMcpRevocationInstructions,
} from "./native-mcp-attestation.js";
import {
  beginNativeMcpAuthorization,
  finishNativeMcpAuthorization,
} from "./native-mcp-authorization.js";
import { prepareNativeMcpCleanup } from "./native-mcp-cleanup.js";
import {
  installNativeMcpConnectorTests,
  mcpConnectorFixture,
} from "./native-mcp-connectors.test-support.js";
import { withNativeMcpMutationLock } from "./native-mcp-mutation-lock.js";
import { MCP_CLASSIFICATION } from "./native-mcp-profile.js";
import { requireNativeMcpRecord } from "./native-mcp-records.js";
import { discardUnsubmittedExchange } from "./native-mcp-submission.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";

installNativeMcpConnectorTests();
describe("MCP cross-realm credential fencing", () => {
  it("rejects confirmation rather than queuing behind another realm even after the deadline", async () => {
    const context = await mcpConnectorFixture({ tokenFailure: true });
    await beginNativeMcpAuthorization(context.id);
    const pending = requireNativeMcpRecord(context.id).privateState.pending
      .user;
    await expect(
      finishNativeMcpAuthorization(
        `?native_state=${pending.state}&native_code=actual-provider-code`,
      ),
    ).rejects.toThrow();
    const record = requireNativeMcpRecord(context.id);
    const recoveryId = record.privateState.recovery[0].id;
    await updateNativeConnector(
      context.id,
      nativeOAuthGuard(record),
      MCP_CLASSIFICATION,
      (current) => {
        current.privateState.recovery[0].credentials = {
          phase: "exchange",
          deadline: "0",
        };
        return current;
      },
    );
    const locks = lockManager();
    if (!locks) throw new Error("Expected test locks");
    let unblock = () => {};
    const blocker = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let entered = () => {};
    const acquired = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = locks.request(
      `opensesame:native-mcp-mutation:${context.id}`,
      async () => {
        entered();
        await blocker;
      },
    );
    await acquired;
    try {
      await expect(
        nativeMcpRevocationInstructions(context.id, recoveryId),
      ).rejects.toThrow();
      await expect(
        attestNativeMcpRevocation(context.id, recoveryId, record.revision),
      ).rejects.toThrow();
      expect(
        requireNativeMcpRecord(context.id).privateState.recovery,
      ).toHaveLength(1);
    } finally {
      unblock();
      await held;
    }
    expect(
      (await nativeMcpRevocationInstructions(context.id, recoveryId))
        .canConfirm,
    ).toBe(false);
  });
  it("rejects a guide after the durable record changes", async () => {
    const context = await mcpConnectorFixture({ tokenFailure: true });
    await beginNativeMcpAuthorization(context.id);
    const pending = requireNativeMcpRecord(context.id).privateState.pending
      .user;
    await expect(
      finishNativeMcpAuthorization(
        `?native_state=${pending.state}&native_code=actual-provider-code`,
      ),
    ).rejects.toThrow();
    const record = requireNativeMcpRecord(context.id);
    const recoveryId = record.privateState.recovery[0].id;
    await updateNativeConnector(
      context.id,
      nativeOAuthGuard(record),
      MCP_CLASSIFICATION,
      (current) => {
        current.privateState.recovery[0].credentials = { phase: "verify" };
        return current;
      },
    );
    const guide = await nativeMcpRevocationInstructions(context.id, recoveryId);
    expect(guide.canConfirm).toBe(true);
    const next = requireNativeMcpRecord(context.id);
    await updateNativeConnector(
      context.id,
      nativeOAuthGuard(next),
      MCP_CLASSIFICATION,
      (current) => current,
    );
    await expect(
      attestNativeMcpRevocation(context.id, recoveryId, guide.revision),
    ).rejects.toThrow();
    expect(
      requireNativeMcpRecord(context.id).privateState.recovery,
    ).toHaveLength(1);
  });
  it("clears an exchange claim when metadata fails before token submission", async () => {
    const options = { metadataFailure: false, management: true };
    const context = await mcpConnectorFixture(options);
    await beginNativeMcpAuthorization(context.id);
    const pending = requireNativeMcpRecord(context.id).privateState.pending
      .user;
    options.metadataFailure = true;
    await expect(
      finishNativeMcpAuthorization(
        `?native_state=${pending.state}&native_code=actual-provider-code`,
      ),
    ).rejects.toThrow();
    expect(
      requireNativeMcpRecord(context.id).privateState.recovery,
    ).toHaveLength(0);
    expect(
      context.requests.filter(
        (request) =>
          request.method === "POST" && request.url.endsWith("/token"),
      ),
    ).toHaveLength(0);
    expect(await removeNativeConnectorWithCleanup(context.id)).toBe(true);
    const deletions = context.requests.filter(
      (request) => request.method === "DELETE",
    );
    expect(deletions).toHaveLength(1);
    expect(deletions[0]?.headers.get("authorization")).toBe(
      "Bearer private-management-token",
    );
  });
  it("only clears a persisted pre-submit intent when no other realm holds the fence", async () => {
    const options = { tokenFailure: true };
    const context = await mcpConnectorFixture(options);
    await beginNativeMcpAuthorization(context.id);
    const pending = requireNativeMcpRecord(context.id).privateState.pending
      .user;
    await expect(
      finishNativeMcpAuthorization(
        `?native_state=${pending.state}&native_code=actual-provider-code`,
      ),
    ).rejects.toThrow();
    const record = requireNativeMcpRecord(context.id);
    expect(record.privateState.recovery[0].credentials?.submission).toBe(
      "submitting",
    );
    await discardUnsubmittedExchange(
      context.id,
      record.privateState.recovery[0].id,
    );
    expect(
      requireNativeMcpRecord(context.id).privateState.recovery,
    ).toHaveLength(1);
    await prepareNativeMcpCleanup(context.id);
    expect(
      requireNativeMcpRecord(context.id).privateState.recovery.map(
        (entry) => entry.kind,
      ),
    ).toEqual(["configure", "registration"]);
    expect(
      requireNativeMcpRecord(context.id).privateState.recovery[0].credentials
        ?.submission,
    ).toBe("submitting");
    await updateNativeConnector(
      context.id,
      nativeOAuthGuard(requireNativeMcpRecord(context.id)),
      MCP_CLASSIFICATION,
      (current) => {
        current.privateState.recovery[0].credentials = {
          phase: "exchange",
          submission: "prepared",
        };
        return current;
      },
    );
    const locks = lockManager();
    if (!locks) throw new Error("Expected test locks");
    let unblock = () => {};
    const blocker = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let entered = () => {};
    const acquired = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = locks.request(
      `opensesame:native-mcp-mutation:${context.id}`,
      async () => {
        entered();
        await blocker;
      },
    );
    await acquired;
    try {
      await expect(prepareNativeMcpCleanup(context.id)).rejects.toThrow();
      expect(
        requireNativeMcpRecord(context.id).privateState.recovery.map(
          (entry) => entry.kind,
        ),
      ).toEqual(["configure", "registration"]);
      expect(
        requireNativeMcpRecord(context.id).privateState.recovery[0].credentials
          ?.submission,
      ).toBe("prepared");
    } finally {
      unblock();
      await held;
    }
    await prepareNativeMcpCleanup(context.id);
    const remaining = requireNativeMcpRecord(context.id).privateState.recovery;
    expect(remaining.map((entry) => entry.kind)).toEqual(["registration"]);
    expect(remaining[0].credentials?.registration_mode).toBe("dcr");
    expect(
      requireNativeMcpRecord(context.id).privateState.credentials.mcp_client,
    ).toBeTruthy();
    expect(
      remaining.some((entry) => entry.credentials?.submission === "prepared"),
    ).toBe(false);
  });
  it.each(["registration", "exchange", "refresh"])(
    "recovers a persisted %s prepared intent without assuming a submitted one is safe",
    async (phase) => {
      const context = await mcpConnectorFixture({ tokenFailure: true });
      await beginNativeMcpAuthorization(context.id);
      const pending = requireNativeMcpRecord(context.id).privateState.pending
        .user;
      await expect(
        finishNativeMcpAuthorization(
          `?native_state=${pending.state}&native_code=actual-provider-code`,
        ),
      ).rejects.toThrow();
      let record = requireNativeMcpRecord(context.id);
      await updateNativeConnector(
        context.id,
        nativeOAuthGuard(record),
        MCP_CLASSIFICATION,
        (current) => {
          current.privateState.recovery[0].credentials = {
            phase,
            submission: "prepared",
          };
          return current;
        },
      );
      await prepareNativeMcpCleanup(context.id);
      record = requireNativeMcpRecord(context.id);
      expect(record.privateState.recovery.map((entry) => entry.kind)).toEqual([
        "registration",
      ]);
      expect(
        record.privateState.recovery[0].credentials?.registration_mode,
      ).toBe("dcr");
      expect(record.privateState.credentials.mcp_client).toBeTruthy();
      expect(
        record.privateState.recovery.some(
          (entry) => entry.credentials?.submission === "prepared",
        ),
      ).toBe(false);
    },
  );
  it("releases the fence after a failed operation", async () => {
    await expect(
      withNativeMcpMutationLock("test-lock", async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    await expect(
      withNativeMcpMutationLock("test-lock", async () => "settled"),
    ).resolves.toBe("settled");
  });
});
