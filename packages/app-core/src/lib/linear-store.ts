/** Verified Linear identities are public; OAuth grants stay in the sealed half. */
import { z } from "zod";
import type { DraftState } from "./connect-draft.js";
import type { Connection } from "./connections.js";
import type { DeviceConfiguration } from "./device-connector-records.js";
import {
  readDeviceRows,
  readDeviceSecrets,
  updateDeviceConfigurationDurable,
} from "./device-connector-records.js";
import { deviceConnection } from "./device-connectors.js";
import { SavedSchema } from "./self-hosted-connectors-schema.js";
import type { SelfHostedConnectorOptions } from "./self-hosted-connectors.js";

export type LinearActor = "app" | "user";
const IdentitySchema = z.object({
  accountLabel: z.string(),
  workspaceId: z.string(),
  workspaceName: z.string(),
  workspaceKey: z.string(),
  grantedScopes: z.array(z.string()),
  expiresAt: z.number().nullable(),
  kind: z.enum(["oauth", "api-key"]),
  needsReauth: z.boolean().optional(),
});
export const LinearRuntimeSchema = z.object({
  app: IdentitySchema.nullable(),
  user: IdentitySchema.nullable(),
  webhook: z
    .object({
      id: z.string(),
      url: z.string(),
      resourceTypes: z.array(z.string()),
    })
    .nullable(),
  recovery: z
    .object({
      workspaceId: z.string().min(1),
      phase: z.enum(["cleanup", "configure"]),
    })
    .optional(),
});
export type LinearRuntime = z.infer<typeof LinearRuntimeSchema>;
export const LinearGrantSchema = z
  .object({
    kind: z.enum(["oauth", "api-key"]),
    accessToken: z
      .string()
      .min(1)
      .max(16384)
      .regex(/^[!-~]+$/),
    refreshToken: z
      .string()
      .min(1)
      .max(16384)
      .regex(/^[!-~]+$/)
      .optional(),
    expiresAt: z.number().finite().positive().nullable(),
    scopes: z.array(z.string()),
  })
  .refine((grant) => grant.kind === "api-key" || grant.expiresAt !== null);
export type StoredLinearGrant = z.infer<typeof LinearGrantSchema>;
export const PendingLinearSchema = z.object({
  state: z.string().min(32),
  verifier: z.string().min(43),
  clientId: z.string().min(1),
  redirectUri: z.string(),
  actor: z.enum(["app", "user"]),
  scopes: z.array(z.string()),
  createdAt: z.number(),
  fingerprint: z.string(),
});
export type PendingLinear = z.infer<typeof PendingLinearSchema>;
export const LINEAR_RUNTIME = "linear_authorization";
export const LINEAR_PENDING = "linear_pending";
export const grantKey = (actor: LinearActor): string => `linear_${actor}_grant`;
export const emptyLinearRuntime = (): LinearRuntime => ({
  app: null,
  user: null,
  webhook: null,
});

export function parseLinearRuntime(raw?: string): LinearRuntime {
  try {
    return LinearRuntimeSchema.parse(JSON.parse(raw ?? ""));
  } catch {
    return emptyLinearRuntime();
  }
}
export function readLinearConnector(id: string): LinearRuntime | null {
  const row = readDeviceRows().find(
    (entry) => entry.connectionId === id && entry.providerId === "linear",
  );
  return row ? parseLinearRuntime(row.fields[LINEAR_RUNTIME]) : null;
}
export function parseLinearGrant(raw?: string): StoredLinearGrant | null {
  try {
    return LinearGrantSchema.parse(JSON.parse(raw ?? ""));
  } catch {
    return null;
  }
}
export function linearGrant(
  id: string,
  actor: LinearActor,
): StoredLinearGrant | null {
  return parseLinearGrant(readDeviceSecrets()[id]?.[grantKey(actor)]);
}
export function linearConfiguration(id: string) {
  const row = readDeviceRows().find((entry) => entry.connectionId === id);
  if (row?.providerId !== "linear")
    throw new Error("Saved Linear connector not found");
  try {
    return SavedSchema.parse(
      JSON.parse(row.fields.self_hosted_configuration ?? ""),
    );
  } catch {
    throw new Error("Saved Linear configuration is invalid");
  }
}
export function linearFingerprint(
  state: DraftState,
  options: SelfHostedConnectorOptions,
): string {
  return JSON.stringify({
    method: state.method,
    clientId: state.oauth.clientId,
    workspace: options.workspace.trim(),
    app: [...options.appScopes].sort(),
    user: [...options.userScopes].sort(),
    webhook: options.webhookEnabled === true,
    url: options.webhookUrl ?? "",
    resources: [...options.webhookResourceTypes].sort(),
  });
}
export function linearReady(
  runtime: LinearRuntime,
  options: SelfHostedConnectorOptions,
  method: string,
): boolean {
  if (runtime.recovery) return false;
  const granted = (actor: LinearActor) => {
    const identity = runtime[actor];
    if (!identity || identity.needsReauth) return false;
    if (identity.kind === "api-key") return true;
    return options[actor === "app" ? "appScopes" : "userScopes"].every(
      (scope) => identity.grantedScopes.includes(scope),
    );
  };
  return method === "api-key"
    ? !!runtime.app &&
        !runtime.app.needsReauth &&
        (!options.webhookEnabled || !!runtime.webhook)
    : (options.appScopes.length === 0 || (!!runtime.app && granted("app"))) &&
        (options.userScopes.length === 0 ||
          (!!runtime.user && granted("user"))) &&
        (!options.webhookEnabled || !!runtime.webhook);
}
export function linearActorNeedsConsent(
  runtime: LinearRuntime | null,
  options: SelfHostedConnectorOptions,
  actor: LinearActor,
): boolean {
  const identity = runtime?.[actor];
  if (
    actor === "app" &&
    runtime?.recovery &&
    (!identity || identity.needsReauth)
  )
    return true;
  const scopes = options[actor === "app" ? "appScopes" : "userScopes"];
  return (
    scopes.length > 0 &&
    (!identity ||
      !!identity.needsReauth ||
      scopes.some((scope) => !identity.grantedScopes.includes(scope)))
  );
}
export function linearPublicFields(
  runtime: LinearRuntime,
  options: SelfHostedConnectorOptions,
  method: string,
  cleanupPending = false,
) {
  const identities = [runtime.app, runtime.user].filter(
    (value) => value !== null,
  );
  const expirations = identities.flatMap((value) =>
    value.expiresAt === null ? [] : [value.expiresAt],
  );
  return {
    [LINEAR_RUNTIME]: JSON.stringify(runtime),
    linear_verified:
      !cleanupPending && linearReady(runtime, options, method) ? "1" : "0",
    linear_granted_scopes: JSON.stringify([
      ...new Set(identities.flatMap((value) => value.grantedScopes)),
    ]),
    linear_account: identities[0]?.workspaceName ?? "",
    linear_expires_at:
      expirations.length > 0
        ? new Date(Math.min(...expirations)).toISOString()
        : "",
    linear_refreshable: identities.some((value) => value.kind === "oauth")
      ? "1"
      : "0",
  };
}
export function linearPublicRecord(
  record: DeviceConfiguration,
  runtime: LinearRuntime,
): DeviceConfiguration {
  const saved = linearConfiguration(record.row.connectionId);
  return {
    ...record,
    row: {
      ...record.row,
      fields: {
        ...record.row.fields,
        ...linearPublicFields(
          runtime,
          saved.options,
          saved.state.method,
          !!(
            record.secrets.linear_cleanup_app ||
            record.secrets.linear_cleanup_user
          ),
        ),
      },
      updatedAt: new Date().toISOString(),
    },
  };
}
export function requireLinearConnection(id: string): Connection {
  const connection = deviceConnection(id);
  if (!connection) throw new Error("Saved Linear connector not found");
  return connection;
}
export async function updateLinearRecord(
  id: string,
  update: (
    record: DeviceConfiguration,
    runtime: LinearRuntime,
  ) => Promise<DeviceConfiguration>,
): Promise<Connection> {
  await updateDeviceConfigurationDurable(id, async (record) => {
    if (record.row.providerId !== "linear")
      throw new Error("This is not a Linear connector");
    return update(
      record,
      parseLinearRuntime(record.row.fields[LINEAR_RUNTIME]),
    );
  });
  return requireLinearConnection(id);
}
