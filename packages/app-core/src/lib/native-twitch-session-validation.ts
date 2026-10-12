/** Twitch sessions validate at startup and hourly without churning verified revisions. */
import { z } from "zod";
import { readDeviceRows } from "./device-connector-records.js";
import { NativeApiError, nativeApiHttp } from "./native-api-http.js";
import { browserOAuthClassification } from "./native-browser-oauth-profile.js";
import {
  type NativeConnectorRecord,
  assertNativeConnectorRevision,
  loadNativeConnectorRecord,
  updateNativeConnector,
} from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";

const Validation = z.object({
  client_id: z.string().min(1).max(256),
  user_id: z.string().min(1).max(256),
  login: z.string().min(1).max(256),
  scopes: z.array(z.string().min(1).max(512)).max(256),
  expires_in: z
    .number()
    .finite()
    .positive()
    .max(365 * 86400),
});
export type NativeTwitchValidationTarget = {
  connectionId: string;
  revision: number;
  expiresAt: number;
};
function verifiedSession(record: NativeConnectorRecord): boolean {
  return Boolean(
    record.runtime.identity?.assurance === "account-verified" &&
      record.privateState.verification?.fingerprint ===
        record.configuration.fingerprint &&
      !Object.keys(record.privateState.pending).length &&
      !record.privateState.recovery.length,
  );
}
function activeGrant(record: NativeConnectorRecord) {
  const grant = record.privateState.grants.user;
  const projected = record.runtime.grants.find(
    (entry) => entry.actor === "user",
  );
  const expiresAt = grant?.expiresAt;
  if (
    record.configuration.providerId !== "twitch" ||
    record.configuration.method !== "oauth" ||
    !record.configuration.clientId ||
    !grant ||
    grant.kind !== "oauth" ||
    !expiresAt ||
    expiresAt <= Date.now() ||
    !projected ||
    projected.needsReauth ||
    !verifiedSession(record)
  )
    return null;
  return grant;
}
function validationTarget(
  connectionId: string,
): NativeTwitchValidationTarget[] {
  try {
    const record = loadNativeConnectorRecord(connectionId);
    const grant = record ? activeGrant(record) : null;
    return record && grant?.expiresAt
      ? [
          {
            connectionId: record.connectionId,
            revision: record.revision,
            expiresAt: grant.expiresAt,
          },
        ]
      : [];
  } catch {
    // An invalid sealed record cannot authorize HTTP or stop other sessions.
    return [];
  }
}
export function nativeTwitchValidationTargets(): NativeTwitchValidationTarget[] {
  return readDeviceRows().flatMap((row) =>
    row.providerId === "twitch" ? validationTarget(row.connectionId) : [],
  );
}
function sameAuthority(
  record: NativeConnectorRecord,
  reply: z.infer<typeof Validation>,
): boolean {
  const grant = record.privateState.grants.user;
  const expectedScopes = grant?.scopes;
  const requested = record.configuration.requestedScopes.user ?? [];
  return Boolean(
    grant &&
      expectedScopes &&
      reply.client_id === record.configuration.clientId &&
      (!grant.clientId || reply.client_id === grant.clientId) &&
      reply.user_id === record.runtime.identity?.id &&
      requested.every((scope) => reply.scopes.includes(scope)) &&
      expectedScopes.every((scope) => reply.scopes.includes(scope)) &&
      reply.scopes.every((scope) => expectedScopes.includes(scope)),
  );
}
async function invalidateSession(
  record: NativeConnectorRecord,
  transport: NativeProviderTransport,
  signal?: AbortSignal,
): Promise<void> {
  await updateNativeConnector(
    record.connectionId,
    nativeOAuthGuard(record),
    browserOAuthClassification(record.configuration),
    (current) => {
      transport.assertCurrent();
      signal?.throwIfAborted();
      current.privateState.verification = null;
      current.runtime.verifiedAt = null;
      current.runtime.grants = current.runtime.grants.map((grant) => ({
        ...grant,
        needsReauth: true,
      }));
      return current;
    },
  );
}
export async function validateNativeTwitchSession(
  connectionId: string,
  transport: NativeProviderTransport,
  signal?: AbortSignal,
): Promise<NativeTwitchValidationTarget | null> {
  transport.assertCurrent();
  signal?.throwIfAborted();
  const record = loadNativeConnectorRecord(connectionId);
  const grant = record ? activeGrant(record) : null;
  if (!record || !grant?.expiresAt) return null;
  await assertNativeConnectorRevision(connectionId, nativeOAuthGuard(record));
  try {
    const reply = Validation.safeParse(
      await nativeApiHttp(
        {
          url: "https://id.twitch.tv/oauth2/validate",
          method: "GET",
          headers: new Headers({ authorization: `OAuth ${grant.accessToken}` }),
          signal,
        },
        transport,
      ),
    );
    transport.assertCurrent();
    signal?.throwIfAborted();
    if (!reply.success || !sameAuthority(record, reply.data)) {
      await invalidateSession(record, transport, signal);
      return null;
    }
    await assertNativeConnectorRevision(connectionId, nativeOAuthGuard(record));
    transport.assertCurrent();
    signal?.throwIfAborted();
    return {
      connectionId,
      revision: record.revision,
      expiresAt: Math.min(
        grant.expiresAt,
        Date.now() + reply.data.expires_in * 1000,
      ),
    };
  } catch (error) {
    if (error instanceof NativeApiError && error.code === "authorization") {
      await invalidateSession(record, transport, signal);
      return null;
    }
    throw error;
  }
}
