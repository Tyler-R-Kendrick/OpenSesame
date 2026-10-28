import type { NativeCleanupOutcome } from "./native-connector-lifecycle.js";
import type { NativeRecovery } from "./native-connector-schema.js";
import {
  type NativeConnectorRecord,
  loadNativeConnectorRecord,
} from "./native-connector-store.js";
import {
  type ConfiguredMcpOwner,
  assertConfiguredMcpOwner,
  configuredMcpCredentialsForWithdrawal,
  isConfiguredMcp,
} from "./native-mcp-configured-config.js";
import { NativeMcpError } from "./native-mcp-target.js";
import { discardVaultCredentials } from "./vault-credential-custody.js";

function recordFor(id: string): NativeConnectorRecord {
  const record = loadNativeConnectorRecord(id);
  if (!record || !isConfiguredMcp(record.configuration))
    throw new NativeMcpError("target");
  return record;
}

function assertSupersededBinding(
  record: NativeConnectorRecord,
  obligation: NativeRecovery,
  reference: string,
): void {
  if (
    record.configuration.providerId !== obligation.providerId ||
    record.privateState.credentials.mcp_configured_reference === reference
  )
    throw new NativeMcpError("disposed");
}

export async function discardSupersededConfiguredMcpCredential(
  obligation: NativeRecovery,
  id: string,
  owner: ConfiguredMcpOwner,
): Promise<NativeCleanupOutcome> {
  assertConfiguredMcpOwner(owner);
  const record = recordFor(id);
  const credentials = obligation.credentials;
  const reference = credentials?.mcp_configured_reference;
  if (
    obligation.kind !== "revoke" ||
    obligation.grant ||
    obligation.actor !== "user" ||
    obligation.targetId !== obligation.providerId ||
    record.configuration.providerId !== obligation.providerId ||
    credentials?.phase !== "superseded" ||
    credentials.mcp_configured_binding !== obligation.fingerprint ||
    credentials.mcp_configured_vault !== owner.tomb ||
    !reference
  )
    throw new NativeMcpError("authorization");
  assertSupersededBinding(record, obligation, reference);
  const held = configuredMcpCredentialsForWithdrawal(
    { ...record.configuration, fingerprint: obligation.fingerprint },
    credentials,
    owner,
  );
  if (!held) return "local-credential-forgotten";
  if (!held.fields.get("mcpToken")) throw new NativeMcpError("authorization");
  await discardVaultCredentials(held, owner.tomb, () => {
    assertConfiguredMcpOwner(owner);
    assertSupersededBinding(recordFor(id), obligation, reference);
  });
  return "local-credential-forgotten";
}

export async function discardActiveConfiguredMcpCredential(
  id: string,
  owner: ConfiguredMcpOwner,
): Promise<void> {
  assertConfiguredMcpOwner(owner);
  const expected = recordFor(id);
  if (expected.privateState.credentials.mcp_configured_vault !== owner.tomb)
    throw new NativeMcpError("disposed");
  const reference =
    expected.privateState.credentials.mcp_configured_reference ?? "";
  if (!reference) return;
  const held = configuredMcpCredentialsForWithdrawal(
    expected.configuration,
    expected.privateState.credentials,
    owner,
  );
  if (!held) return;
  const anonymous =
    expected.configuration.parameters.mcp_authentication === "anonymous";
  if (
    (anonymous && held.fields.size > 0) ||
    (!anonymous && !held.fields.get("mcpToken"))
  )
    throw new NativeMcpError("authorization");
  await discardVaultCredentials(held, owner.tomb, () => {
    assertConfiguredMcpOwner(owner);
    const current = recordFor(id);
    if (
      current.revision !== expected.revision ||
      current.configuration.fingerprint !==
        expected.configuration.fingerprint ||
      current.privateState.credentials.mcp_configured_reference !== reference ||
      current.privateState.credentials.mcp_configured_vault !== owner.tomb
    )
      throw new NativeMcpError("disposed");
  });
}
