import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { forgetAtRestKeyForTest } from "./at-rest/key.js";
import * as kv from "./kv.js";
import { removeNativeConnectorWithCleanup } from "./native-connector-lifecycle.js";
import {
  emptyNativePrivate,
  emptyNativeRuntime,
} from "./native-connector-schema.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
  saveNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import {
  markNativeOAuthMutationInFlight,
  nativeOAuthGuard,
} from "./native-oauth-session.js";
import {
  attestNativeVaultRevocation,
  nativeVaultRevocationInstructions,
} from "./native-vault-attestation.js";
import { completeNativeVaultOidc } from "./native-vault-auth.js";
import {
  authorizeNativeVault,
  configureNativeVault,
  nativeVaultClassification,
} from "./native-vault-session.js";
import {
  backend,
  disposers,
  input,
  provider,
  redirectUri,
  state,
  token,
} from "./native-vault.test-support.js";

beforeEach(kv.kvForgetAll);
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
  configureHost(createTestHost());
  forgetAtRestKeyForTest();
});

async function cleanup(providerId: "vault" | "openbao" = "vault") {
  backend();
  const runtime = provider(providerId);
  const id = await configureNativeVault({ ...input, providerId });
  await authorizeNativeVault(id, redirectUri);
  await completeNativeVaultOidc(id, { state, code: "code" });
  for (let attempt = 0; attempt < 2; attempt++)
    runtime.fetcher.mockResolvedValueOnce(
      Response.json({ errors: ["permission denied"] }, { status: 403 }),
    );
  await expect(removeNativeConnectorWithCleanup(id)).rejects.toThrow(
    "cleanup failed",
  );
  const record = loadNativeConnectorRecord(id);
  if (!record || !record.privateState.recovery[0])
    throw new Error("Expected cleanup record");
  return {
    ...runtime,
    id,
    record,
    recoveryId: record.privateState.recovery[0].id,
  };
}

it.each(["vault", "openbao"] as const)(
  "%s explicitly forgets only the selected administrator-revoked credential without provider proof",
  async (providerId) => {
    const { id, record, recoveryId, fetcher } = await cleanup(providerId);
    await updateNativeConnector(
      id,
      nativeOAuthGuard(record),
      nativeVaultClassification,
      (current) => {
        const other = structuredClone(current.privateState.recovery[0]);
        if (!other.grant) throw new Error("Expected retained grant");
        other.id = "other-revocation";
        other.grant.accessToken = "other-issued-token";
        current.privateState.recovery.push(other);
        return current;
      },
    );
    const instructions = nativeVaultRevocationInstructions(id, recoveryId);
    expect(instructions).toMatchObject({
      canConfirm: true,
      acknowledgementLabel: expect.stringContaining("connection token"),
    });
    expect(instructions.url).toContain(
      providerId === "vault" ? "developer.hashicorp.com" : "openbao.org",
    );
    expect(instructions.message).toContain(input.endpoint);
    expect(instructions.message).toContain(input.namespace);
    expect(instructions.message).not.toContain(token);
    const calls = fetcher.mock.calls.length;
    const view = await attestNativeVaultRevocation(id, recoveryId);
    expect(fetcher).toHaveBeenCalledTimes(calls);
    expect(view.status).toBe("cleanup");
    expect(view.verifiedAt).toBeNull();
    expect(loadNativeConnectorRecord(id)?.privateState.verification).toBeNull();
    expect(loadNativeConnectorRecord(id)?.privateState.recovery).toHaveLength(
      1,
    );
    expect(
      loadNativeConnectorRecord(id)?.privateState.recovery[0]?.grant
        ?.accessToken,
    ).toBe("other-issued-token");
    expect(
      loadNativeConnectorRecord(id)?.privateState.credentials.api_key,
    ).toBeUndefined();
    expect(
      (await attestNativeVaultRevocation(id, "other-revocation")).status,
    ).toBe("configuration");
  },
);

it.each(["endpoint", "namespace", "fingerprint", "manual-token"])(
  "refuses a recovery with another %s binding",
  async (field) => {
    const { id, record, recoveryId } = await cleanup();
    await updateNativeConnector(
      id,
      nativeOAuthGuard(record),
      nativeVaultClassification,
      (current) => {
        const entry = current.privateState.recovery[0];
        if (!entry?.grant) throw new Error("Expected retained grant");
        if (field === "endpoint")
          entry.grant.endpoint = "https://other.example";
        if (field === "namespace") entry.credentials = { namespace: "other" };
        if (field === "fingerprint")
          entry.fingerprint = entry.grant.fingerprint = "f".repeat(64);
        if (field === "manual-token") entry.grant.kind = "api-key";
        return current;
      },
    );
    await expect(attestNativeVaultRevocation(id, recoveryId)).rejects.toThrow(
      "another Vault connection",
    );
    expect(readNativeConnector(id)?.recovery).toHaveLength(1);
  },
);

it("rejects another recovery ID and a manual-token connection", async () => {
  const { id, record, recoveryId } = await cleanup();
  await expect(attestNativeVaultRevocation(id, "other-id")).rejects.toThrow(
    "another Vault connection",
  );
  await updateNativeConnector(
    id,
    nativeOAuthGuard(record),
    nativeVaultClassification,
    (current) => {
      current.configuration.method = "api-key";
      return current;
    },
  );
  await expect(attestNativeVaultRevocation(id, recoveryId)).rejects.toThrow(
    "OIDC connection not found",
  );
});

it("rejects a connection owned by another provider", async () => {
  const { record } = await cleanup();
  const wrong = await saveNativeConnector(
    {
      connectionId: "another-provider",
      configuration: { ...record.configuration, providerId: "github" },
      privateState: emptyNativePrivate(),
      runtime: emptyNativeRuntime(),
    },
    nativeVaultClassification,
  );
  await expect(
    attestNativeVaultRevocation(wrong.connectionId, "revoke:user:1"),
  ).rejects.toThrow("OIDC connection not found");
});

it("refuses active provider mutations and unexpired exchange deadlines", async () => {
  const { id, record, recoveryId } = await cleanup();
  const finish = markNativeOAuthMutationInFlight(id, recoveryId);
  try {
    expect(nativeVaultRevocationInstructions(id, recoveryId).canConfirm).toBe(
      false,
    );
    await expect(attestNativeVaultRevocation(id, recoveryId)).rejects.toThrow(
      "still pending",
    );
  } finally {
    finish();
  }
  await updateNativeConnector(
    id,
    nativeOAuthGuard(record),
    nativeVaultClassification,
    (current) => {
      const entry = current.privateState.recovery[0];
      if (!entry) throw new Error("Expected recovery");
      entry.credentials = {
        phase: "exchange",
        deadline: String(Date.now() + 60_000),
      };
      return current;
    },
  );
  await expect(attestNativeVaultRevocation(id, recoveryId)).rejects.toThrow(
    "still pending",
  );
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 61_000);
  expect((await attestNativeVaultRevocation(id, recoveryId)).status).toBe(
    "configuration",
  );
});

it("rejects a stale attestation revision instead of clearing concurrent recovery", async () => {
  const { id, record, recoveryId, transport } = await cleanup();
  vi.spyOn(transport, "assertCurrent").mockImplementationOnce(() => {
    void updateNativeConnector(
      id,
      nativeOAuthGuard(record),
      nativeVaultClassification,
      (current) => {
        current.configuration.displayName = "Concurrent edit";
        return current;
      },
    );
  });
  await expect(attestNativeVaultRevocation(id, recoveryId)).rejects.toThrow(
    "Connector changed",
  );
  expect(readNativeConnector(id)?.recovery).toHaveLength(1);
});

it.each(["lock", "mutation"])(
  "rechecks %s at the durable commit boundary",
  async (operation) => {
    const { id, recoveryId, dispose } = await cleanup();
    let finish: () => void = () => undefined;
    vi.mocked(kv.kvSeams.kvSetDurable).mockImplementationOnce(
      async (_key, _value, beforeCommit) => {
        if (operation === "lock") dispose();
        else finish = markNativeOAuthMutationInFlight(id, recoveryId);
        beforeCommit?.();
      },
    );
    try {
      await expect(
        attestNativeVaultRevocation(id, recoveryId),
      ).rejects.toThrow();
      expect(
        loadNativeConnectorRecord(id)?.privateState.recovery[0]?.grant
          ?.accessToken,
      ).toBe(token);
    } finally {
      finish();
    }
  },
);
