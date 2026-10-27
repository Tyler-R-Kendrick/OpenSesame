/** A configured OAuth resource is read before its grant is activated or returned. */
import { canonicalize, isJsonObject, isString } from "@opensesame/os-domain";
import type { BoundaryValue } from "@opensesame/os-domain";
import { connectPlan } from "./connect-plan.js";
import {
  NativeApiError,
  type NativeApiHttpRequest,
  nativeApiHttp,
} from "./native-api-http.js";
import { providerTemplate } from "./native-api-target.js";
import { verifyNativeApiResponse } from "./native-api-verify.js";
import type { NativeGrant, NativeRuntime } from "./native-connector-schema.js";
import {
  type NativeConnectorRecord,
  readNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { assertGoogleDriveAccountScopes } from "./native-google-drive-account.js";
import {
  type NativeOAuthClientOwner,
  assertNativeOAuthClientOwner,
  assertNativeOAuthClientPolicy,
  nativeOAuthClientClassification,
  nativeOAuthClientTarget,
  readNativeOAuthClientSecret,
} from "./native-oauth-client-config.js";
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
  assertGoogleDriveAccountScopes(record.configuration.providerId, grant.scopes);
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
function matchesContractUrl(template: string, url: string): boolean {
  const pattern = template
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\\{[a-z_]+\\}/g, "[^/?#]+");
  return new RegExp(`^${pattern}$`).test(url);
}
function resourceContract(record: NativeConnectorRecord, url: string) {
  const verify = connectPlan(record.configuration.providerId)?.methods.find(
    (method) => method.kind === "oauth",
  )?.preset?.verify;
  return verify && matchesContractUrl(verify.url, url) ? verify : null;
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
function resourceHeaders(
  record: NativeConnectorRecord,
  grant: NativeGrant,
  contract: ReturnType<typeof resourceContract>,
): Headers {
  const headers = new Headers(contract?.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  if (contract?.auth) {
    if (contract.auth.kind !== "header") throw new NativeOAuthError("scope");
    const value = contract.auth.valueTemplate
      ? providerTemplate(
          contract.auth.valueTemplate,
          record.configuration.parameters,
          { api_key: grant.accessToken },
        )
      : `${contract.auth.scheme ? `${contract.auth.scheme} ` : ""}${grant.accessToken}`;
    headers.set(contract.auth.header, value);
  } else headers.set("authorization", `Bearer ${grant.accessToken}`);
  return headers;
}

function verifyResourceResponse(
  record: NativeConnectorRecord,
  grant: NativeGrant,
  contract: ReturnType<typeof resourceContract>,
  body: BoundaryValue,
): void {
  if (contract) {
    const plan = connectPlan(record.configuration.providerId);
    verifyNativeApiResponse(
      plan?.name ?? record.configuration.displayName,
      contract,
      body,
      { access_token: grant.accessToken },
    );
  } else if (resourceFailed(body)) throw new NativeApiError("response", 200);
}

async function readResource(
  record: NativeConnectorRecord,
  grant: NativeGrant,
  owner: NativeOAuthClientOwner,
): Promise<BoundaryValue> {
  const url = actualResource(record, grant);
  assertNativeOAuthClientPolicy(record.configuration, owner);
  const transport = resourceTransport(record, grant, owner);
  const contract = resourceContract(record, url);
  try {
    const request: NativeApiHttpRequest = {
      url,
      method: contract?.method ?? "GET",
      headers: resourceHeaders(record, grant, contract),
      signal: transport.signal,
    };
    if (contract && contract.body !== null) request.body = contract.body;
    const body = await nativeApiHttp(request, transport);
    verifyResourceResponse(record, grant, contract, body);
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
