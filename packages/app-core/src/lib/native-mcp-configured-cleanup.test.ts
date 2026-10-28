import { afterEach, expect, it, vi } from "vitest";
import { kvSeams } from "./kv.js";
import {
  registerNativeProviderCleanup,
  removeNativeConnectorWithCleanup,
  retryNativeConnectorCleanup,
} from "./native-connector-lifecycle.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "./native-connector-store.js";
import { configuredMcpCredentials } from "./native-mcp-configured-config.js";
import {
  MCP_KEY,
  type McpCredentialMode,
  configuredMcpFixture,
} from "./native-mcp-configured.test-support.js";
import { readVaultCredentialsForWithdrawal } from "./vault-credential-custody.js";
import { vaultStore } from "./vault/store.js";

const closing: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close();
});

async function setup(mode: McpCredentialMode = "bearer") {
  const f = await configuredMcpFixture(mode);
  closing.push(f.close);
  closing.push(
    registerNativeProviderCleanup(f.input.providerId, f.driver.cleanup),
  );
  return f;
}

function required(id: string) {
  const record = loadNativeConnectorRecord(id);
  if (!record) throw new Error("Missing actual configured MCP record");
  return record;
}

function tokenItems() {
  return vaultStore
    .getSnapshot()
    .items.filter(
      (item) =>
        item.kind === "credential" &&
        item.method.type === "token" &&
        item.method.token === MCP_KEY,
    );
}

it("withdraws the superseded Token after verification and the active Token on removal", async () => {
  const f = await setup();
  const first = await f.driver.configure(f.input);
  const previous = required(first.connectionId);
  const previousReference =
    previous.privateState.credentials.mcp_configured_reference ?? "";
  const previousItem = configuredMcpCredentials(
    previous.configuration,
    previous.privateState.credentials,
    f.owner,
  ).items[0];
  expect(previousItem).toBeTruthy();
  const saved = await f.driver.configure({
    ...f.input,
    connectionId: first.connectionId,
    revision: first.revision,
    credentials: { mcp_token: MCP_KEY },
  });
  expect(saved.status).toBe("connected");
  const current = required(saved.connectionId);
  const currentReference =
    current.privateState.credentials.mcp_configured_reference ?? "";
  expect(currentReference).not.toBe(previousReference);
  expect(current.privateState.recovery).toEqual([]);
  expect(
    readVaultCredentialsForWithdrawal(
      previousReference,
      previous.configuration.fingerprint,
      ["mcpToken"],
      f.owner.tomb,
    ),
  ).toBeNull();
  const active = configuredMcpCredentials(
    current.configuration,
    current.privateState.credentials,
    f.owner,
  );
  expect(active.fields.get("mcpToken")).toBe(MCP_KEY);
  expect(active.items).toHaveLength(1);
  expect(active.items[0]?.id).not.toBe(previousItem?.id);
  expect(tokenItems().map((item) => item.id)).toEqual([active.items[0]?.id]);
  await removeNativeConnectorWithCleanup(saved.connectionId, f.owner.transport);
  expect(readNativeConnector(saved.connectionId)).toBeNull();
  expect(
    readVaultCredentialsForWithdrawal(
      currentReference,
      current.configuration.fingerprint,
      ["mcpToken"],
      f.owner.tomb,
    ),
  ).toBeNull();
  expect(tokenItems()).toEqual([]);
});

it("retains the same Token for an unchanged blank edit and a zero-recovery retry", async () => {
  const f = await setup("header");
  const first = await f.driver.configure(f.input);
  const before = required(first.connectionId);
  const reference = before.privateState.credentials.mcp_configured_reference;
  const item = configuredMcpCredentials(
    before.configuration,
    before.privateState.credentials,
    f.owner,
  ).items[0];
  const edited = await f.driver.configure({
    ...f.input,
    connectionId: first.connectionId,
    revision: first.revision,
    credentials: { mcp_token: "" },
    displayName: "Unchanged credential",
  });
  expect(edited.status).toBe("connected");
  expect(required(edited.connectionId).privateState.credentials).toEqual(
    before.privateState.credentials,
  );
  await retryNativeConnectorCleanup(edited.connectionId, f.owner.transport);
  const after = required(edited.connectionId);
  expect(after.privateState.recovery).toEqual([]);
  expect(after.privateState.credentials.mcp_configured_reference).toBe(
    reference,
  );
  expect(tokenItems().map((entry) => entry.id)).toEqual([item?.id]);
});

it("does not stage or journal a Token for anonymous replacement or removal", async () => {
  const f = await setup("anonymous");
  const first = await f.driver.configure(f.input);
  const saved = await f.driver.configure({
    ...f.input,
    connectionId: first.connectionId,
    revision: first.revision,
    credentials: {},
  });
  expect(saved.status).toBe("connected");
  expect(required(saved.connectionId).privateState.recovery).toEqual([]);
  expect(tokenItems()).toEqual([]);
  await removeNativeConnectorWithCleanup(saved.connectionId, f.owner.transport);
  expect(readNativeConnector(saved.connectionId)).toBeNull();
  expect(tokenItems()).toEqual([]);
});

it("retries post-withdrawal lifecycle failure without touching the replacement", async () => {
  const f = await setup();
  const first = await f.driver.configure(f.input);
  const previous = required(first.connectionId);
  const previousReference =
    previous.privateState.credentials.mcp_configured_reference ?? "";
  const durable = kvSeams.kvSetDurable;
  let failed = false;
  const spy = vi
    .spyOn(kvSeams, "kvSetDurable")
    .mockImplementation(async (key, value, beforeCommit) => {
      await durable(key, value, () => {
        beforeCommit?.();
        if (
          !failed &&
          key === "opensesame.self-hosted-connectors.v1" &&
          readVaultCredentialsForWithdrawal(
            previousReference,
            previous.configuration.fingerprint,
            ["mcpToken"],
            f.owner.tomb,
          ) === null
        ) {
          failed = true;
          throw new Error("Injected post-withdrawal lifecycle failure");
        }
      });
    });
  try {
    await expect(
      f.driver.configure({
        ...f.input,
        connectionId: first.connectionId,
        revision: first.revision,
        credentials: { mcp_token: MCP_KEY },
      }),
    ).rejects.toThrow("Provider cleanup failed; retry before removing");
    expect(failed).toBe(true);
    const pending = required(first.connectionId);
    const replacementReference =
      pending.privateState.credentials.mcp_configured_reference ?? "";
    expect(replacementReference).not.toBe(previousReference);
    expect(pending.privateState.recovery).toHaveLength(1);
    expect(readNativeConnector(first.connectionId)?.status).toBe("cleanup");
    expect(
      configuredMcpCredentials(
        pending.configuration,
        pending.privateState.credentials,
        f.owner,
      ).fields.get("mcpToken"),
    ).toBe(MCP_KEY);
    const retried = await retryNativeConnectorCleanup(
      first.connectionId,
      f.owner.transport,
    );
    expect(retried.status).toBe("connected");
    const current = required(first.connectionId);
    expect(current.privateState.recovery).toEqual([]);
    expect(current.privateState.credentials.mcp_configured_reference).toBe(
      replacementReference,
    );
    const active = configuredMcpCredentials(
      current.configuration,
      current.privateState.credentials,
      f.owner,
    );
    expect(active.fields.get("mcpToken")).toBe(MCP_KEY);
    expect(tokenItems().map((item) => item.id)).toEqual([active.items[0]?.id]);
  } finally {
    spy.mockRestore();
  }
});
