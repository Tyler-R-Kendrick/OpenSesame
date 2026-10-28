/** Explicit MCP transport authentication; credentials belong only to their original vault. */
import { canonicalize } from "@opensesame/os-domain";
import { z } from "zod";
import { connectPlan } from "./connect-plan.js";
import type { NativeDriverInput } from "./native-connector-drivers.js";
import {
  type NativeConfiguration,
  type NativeRecovery,
  emptyNativePrivate,
  emptyNativeRuntime,
} from "./native-connector-schema.js";
import {
  loadNativeConnectorRecord,
  saveNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import {
  type NativeMcpBinding,
  NativeMcpError,
  nativeMcpUrl,
  validateNativeMcpBinding,
} from "./native-mcp-target.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";
import {
  assertVaultCredentials,
  discardUnpublishedVaultCredentials,
  readVaultCredentials,
  readVaultCredentialsForWithdrawal,
  stageVaultCredentials,
} from "./vault-credential-custody.js";
export const ConfiguredMcpTarget = z
  .object({
    mcp_authentication: z.enum(["bearer", "header", "anonymous"]),
    mcp_url: z.string().max(4096),
    mcp_resource: z.string().max(4096),
    mcp_transport: z.enum(["streamable-http", "sse"]),
    mcp_post_endpoint: z.string().max(4096).optional(),
    mcp_header: z
      .string()
      .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/)
      .optional(),
  })
  .strict();
export type ConfiguredMcpParameters = z.infer<typeof ConfiguredMcpTarget>;
const Token = z
  .string()
  .min(1)
  .max(32768)
  .refine((value) => !/[\r\n\0]/.test(value));
const forbiddenHeader =
  /^(?:host|cookie|set-cookie|origin|referer|content-.*|connection|upgrade|transfer-encoding|te|trailer|keep-alive|proxy-.*|sec-.*|mcp-.*)$/i;
const secretQuery =
  /^(?:access_token|token|api[_-]?key|key|secret|authorization)$/i;
export const configuredMcpClassification = () => ({
  publicParameters: ConfiguredMcpTarget.keyof().options,
  privateCredentials: ["mcp_configured_reference", "mcp_configured_vault"],
});
export type ConfiguredMcpOwner = {
  tomb: string;
  transport: NativeProviderTransport;
  close(): void;
};
export function supportsConfiguredMcp(id: string): boolean {
  const plan = connectPlan(id);
  return (
    !!plan &&
    !plan.refused &&
    plan.methods.some((method) => method.kind === "mcp")
  );
}
export function configuredMcpTarget(
  parameters: Readonly<Record<string, string>>,
) {
  const target = ConfiguredMcpTarget.parse(parameters);
  for (const value of [
    target.mcp_url,
    target.mcp_resource,
    target.mcp_post_endpoint,
  ]) {
    if (!value) continue;
    const url = nativeMcpUrl(value);
    if ([...url.searchParams.keys()].some((key) => secretQuery.test(key)))
      throw new NativeMcpError("target");
  }
  if (target.mcp_authentication === "header") {
    if (!target.mcp_header || forbiddenHeader.test(target.mcp_header))
      throw new NativeMcpError("target");
  } else if (target.mcp_header) throw new NativeMcpError("target");
  if (target.mcp_transport === "sse" && !target.mcp_post_endpoint)
    throw new NativeMcpError("target");
  validateNativeMcpBinding({
    providerId: "configured-mcp",
    fingerprint: "validated",
    endpoint: target.mcp_url,
    resource: target.mcp_resource,
    issuer: null,
    transport: target.mcp_transport,
    ssePostEndpoint: target.mcp_post_endpoint,
  });
  return target;
}
export function isConfiguredMcp(configuration: NativeConfiguration): boolean {
  if (
    configuration.method !== "mcp" ||
    !("mcp_authentication" in configuration.parameters)
  )
    return false;
  configuredMcpTarget(configuration.parameters);
  return true;
}
export function configuredMcpBinding(
  configuration: NativeConfiguration,
): NativeMcpBinding {
  if (
    configuration.method !== "mcp" ||
    !supportsConfiguredMcp(configuration.providerId)
  )
    throw new NativeMcpError("target");
  const target = configuredMcpTarget(configuration.parameters);
  return {
    providerId: configuration.providerId,
    fingerprint: configuration.fingerprint,
    endpoint: target.mcp_url,
    resource: target.mcp_resource,
    issuer: null,
    transport: target.mcp_transport,
    ssePostEndpoint: target.mcp_post_endpoint,
  };
}
export function assertConfiguredMcpOwner(owner: ConfiguredMcpOwner) {
  owner.transport.assertCurrent();
  if (!owner.transport.signal) throw new NativeMcpError("disposed");
  owner.transport.signal.throwIfAborted();
}
export function configuredMcpCredentials(
  configuration: NativeConfiguration,
  credentials: Readonly<Record<string, string>>,
  owner: ConfiguredMcpOwner,
) {
  assertConfiguredMcpOwner(owner);
  if (credentials.mcp_configured_vault !== owner.tomb)
    throw new NativeMcpError("disposed");
  return readVaultCredentials(
    credentials.mcp_configured_reference ?? "",
    configuration.fingerprint,
    ["mcpToken"],
    owner.tomb,
  );
}
export function configuredMcpCredentialsForWithdrawal(
  configuration: NativeConfiguration,
  credentials: Readonly<Record<string, string>>,
  owner: ConfiguredMcpOwner,
) {
  assertConfiguredMcpOwner(owner);
  if (credentials.mcp_configured_vault !== owner.tomb)
    throw new NativeMcpError("disposed");
  const reference = credentials.mcp_configured_reference;
  if (!reference) return null;
  return readVaultCredentialsForWithdrawal(
    reference,
    configuration.fingerprint,
    ["mcpToken"],
    owner.tomb,
  );
}
export async function configuredMcpFingerprint(
  configuration: Pick<
    NativeConfiguration,
    "providerId" | "method" | "parameters"
  >,
) {
  const material = {
    providerId: configuration.providerId,
    method: configuration.method,
    target: configuredMcpTarget(configuration.parameters),
  };
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalize(material)),
  );
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}
function configuredInput(input: NativeDriverInput) {
  if (
    input.method !== "mcp" ||
    !supportsConfiguredMcp(input.providerId) ||
    Object.keys(input.targetIds).length ||
    Object.values(input.requestedScopes).some((scopes) => scopes.length)
  )
    throw new NativeMcpError("target");
  const parameters = Object.fromEntries(
    Object.entries(input.parameters).filter(
      ([key, value]) =>
        value !== "" || !["mcp_header", "mcp_post_endpoint"].includes(key),
    ),
  );
  const target = configuredMcpTarget(parameters);
  const supplied = z
    .object({ mcp_token: z.string().optional() })
    .strict()
    .parse(input.credentials);
  const secret = supplied.mcp_token || undefined;
  if (secret) Token.parse(secret);
  if (target.mcp_authentication === "anonymous" && secret)
    throw new NativeMcpError("target");
  if (
    secret &&
    Object.values(parameters).some((value) => value.includes(secret))
  )
    throw new NativeMcpError("target");
  return { parameters, target, secret };
}
function existingConfiguredMcp(input: NativeDriverInput) {
  const old = input.connectionId
    ? loadNativeConnectorRecord(input.connectionId)
    : null;
  if (
    input.connectionId &&
    (!old ||
      old.revision !== input.revision ||
      old.configuration.providerId !== input.providerId ||
      !isConfiguredMcp(old.configuration))
  )
    throw new NativeMcpError("disposed");
  if (
    old &&
    (old.privateState.recovery.length ||
      Object.keys(old.privateState.grants).length ||
      Object.keys(old.privateState.pending).length)
  )
    throw new NativeMcpError("authorization");
  return old;
}
function retainConfiguredMcp(
  old: NonNullable<ReturnType<typeof loadNativeConnectorRecord>>,
  configuration: NativeConfiguration,
  owner: ConfiguredMcpOwner,
  admit: (configuration: NativeConfiguration) => void,
) {
  const held = configuredMcpCredentials(
    old.configuration,
    old.privateState.credentials,
    owner,
  );
  Token.parse(held.fields.get("mcpToken"));
  return updateNativeConnector(
    old.connectionId,
    nativeOAuthGuard(old),
    configuredMcpClassification(),
    (record) => {
      assertVaultCredentials(held, owner.tomb, () => admit(configuration));
      record.configuration = configuration;
      record.privateState.verification = null;
      record.runtime = emptyNativeRuntime();
      return record;
    },
    () => assertVaultCredentials(held, owner.tomb, () => admit(configuration)),
  );
}
function supersededMcpRecovery(
  old: NonNullable<ReturnType<typeof loadNativeConnectorRecord>>,
  previous: ReturnType<typeof configuredMcpCredentialsForWithdrawal>,
  replacement: string,
): NativeRecovery | null {
  const reference = old.privateState.credentials.mcp_configured_reference;
  if (!previous?.items.length || !reference || reference === replacement)
    return null;
  return {
    id: `configured-mcp-cleanup:${old.revision}`,
    kind: "revoke",
    providerId: old.configuration.providerId,
    actor: "user",
    fingerprint: old.configuration.fingerprint,
    targetId: old.configuration.providerId,
    credentials: {
      phase: "superseded",
      mcp_configured_reference: reference,
      mcp_configured_vault:
        old.privateState.credentials.mcp_configured_vault ?? "",
      mcp_configured_binding: old.configuration.fingerprint,
    },
  };
}
export async function configureMcpCredentials(
  input: NativeDriverInput,
  owner: ConfiguredMcpOwner,
  admit: (configuration: NativeConfiguration) => void,
) {
  assertConfiguredMcpOwner(owner);
  const { parameters, target, secret } = configuredInput(input);
  const fingerprint = await configuredMcpFingerprint({
    providerId: input.providerId,
    method: "mcp",
    parameters,
  });
  const configuration: NativeConfiguration = {
    version: 1,
    providerId: input.providerId,
    method: "mcp",
    displayName: input.displayName,
    icon: input.icon ?? "",
    parameters,
    requestedScopes: {},
    targetIds: { mcp: target.mcp_resource },
    fingerprint,
  };
  admit(configuration);
  const old = existingConfiguredMcp(input);
  if (!secret && target.mcp_authentication !== "anonymous") {
    if (!old || old.configuration.fingerprint !== fingerprint)
      throw new NativeMcpError("authorization");
    return retainConfiguredMcp(old, configuration, owner, admit);
  }
  const previous = old
    ? configuredMcpCredentialsForWithdrawal(
        old.configuration,
        old.privateState.credentials,
        owner,
      )
    : null;
  const captured = await stageVaultCredentials(
    {
      name: input.displayName,
      targetBinding: fingerprint,
      fields: secret
        ? [{ field: "mcpToken", label: "MCP credential", value: secret }]
        : [],
    },
    owner.tomb,
    () => admit(configuration),
  );
  const state = emptyNativePrivate();
  state.credentials = {
    mcp_configured_reference: captured.reference,
    mcp_configured_vault: owner.tomb,
  };
  const superseded = old
    ? supersededMcpRecovery(old, previous, captured.reference)
    : null;
  if (superseded) state.recovery.push(superseded);
  const check = () =>
    assertVaultCredentials(captured, owner.tomb, () => admit(configuration));
  const connectionId = old?.connectionId ?? `devconn_${crypto.randomUUID()}`;
  try {
    if (!old)
      return await saveNativeConnector(
        {
          connectionId,
          configuration,
          runtime: emptyNativeRuntime(),
          privateState: state,
        },
        configuredMcpClassification(),
        check,
      );
    return await updateNativeConnector(
      old.connectionId,
      nativeOAuthGuard(old),
      configuredMcpClassification(),
      (record) => {
        check();
        record.configuration = configuration;
        record.privateState = state;
        record.runtime = emptyNativeRuntime();
        return record;
      },
      check,
    );
  } catch (error) {
    await discardUnpublishedVaultCredentials(
      captured,
      owner.tomb,
      () =>
        loadNativeConnectorRecord(connectionId)?.privateState.credentials
          .mcp_configured_reference === captured.reference,
      () => assertConfiguredMcpOwner(owner),
    );
    throw error;
  }
}
