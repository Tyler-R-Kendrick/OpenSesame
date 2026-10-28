import { canonicalize } from "@opensesame/os-domain";
import { z } from "zod";
import { NativeApiError, nativeApiHttp } from "./native-api-http.js";
import type { NativeGrant, NativeRuntime } from "./native-connector-schema.js";
import {
  type NativeConnectorRecord,
  updateNativeConnector,
} from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { commitNativeOAuthGrant } from "./native-oauth-commit.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import {
  journalNativeOAuthGrant,
  nativeOAuthGuard,
  requireNativeOAuthRecord,
} from "./native-oauth-session.js";
import {
  type NativeOriginOwner,
  ORIGIN_PROVIDER_ID,
  assertNativeOriginPolicy,
  nativeOriginClassification,
  nativeOriginTarget,
  readNativeOriginPrivateKey,
} from "./native-origin-configuration.js";
import {
  NativeOriginMintError,
  mintNativeOriginInstallationToken,
} from "./native-origin-token.js";

const Core = z.object({
  limit: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  reset: z.number().int().nonnegative(),
  used: z.number().int().nonnegative(),
});
const RateLimit = z.object({ resources: z.object({ core: Core }) });
export type NativeOriginRateLimit = z.infer<typeof Core>;
function actualGrant(record: NativeConnectorRecord, grant: NativeGrant) {
  const target = nativeOriginTarget(record.configuration);
  if (
    record.configuration.providerId !== ORIGIN_PROVIDER_ID ||
    grant.kind !== "oauth" ||
    grant.providerId !== ORIGIN_PROVIDER_ID ||
    grant.fingerprint !== record.configuration.fingerprint ||
    grant.issuer !== target.issuer ||
    grant.endpoint !== target.token_endpoint ||
    grant.resource !== target.resource ||
    grant.clientId !== target.clientId ||
    !grant.targetId ||
    grant.refreshToken !== undefined
  )
    throw new NativeOAuthError("expired");
  return grant;
}
function resourceTransport(
  record: NativeConnectorRecord,
  grant: NativeGrant,
  owner: NativeOriginOwner,
): NativeProviderTransport {
  const check = () => {
    owner.transport.assertCurrent();
    readNativeOriginPrivateKey(record.connectionId, owner);
    const current = requireNativeOAuthRecord(record.connectionId);
    if (
      current.revision !== record.revision ||
      current.configuration.fingerprint !== grant.fingerprint
    )
      throw new NativeOAuthError("expired");
  };
  return {
    assertCurrent: check,
    signal: owner.transport.signal,
    fetch: (input, init) => {
      check();
      return owner.transport.fetch(input, init);
    },
  };
}
async function readRateLimit(
  record: NativeConnectorRecord,
  grant: NativeGrant,
  owner: NativeOriginOwner,
): Promise<NativeOriginRateLimit> {
  actualGrant(record, grant);
  assertNativeOriginPolicy(record.configuration, owner);
  const transport = resourceTransport(record, grant, owner);
  const body = await nativeApiHttp(
    {
      url: nativeOriginTarget(record.configuration).resource,
      method: "GET",
      headers: new Headers({
        accept: "application/json",
        authorization: `Bearer ${grant.accessToken}`,
      }),
      signal: transport.signal,
    },
    transport,
  );
  const parsed = RateLimit.safeParse(body);
  if (!parsed.success) throw new NativeApiError("response", 200);
  return parsed.data.resources.core;
}
function verification(
  record: NativeConnectorRecord,
  grant: NativeGrant,
  verifiedInstallationId?: string,
) {
  actualGrant(record, grant);
  const installationId = verifiedInstallationId ?? grant.targetId ?? "";
  const identity: NonNullable<NativeRuntime["identity"]> = {
    id: installationId,
    label: `${record.configuration.displayName} installation`,
    kind: "origin-installation",
    assurance: "credential-valid",
  };
  return {
    identity,
    targets: [
      {
        id: installationId,
        label: installationId,
        kind: "origin-installation",
      },
    ],
    scopes: grant.scopes,
  };
}
function applyVerifiedRuntime(
  current: NativeConnectorRecord,
  grant: NativeGrant,
): void {
  const verified = verification(current, grant);
  const verifiedAt = Math.max(
    Date.now(),
    (current.runtime.verifiedAt ?? 0) + 1,
  );
  current.privateState.grants.user = grant;
  current.privateState.verification = {
    fingerprint: current.configuration.fingerprint,
    verifiedAt,
    kind: "provider",
  };
  current.runtime = {
    verifiedAt,
    identity: verified.identity,
    targets: verified.targets,
    grants: [
      {
        actor: "user",
        label: "Origin installation",
        permissionState: grant.scopes === null ? "provider-managed" : "known",
        grantedScopes: grant.scopes ?? [],
        expiresAt: grant.expiresAt,
        needsReauth: false,
      },
    ],
  };
}
async function markReauthorization(
  record: NativeConnectorRecord,
  owner: NativeOriginOwner,
  recoveryId?: string,
): Promise<never> {
  await updateNativeConnector(
    record.connectionId,
    nativeOAuthGuard(record),
    nativeOriginClassification(),
    (current) => {
      current.privateState.recovery = current.privateState.recovery.filter(
        (entry) => entry.id !== recoveryId,
      );
      current.privateState.verification = null;
      current.runtime.verifiedAt = null;
      current.runtime.identity = null;
      current.runtime.targets = [];
      current.runtime.grants = current.runtime.grants.map((grant) => ({
        ...grant,
        needsReauth: true,
      }));
      return current;
    },
    () => readNativeOriginPrivateKey(record.connectionId, owner),
  );
  throw new NativeOAuthError("expired");
}
function rejectedInstallation(error: Error): boolean {
  return (
    (error instanceof NativeOriginMintError &&
      [401, 403, 404].includes(error.status)) ||
    (error instanceof NativeApiError && error.status === 401)
  );
}
async function finishRotation(
  record: NativeConnectorRecord,
  intentId: string,
  grant: NativeGrant,
  owner: NativeOriginOwner,
) {
  return updateNativeConnector(
    record.connectionId,
    nativeOAuthGuard(record),
    nativeOriginClassification(),
    (current) => {
      const intent = current.privateState.recovery.find(
        (entry) => entry.id === intentId,
      );
      if (
        !intent ||
        canonicalize(intent.grant) !== canonicalize(grant) ||
        !current.privateState.grants.user
      )
        throw new NativeOAuthError("expired");
      current.privateState.recovery = current.privateState.recovery.filter(
        (entry) => entry.id !== intentId,
      );
      applyVerifiedRuntime(current, grant);
      return current;
    },
    resourceTransport(record, grant, owner).assertCurrent,
  );
}
async function rotateAndVerify(
  record: NativeConnectorRecord,
  previous: NativeGrant,
  owner: NativeOriginOwner,
) {
  actualGrant(record, previous);
  let minted: NativeGrant;
  try {
    minted = await mintNativeOriginInstallationToken({
      connectionId: record.connectionId,
      configuration: record.configuration,
      installationId: previous.targetId ?? "",
      scopes:
        previous.scopes ?? record.configuration.requestedScopes.user ?? [],
      owner,
      check: () => {
        const current = requireNativeOAuthRecord(record.connectionId);
        if (
          current.revision !== record.revision ||
          canonicalize(current.privateState.grants.user) !==
            canonicalize(previous)
        )
          throw new NativeOAuthError("expired");
      },
    });
  } catch (error) {
    if (error instanceof Error && rejectedInstallation(error))
      return markReauthorization(record, owner);
    throw error;
  }
  const intentId = `origin-remint:${crypto.randomUUID()}`;
  await updateNativeConnector(
    record.connectionId,
    nativeOAuthGuard(record),
    nativeOriginClassification(),
    (current) => {
      if (
        canonicalize(current.privateState.grants.user) !==
          canonicalize(previous) ||
        current.privateState.recovery.length
      )
        throw new NativeOAuthError("cleanup");
      current.privateState.recovery.push({
        id: intentId,
        kind: "configure",
        providerId: previous.providerId,
        actor: previous.actor,
        fingerprint: previous.fingerprint,
        targetId: previous.targetId ?? "",
        issuer: previous.issuer,
        resource: previous.resource,
        endpoint: previous.endpoint,
        clientId: previous.clientId,
        grant: previous,
        credentials: { phase: "refresh", protocol_valid: "true" },
      });
      return current;
    },
    () => readNativeOriginPrivateKey(record.connectionId, owner),
  );
  await journalNativeOAuthGrant(
    record.connectionId,
    intentId,
    minted,
    nativeOriginClassification,
    {},
    true,
  );
  const retained = requireNativeOAuthRecord(record.connectionId);
  const grant = retained.privateState.recovery.find(
    (entry) => entry.id === intentId,
  )?.grant;
  if (!grant) throw new NativeOAuthError("storage");
  try {
    const body = await readRateLimit(retained, grant, owner);
    const view = await finishRotation(retained, intentId, grant, owner);
    return { view, body };
  } catch (error) {
    if (error instanceof Error && rejectedInstallation(error))
      return markReauthorization(retained, owner, intentId);
    throw error;
  }
}
async function verifyRetained(
  record: NativeConnectorRecord,
  owner: NativeOriginOwner,
) {
  const retained = record.privateState.recovery.filter(
    (entry) =>
      entry.credentials?.phase === "verify" ||
      entry.credentials?.phase === "refresh",
  );
  const intent = retained[0];
  const grant = intent?.grant;
  if (
    retained.length !== 1 ||
    record.privateState.recovery.length !== 1 ||
    !intent ||
    !grant ||
    intent.credentials?.protocol_valid !== "true"
  )
    throw new NativeOAuthError("cleanup");
  try {
    const body = await readRateLimit(record, grant, owner);
    if (intent.id.startsWith("origin-remint:")) {
      const view = await finishRotation(record, intent.id, grant, owner);
      return { view, body };
    }
    const view = await commitNativeOAuthGrant(
      record.connectionId,
      intent.id,
      verification(record, grant, intent.credentials.installation_id),
      nativeOriginClassification,
      resourceTransport(record, grant, owner),
      { revision: record.revision, grant },
    );
    return { view, body };
  } catch (error) {
    if (error instanceof Error && rejectedInstallation(error))
      return markReauthorization(record, owner, intent.id);
    throw error;
  }
}
export async function verifyNativeOriginResource(
  id: string,
  owner: NativeOriginOwner,
) {
  const record = requireNativeOAuthRecord(id);
  if (record.privateState.recovery.length) return verifyRetained(record, owner);
  if (Object.keys(record.privateState.pending).length)
    throw new NativeOAuthError("cleanup");
  const grant = record.privateState.grants.user;
  const metadata = record.runtime.grants.find(
    (entry) => entry.actor === "user",
  );
  if (!grant || !record.runtime.verifiedAt || metadata?.needsReauth)
    throw new NativeOAuthError("expired");
  actualGrant(record, grant);
  if (grant.expiresAt === null || grant.expiresAt <= Date.now() + 30_000)
    return rotateAndVerify(record, grant, owner);
  try {
    const body = await readRateLimit(record, grant, owner);
    const view = await updateNativeConnector(
      id,
      nativeOAuthGuard(record),
      nativeOriginClassification(),
      (current) => {
        if (
          canonicalize(current.privateState.grants.user) !== canonicalize(grant)
        )
          throw new NativeOAuthError("expired");
        applyVerifiedRuntime(current, grant);
        return current;
      },
      resourceTransport(record, grant, owner).assertCurrent,
    );
    return { view, body };
  } catch (error) {
    if (error instanceof NativeApiError && error.status === 401)
      return rotateAndVerify(record, grant, owner);
    throw error;
  }
}
