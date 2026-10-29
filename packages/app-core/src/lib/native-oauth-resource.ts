/** A configured OAuth resource is read before its grant is activated or returned. */
import { canonicalize, isJsonObject, isString } from "@opensesame/os-domain";
import type { BoundaryValue } from "@opensesame/os-domain";
import { NativeApiError, nativeApiHttp } from "./native-api-http.js";
import type { NativeGrant, NativeRuntime } from "./native-connector-schema.js";
import {
  type NativeConnectorRecord,
  readNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import {
  type NativeOAuthClientOwner,
  assertNativeOAuthClientOwner,
  assertNativeOAuthClientPolicy,
  nativeOAuthClientClassification,
  nativeOAuthClientTarget,
  readNativeOAuthClientSecret,
} from "./native-oauth-client-config.js";
import { admissibleGrantScopes } from "./native-oauth-client-scopes.js";
import { commitNativeOAuthGrant } from "./native-oauth-commit.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import {
  nativeOAuthGuard,
  requireNativeOAuthRecord,
} from "./native-oauth-session.js";

function actualResource(
  record: NativeConnectorRecord,
  grant: NativeGrant,
): string {
  const target = nativeOAuthClientTarget(record.configuration);
  if (
    !target.resource ||
    grant.resource !== target.resource ||
    grant.issuer !== target.issuer ||
    grant.endpoint !== target.token_endpoint ||
    grant.clientId !== target.clientId ||
    grant.fingerprint !== record.configuration.fingerprint ||
    grant.kind !== "oauth" ||
    (grant.expiresAt !== null && grant.expiresAt <= Date.now())
  )
    throw new NativeOAuthError("expired");
  if (
    !admissibleGrantScopes(
      record.configuration.providerId,
      record.configuration.requestedScopes[grant.actor] ?? [],
      grant.scopes,
    )
  )
    throw new NativeOAuthError("scope");
  return target.resource;
}
function resourceTransport(
  record: NativeConnectorRecord,
  grant: NativeGrant,
  owner: NativeOAuthClientOwner,
): NativeProviderTransport {
  const check = () => {
    assertNativeOAuthClientOwner(owner);
    readNativeOAuthClientSecret(record.connectionId, owner);
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
function resourceFailed(body: BoundaryValue): boolean {
  if (!isJsonObject(body)) return false;
  if (isString(body.error) && body.error.trim().length > 0) return true;
  if (isJsonObject(body.error) && Object.keys(body.error).length > 0)
    return true;
  if (Array.isArray(body.errors) && body.errors.length > 0) return true;
  if (
    isString(body.error_description) &&
    body.error_description.trim().length > 0
  )
    return true;
  return (
    body.success === false ||
    body.ok === false ||
    body.status === "error" ||
    body.status === "failed"
  );
}
async function readResource(
  record: NativeConnectorRecord,
  grant: NativeGrant,
  owner: NativeOAuthClientOwner,
): Promise<BoundaryValue> {
  const url = actualResource(record, grant);
  assertNativeOAuthClientPolicy(record.configuration, owner);
  const transport = resourceTransport(record, grant, owner);
  try {
    const body = await nativeApiHttp(
      {
        url,
        method: "GET",
        headers: new Headers({
          accept: "application/json",
          authorization: `Bearer ${grant.accessToken}`,
        }),
        signal: transport.signal,
      },
      transport,
    );
    if (resourceFailed(body)) throw new NativeApiError("response", 200);
    return body;
  } catch (error) {
    if (error instanceof NativeApiError && error.status === 401) {
      const current = requireNativeOAuthRecord(record.connectionId);
      if (current.revision === record.revision)
        await updateNativeConnector(
          current.connectionId,
          nativeOAuthGuard(current),
          nativeOAuthClientClassification(),
          (latest) => {
            latest.privateState.verification = null;
            latest.runtime.verifiedAt = null;
            latest.runtime.grants = latest.runtime.grants.map((item) => ({
              ...item,
              needsReauth: true,
            }));
            return latest;
          },
          () => assertNativeOAuthClientOwner(owner),
        );
    }
    throw error;
  }
}
function verification(record: NativeConnectorRecord, grant: NativeGrant) {
  const resource = actualResource(record, grant);
  const identity: NonNullable<NativeRuntime["identity"]> = {
    id: resource,
    label: record.configuration.displayName,
    kind: "api-resource",
    assurance: "credential-valid",
  };
  return {
    identity,
    targets: [{ id: resource, label: resource, kind: "api" }],
    scopes: grant.scopes,
  };
}
export async function verifyNativeOAuthResource(
  id: string,
  owner: NativeOAuthClientOwner,
) {
  const record = requireNativeOAuthRecord(id);
  const retained = record.privateState.recovery.filter(
    (item) => item.credentials?.phase === "verify",
  );
  if (retained.length) {
    const intent = retained[0];
    const grant = intent?.grant;
    if (
      retained.length !== 1 ||
      !intent ||
      !grant ||
      intent.credentials?.protocol_valid !== "true"
    )
      throw new NativeOAuthError("cleanup");
    const body = await readResource(record, grant, owner);
    const view = await commitNativeOAuthGrant(
      id,
      intent.id,
      verification(record, grant),
      nativeOAuthClientClassification,
      resourceTransport(record, grant, owner),
      { revision: record.revision, grant },
    );
    return { view, body };
  }
  if (
    record.privateState.recovery.length ||
    Object.keys(record.privateState.pending).length
  )
    throw new NativeOAuthError("cleanup");
  const grant = record.privateState.grants.user;
  if (!grant || !readNativeConnector(id)?.verifiedAt)
    throw new NativeOAuthError("expired");
  const body = await readResource(record, grant, owner);
  const view = await updateNativeConnector(
    id,
    nativeOAuthGuard(record),
    nativeOAuthClientClassification(),
    (current) => {
      if (
        canonicalize(current.privateState.grants.user) !== canonicalize(grant)
      )
        throw new NativeOAuthError("expired");
      const verifiedAt = Math.max(
        Date.now(),
        (current.runtime.verifiedAt ?? 0) + 1,
      );
      current.privateState.verification = {
        fingerprint: current.configuration.fingerprint,
        verifiedAt,
        kind: "provider",
      };
      current.runtime.verifiedAt = verifiedAt;
      return current;
    },
    resourceTransport(record, grant, owner).assertCurrent,
  );
  return { view, body };
}
