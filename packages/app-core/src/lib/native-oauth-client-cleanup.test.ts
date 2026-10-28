import { afterEach, expect, it, vi } from "vitest";
import { kvSeams } from "./kv.js";
import {
  registerNativeProviderCleanup,
  removeNativeConnectorWithCleanup,
  retryNativeConnectorCleanup,
} from "./native-connector-lifecycle.js";
import {
  readNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import type { NativeConnectorView } from "./native-connector-view.js";
import {
  beginNativeOAuthClient,
  configureNativeOAuthClient,
  nativeOAuthClientClassification,
  readNativeOAuthClientSecret,
} from "./native-oauth-client-config.js";
import { exchangeNativeOAuthClient } from "./native-oauth-client-exchange.js";
import {
  CLIENT_SECRET,
  nativeOAuthClientFixture,
} from "./native-oauth-client.test-support.js";
import { createNativeOAuthResourceDriver } from "./native-oauth-resource-driver.js";
import {
  nativeOAuthGuard,
  requireNativeOAuthRecord,
} from "./native-oauth-session.js";
import { readVaultCredentialsForWithdrawal } from "./vault-credential-custody.js";
import { vaultStore } from "./vault/store.js";

const closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close();
});

function secretItems() {
  return vaultStore
    .getSnapshot()
    .items.filter(
      (item) =>
        item.kind === "credential" &&
        item.method.type === "token" &&
        item.method.token === CLIENT_SECRET,
    );
}

it("retries removal after the secret withdrawal commits but its lifecycle update fails", async () => {
  const f = await nativeOAuthClientFixture("client_secret_post");
  closing.push(f.close);
  const saved = await configureNativeOAuthClient(f.input, f.owner);
  const driver = await beginAndVerify(f, saved);
  const release = registerNativeProviderCleanup(
    f.input.providerId,
    driver.cleanup,
  );
  try {
    const durable = kvSeams.kvSetDurable;
    let failed = false;
    vi.spyOn(kvSeams, "kvSetDurable").mockImplementation(
      async (key, value, beforeCommit) => {
        await durable(key, value, () => {
          beforeCommit?.();
          if (
            !failed &&
            key === "opensesame.self-hosted-connectors.v1" &&
            secretItems().length === 0
          ) {
            failed = true;
            throw new Error("Injected post-withdrawal lifecycle failure");
          }
        });
      },
    );
    await expect(
      removeNativeConnectorWithCleanup(saved.connectionId),
    ).rejects.toThrow("Provider cleanup failed; retry before removing");
    expect(failed).toBe(true);
    expect(readNativeConnector(saved.connectionId)?.status).toBe("cleanup");
    await driver.cleanup.prepare?.(saved.connectionId, f.owner.transport);
    await removeNativeConnectorWithCleanup(saved.connectionId);
  } finally {
    release();
  }
  expect(readNativeConnector(saved.connectionId)).toBeNull();
  expect(secretItems()).toHaveLength(0);
});

async function beginAndVerify(
  fixture: Awaited<ReturnType<typeof nativeOAuthClientFixture>>,
  saved: NativeConnectorView,
) {
  const driver = createNativeOAuthResourceDriver({
    supports: () => true,
    capture: () => ({ ...fixture.owner, close: () => {} }),
  });
  const authorization = new URL(
    await beginNativeOAuthClient(saved.connectionId, fixture.owner),
  );
  fixture.state.challenge =
    authorization.searchParams.get("code_challenge") ?? "";
  await exchangeNativeOAuthClient(
    new URLSearchParams({
      native_state: authorization.searchParams.get("state") ?? "",
      native_code: "one-use-code",
    }).toString(),
    fixture.owner,
  );
  await driver.verify(saved.connectionId);
  return driver;
}

it("withdraws a superseded client secret on replacement and the active secret on removal", async () => {
  const f = await nativeOAuthClientFixture("client_secret_post");
  closing.push(f.close);
  const first = await configureNativeOAuthClient(f.input, f.owner);
  const previous = requireNativeOAuthRecord(first.connectionId).privateState
    .credentials.oauth_client_reference;
  const saved = await configureNativeOAuthClient(
    {
      ...f.input,
      parameters: { ...f.input.parameters, client_id: "replacement-client" },
      credentials: { client_secret: "replacement-client-secret" },
      connectionId: first.connectionId,
      revision: first.revision,
    },
    f.owner,
  );
  const current = requireNativeOAuthRecord(saved.connectionId).privateState
    .credentials.oauth_client_reference;
  if (!previous || !current || current === previous)
    throw new Error("Expected distinct vault references");
  expect(saved.configuration.fingerprint).not.toBe(
    first.configuration.fingerprint,
  );
  expect(secretItems()).toHaveLength(1);
  const driver = createNativeOAuthResourceDriver({
    supports: () => true,
    capture: () => ({ ...f.owner, close: () => {} }),
  });
  const release = registerNativeProviderCleanup(
    f.input.providerId,
    driver.cleanup,
  );
  try {
    await removeNativeConnectorWithCleanup(saved.connectionId);
  } finally {
    release();
  }
  expect(readNativeConnector(saved.connectionId)).toBeNull();
  for (const [reference, fingerprint] of [
    [previous, first.configuration.fingerprint],
    [current, saved.configuration.fingerprint],
  ])
    expect(
      readVaultCredentialsForWithdrawal(
        reference,
        fingerprint,
        ["clientSecret"],
        f.owner.tomb,
      ),
    ).toBeNull();
});

it("retries superseded-secret withdrawal without losing the replacement", async () => {
  const f = await nativeOAuthClientFixture("client_secret_post");
  closing.push(f.close);
  const first = await configureNativeOAuthClient(f.input, f.owner);
  const previous = requireNativeOAuthRecord(first.connectionId).privateState
    .credentials.oauth_client_reference;
  if (!previous) throw new Error("Expected the original vault reference");
  const replacementSecret = "replacement-client-secret";
  const saved = await configureNativeOAuthClient(
    {
      ...f.input,
      parameters: { ...f.input.parameters, client_id: "replacement-client" },
      credentials: { client_secret: replacementSecret },
      connectionId: first.connectionId,
      revision: first.revision,
    },
    f.owner,
  );
  expect(saved.configuration.fingerprint).not.toBe(
    first.configuration.fingerprint,
  );
  expect(readNativeOAuthClientSecret(saved.connectionId, f.owner)).toBe(
    replacementSecret,
  );
  expect(
    requireNativeOAuthRecord(saved.connectionId).privateState.recovery,
  ).toHaveLength(1);
  expect(
    readVaultCredentialsForWithdrawal(
      previous,
      first.configuration.fingerprint,
      ["clientSecret"],
      f.owner.tomb,
    ),
  ).not.toBeNull();
  const driver = createNativeOAuthResourceDriver({
    supports: () => true,
    capture: () => ({ ...f.owner, close: () => {} }),
  });
  const release = registerNativeProviderCleanup(
    f.input.providerId,
    driver.cleanup,
  );
  const durable = kvSeams.kvSetDurable;
  let failed = false;
  vi.spyOn(kvSeams, "kvSetDurable").mockImplementation(
    async (key, _value, beforeCommit) => {
      await durable(key, _value, () => {
        beforeCommit?.();
        if (
          !failed &&
          key === "opensesame.self-hosted-connectors.v1" &&
          readVaultCredentialsForWithdrawal(
            previous,
            first.configuration.fingerprint,
            ["clientSecret"],
            f.owner.tomb,
          ) === null
        ) {
          failed = true;
          throw new Error("Injected superseded cleanup failure");
        }
      });
    },
  );
  try {
    await expect(
      retryNativeConnectorCleanup(saved.connectionId, f.owner.transport),
    ).rejects.toThrow("Provider cleanup failed; retry before removing");
    expect(failed).toBe(true);
    await retryNativeConnectorCleanup(saved.connectionId, f.owner.transport);
  } finally {
    release();
  }
  expect(readNativeOAuthClientSecret(saved.connectionId, f.owner)).toBe(
    replacementSecret,
  );
  expect(
    readVaultCredentialsForWithdrawal(
      previous,
      first.configuration.fingerprint,
      ["clientSecret"],
      f.owner.tomb,
    ),
  ).toBeNull();
  expect(
    requireNativeOAuthRecord(saved.connectionId).privateState.recovery,
  ).toEqual([]);
});

it("preserves an active client secret on a zero-recovery retry", async () => {
  const f = await nativeOAuthClientFixture("client_secret_post");
  closing.push(f.close);
  const saved = await configureNativeOAuthClient(f.input, f.owner);
  const driver = createNativeOAuthResourceDriver({
    supports: () => true,
    capture: () => ({ ...f.owner, close: () => {} }),
  });
  const release = registerNativeProviderCleanup(
    f.input.providerId,
    driver.cleanup,
  );
  try {
    await retryNativeConnectorCleanup(saved.connectionId, f.owner.transport);
  } finally {
    release();
  }
  expect(readNativeOAuthClientSecret(saved.connectionId, f.owner)).toBe(
    CLIENT_SECRET,
  );
});

it("withdraws a confidential client secret before authorization", async () => {
  const f = await nativeOAuthClientFixture("client_secret_post");
  closing.push(f.close);
  const saved = await configureNativeOAuthClient(f.input, f.owner);
  const driver = createNativeOAuthResourceDriver({
    supports: () => true,
    capture: () => ({ ...f.owner, close: () => {} }),
  });
  const release = registerNativeProviderCleanup(
    f.input.providerId,
    driver.cleanup,
  );
  try {
    await removeNativeConnectorWithCleanup(saved.connectionId);
  } finally {
    release();
  }
  expect(readNativeConnector(saved.connectionId)).toBeNull();
  expect(secretItems()).toHaveLength(0);
});

it("withdraws the client secret only after the last revoke obligation", async () => {
  const f = await nativeOAuthClientFixture("client_secret_post");
  closing.push(f.close);
  const saved = await configureNativeOAuthClient(f.input, f.owner);
  const driver = await beginAndVerify(f, saved);
  const record = requireNativeOAuthRecord(saved.connectionId);
  const grant = record.privateState.grants.user;
  if (!grant) throw new Error("Expected a verified grant");
  await updateNativeConnector(
    saved.connectionId,
    nativeOAuthGuard(record),
    nativeOAuthClientClassification(),
    (current) => {
      current.privateState.recovery.push({
        id: "synthetic-older-revocation",
        kind: "revoke",
        providerId: grant.providerId,
        actor: grant.actor,
        fingerprint: grant.fingerprint,
        targetId: grant.targetId ?? grant.providerId,
        grant,
      });
      return current;
    },
  );
  const release = registerNativeProviderCleanup(
    f.input.providerId,
    driver.cleanup,
  );
  try {
    await removeNativeConnectorWithCleanup(saved.connectionId);
  } finally {
    release();
  }
  expect(readNativeConnector(saved.connectionId)).toBeNull();
  expect(secretItems()).toHaveLength(0);
});

it("retains the client secret for an ordinary cleanup retry", async () => {
  const f = await nativeOAuthClientFixture("client_secret_post");
  closing.push(f.close);
  const saved = await configureNativeOAuthClient(f.input, f.owner);
  await beginAndVerify(f, saved);
  const record = requireNativeOAuthRecord(saved.connectionId);
  const grant = record.privateState.grants.user;
  if (!grant) throw new Error("Expected a verified grant");
  await updateNativeConnector(
    saved.connectionId,
    nativeOAuthGuard(record),
    nativeOAuthClientClassification(),
    (current) => {
      current.privateState.recovery.push({
        id: "synthetic-failed-authorization",
        kind: "configure",
        providerId: grant.providerId,
        actor: grant.actor,
        fingerprint: grant.fingerprint,
        targetId: grant.targetId ?? grant.providerId,
        grant,
        credentials: { phase: "verify" },
      });
      return current;
    },
  );
  await expect(
    retryNativeConnectorCleanup(saved.connectionId, f.owner.transport),
  ).rejects.toThrow();
  expect(secretItems()).toHaveLength(1);
  expect(
    requireNativeOAuthRecord(saved.connectionId).privateState.recovery,
  ).toHaveLength(1);
});
