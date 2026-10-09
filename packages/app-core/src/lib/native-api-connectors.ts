import {
  NativeApiBrowserUnavailable,
  assertNativeApiBrowserTarget,
} from "./native-api-admission.js";
import {
  nativeApiExposedCredentials,
  nativeApiVerificationRequest,
} from "./native-api-auth.js";
import {
  assertNativeApiAuthority,
  assertNativeApiEditable,
} from "./native-api-authority.js";
import { NativeApiError, nativeApiHttp } from "./native-api-http.js";
import {
  invalidateNativeApiProof,
  requireNativeApiBrowserAccess,
} from "./native-api-proof.js";
import {
  type NativeApiTarget,
  nativeApiCredentials,
  nativeApiFingerprint,
  nativeApiTarget,
} from "./native-api-target.js";
import {
  type NativeApiReadResult,
  safeProviderText,
  verifyNativeApiResponse,
} from "./native-api-verify.js";
import {
  type NativeConfiguration,
  emptyNativePrivate,
} from "./native-connector-schema.js";
import {
  type NativeConnectorRecord,
  assertNativeConnectorRevision,
  loadNativeConnectorRecord,
  saveNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import {
  type NativeProviderTransport,
  nativeProviderTransport,
} from "./native-connector-transport.js";
import type { NativeConnectorView } from "./native-connector-view.js";

export type NativeApiConfigureInput = {
  providerId: string;
  connectionId?: string;
  revision?: number;
  displayName: string;
  icon?: string;
  parameters: Record<string, string>;
  credentials: Record<string, string>;
  requestedScopes?: Record<string, string[]>;
  targetIds?: Record<string, string>;
};
function requireApiRecord(id: string): NativeConnectorRecord {
  const record = loadNativeConnectorRecord(id);
  if (!record || record.configuration.method !== "api-key")
    throw new Error("Saved API-key connector not found");
  return record;
}
function verifiedRecord(
  id: string,
  revision: number,
  configuration: NativeConfiguration,
  credentials: Record<string, string>,
  label: string,
  origin: string,
  previousVerifiedAt = 0,
): NativeConnectorRecord {
  const verifiedAt = Math.max(Date.now(), previousVerifiedAt + 1);
  const privateState = emptyNativePrivate();
  privateState.credentials = credentials;
  privateState.grants.app = {
    kind: "api-key",
    providerId: configuration.providerId,
    actor: "app",
    fingerprint: configuration.fingerprint,
    targetId: origin,
    accessToken: credentials.api_key ?? "",
    expiresAt: null,
    scopes: null,
  };
  privateState.verification = {
    fingerprint: configuration.fingerprint,
    verifiedAt,
    kind: "provider",
  };
  return {
    connectionId: id,
    revision,
    configuration,
    privateState,
    runtime: {
      verifiedAt,
      identity: {
        id: `${configuration.providerId}:credential`,
        label,
        kind: "api-credential",
        assurance: "credential-valid",
      },
      targets: [{ id: origin, label: origin, kind: "api" }],
      grants: [
        {
          actor: "app",
          label: "API key",
          permissionState: "provider-managed",
          grantedScopes: [],
          expiresAt: null,
          needsReauth: false,
        },
      ],
    },
  };
}
async function providerVerification(
  target: NativeApiTarget,
  credentials: Record<string, string>,
  transport: NativeProviderTransport,
) {
  assertNativeApiBrowserTarget(target);
  const request = nativeApiVerificationRequest(target, credentials);
  const body = await nativeApiHttp(request, transport);
  if (!target.profile.verify)
    throw new Error("Provider verification is unavailable");
  return {
    result: verifyNativeApiResponse(
      target.providerName,
      target.profile.verify,
      body,
      nativeApiExposedCredentials(target, credentials),
    ),
    origin: new URL(request.url).origin,
  };
}
function savedConfiguration(
  input: NativeApiConfigureInput,
): NativeConnectorRecord | null {
  const saved = input.connectionId
    ? requireApiRecord(input.connectionId)
    : null;
  if (
    saved &&
    (saved.configuration.providerId !== input.providerId ||
      input.revision !== saved.revision)
  )
    throw new Error("Connector changed; reload before saving");
  if (
    saved &&
    (saved.privateState.recovery.length ||
      Object.keys(saved.privateState.pending).length)
  )
    throw new Error("Finish provider authorization cleanup before editing");
  if (
    Object.values(input.requestedScopes ?? {}).some(
      (scopes) => scopes.length,
    ) ||
    (Object.keys(input.targetIds ?? {}).length > 0 &&
      (!saved ||
        JSON.stringify(input.targetIds) !==
          JSON.stringify(saved.configuration.targetIds)))
  )
    throw new Error(
      "API-key permissions and targets are verified by this provider",
    );
  return saved;
}
async function configureVerification(
  target: NativeApiTarget,
  credentials: Record<string, string>,
  transport: NativeProviderTransport,
  saved: NativeConnectorRecord | null,
  fingerprint: string,
) {
  try {
    return await providerVerification(target, credentials, transport);
  } catch (error) {
    if (
      error instanceof NativeApiError &&
      error.code === "authorization" &&
      saved &&
      saved.configuration.fingerprint === fingerprint &&
      JSON.stringify(saved.privateState.credentials) ===
        JSON.stringify(credentials)
    )
      await invalidateNativeApiProof(saved, target, transport);
    throw error;
  }
}
export async function configureNativeApiConnector(
  input: NativeApiConfigureInput,
  transport: NativeProviderTransport = nativeProviderTransport(),
): Promise<NativeConnectorView> {
  transport.assertCurrent();
  const target = nativeApiTarget(input.providerId, input.parameters);
  assertNativeApiBrowserTarget(target);
  const saved = savedConfiguration(input);
  if (saved)
    await assertNativeConnectorRevision(saved.connectionId, {
      revision: saved.revision,
      fingerprint: saved.configuration.fingerprint,
    });
  const boundFingerprint = await nativeApiFingerprint(target);
  const retained =
    saved?.configuration.fingerprint === boundFingerprint
      ? saved.privateState.credentials
      : {};
  const credentials = nativeApiCredentials(target, input.credentials, retained);
  safeProviderText(input.displayName, credentials);
  safeProviderText(input.icon ?? "", credentials);
  for (const value of Object.values(target.parameters))
    safeProviderText(value, credentials);
  const { result, origin } = await configureVerification(
    target,
    credentials,
    transport,
    saved,
    boundFingerprint,
  );
  transport.assertCurrent();
  const configuration: NativeConfiguration = {
    version: 1,
    providerId: input.providerId,
    method: "api-key",
    displayName: input.displayName.trim(),
    icon: input.icon ?? "",
    parameters: target.parameters,
    requestedScopes: {},
    targetIds: { api: origin },
    fingerprint: boundFingerprint,
  };
  const id = saved?.connectionId ?? `conn_local_${crypto.randomUUID()}`;
  const next = verifiedRecord(
    id,
    saved?.revision ?? 1,
    configuration,
    credentials,
    result.label,
    origin,
    saved?.runtime.verifiedAt ?? 0,
  );
  if (!saved) return saveNativeConnector(next, target.classification);
  return updateNativeConnector(
    id,
    { revision: saved.revision, fingerprint: saved.configuration.fingerprint },
    target.classification,
    () => {
      transport.assertCurrent();
      return next;
    },
  );
}
export async function verifyNativeApiConnector(
  id: string,
  transport: NativeProviderTransport = nativeProviderTransport(),
): Promise<NativeConnectorView> {
  transport.assertCurrent();
  const record = requireApiRecord(id);
  assertNativeApiEditable(record);
  const target = nativeApiTarget(
    record.configuration.providerId,
    record.configuration.parameters,
  );
  await requireNativeApiBrowserAccess(record, target, transport);
  if ((await nativeApiFingerprint(target)) !== record.configuration.fingerprint)
    throw new Error(
      "Provider contract changed; configure this connection again",
    );
  await assertNativeConnectorRevision(id, {
    revision: record.revision,
    fingerprint: record.configuration.fingerprint,
  });
  let verified: Awaited<ReturnType<typeof providerVerification>>;
  try {
    verified = await providerVerification(
      target,
      record.privateState.credentials,
      transport,
    );
  } catch (error) {
    if (
      error instanceof NativeApiBrowserUnavailable ||
      (error instanceof NativeApiError && error.code === "authorization")
    )
      await invalidateNativeApiProof(record, target, transport);
    throw error;
  }
  const { result, origin } = verified;
  transport.assertCurrent();
  return updateNativeConnector(
    id,
    {
      revision: record.revision,
      fingerprint: record.configuration.fingerprint,
    },
    target.classification,
    () => {
      transport.assertCurrent();
      return verifiedRecord(
        id,
        record.revision,
        record.configuration,
        record.privateState.credentials,
        result.label,
        origin,
        record.runtime.verifiedAt ?? 0,
      );
    },
  );
}
export async function invokeNativeApiConnector(
  id: string,
  operation: string,
  input: Record<string, string> = {},
  transport: NativeProviderTransport = nativeProviderTransport(),
): Promise<NativeApiReadResult> {
  transport.assertCurrent();
  if (operation !== "provider.read" || Object.keys(input).length)
    throw new Error("Unsupported provider API operation");
  const record = requireApiRecord(id);
  const target = nativeApiTarget(
    record.configuration.providerId,
    record.configuration.parameters,
  );
  await requireNativeApiBrowserAccess(record, target, transport);
  assertNativeApiAuthority(record);
  if ((await nativeApiFingerprint(target)) !== record.configuration.fingerprint)
    throw new Error(
      "Provider contract changed; configure this connection again",
    );
  await assertNativeConnectorRevision(id, {
    revision: record.revision,
    fingerprint: record.configuration.fingerprint,
  });
  try {
    const { result } = await providerVerification(
      target,
      record.privateState.credentials,
      transport,
    );
    await assertNativeConnectorRevision(id, {
      revision: record.revision,
      fingerprint: record.configuration.fingerprint,
    });
    transport.assertCurrent();
    return result;
  } catch (error) {
    if (
      error instanceof NativeApiBrowserUnavailable ||
      (error instanceof NativeApiError && error.code === "authorization")
    )
      await invalidateNativeApiProof(record, target, transport);
    throw error;
  }
}

export { executeNativeApiRequest } from "./native-api-operations.js";
export type { NativeApiOperationDefinition } from "./native-api-operations.js";
export { nativeApiCleanup } from "./native-api-cleanup.js";
