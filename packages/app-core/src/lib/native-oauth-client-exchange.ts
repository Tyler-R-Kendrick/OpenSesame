import type { BoundaryValue } from "@opensesame/os-domain";
/** Shared code exchange retains actual minted credentials before freshness checks. */
import { sha256Base64Url } from "@opensesame/sdk-browser";
import { z } from "zod";
import type { NativeGrant } from "./native-connector-schema.js";
import { updateNativeConnector } from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import {
  assertGoogleDriveAccountScopes,
  isGoogleDriveAccountScopeSet,
} from "./native-google-drive-account.js";
import {
  type NativeOAuthClientOwner,
  assertNativeOAuthClientOwner,
  assertNativeOAuthClientPolicy,
  initializeNativeOAuthClientCustody,
  nativeOAuthClientClassification,
  nativeOAuthClientTarget,
  readNativeOAuthClientSecret,
} from "./native-oauth-client-config.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import { nativeOAuthHttp } from "./native-oauth-http.js";
import {
  claimNativeOAuthPending,
  journalNativeOAuthGrant,
  markNativeOAuthMutationInFlight,
  nativeOAuthGuard,
  requireNativeOAuthRecord,
} from "./native-oauth-session.js";

const token = z
  .string()
  .min(1)
  .max(32768)
  .regex(/^[!-~]+$/);
const Pair = z.object({ access_token: token, refresh_token: token.optional() });
const Details = z.object({
  token_type: z
    .string()
    .transform((value) => value.toLowerCase())
    .pipe(z.literal("bearer")),
  expires_in: z
    .number()
    .finite()
    .positive()
    .max(365 * 86400)
    .optional(),
  scope: z.string().max(32768).optional(),
});
function encoded(value: string): string {
  return new URLSearchParams({ v: value }).toString().slice(2);
}
function authenticatedTransport(
  base: NativeProviderTransport,
  endpoint: string,
  basic: string | undefined,
  check: () => void,
): NativeProviderTransport {
  const wrap =
    (send: typeof fetch): typeof fetch =>
    async (input, init) => {
      check();
      const request = new Request(input, init);
      if (request.url !== endpoint || request.method !== "POST")
        throw new NativeOAuthError("expired");
      if (basic) request.headers.set("authorization", `Basic ${basic}`);
      return send(request);
    };
  const transport: NativeProviderTransport = {
    fetch: wrap(base.fetch),
    assertCurrent: check,
    signal: base.signal,
  };
  if (base.settleCredentialMutation)
    transport.settleCredentialMutation = wrap(base.settleCredentialMutation);
  return transport;
}
function issued(
  body: BoundaryValue,
  status: number,
  pending: Awaited<ReturnType<typeof claimNativeOAuthPending>>["pending"],
) {
  const pair = Pair.safeParse(body);
  if (!pair.success) throw new NativeOAuthError("provider");
  const details = Details.safeParse(body);
  const scopes =
    details.success && details.data.scope !== undefined
      ? [...new Set(details.data.scope.split(/\s+/).filter(Boolean))]
      : null;
  const validScopes =
    scopes === null ||
    (scopes.length <= 256 && scopes.every((scope) => scope.length <= 512));
  const accountScopes = isGoogleDriveAccountScopeSet(
    pending.providerId,
    scopes,
  );
  const grant: NativeGrant = {
    kind: "oauth",
    providerId: pending.providerId,
    actor: pending.actor,
    fingerprint: pending.fingerprint,
    issuer: pending.issuer,
    endpoint: pending.endpoint,
    clientId: pending.clientId,
    resource: pending.resource,
    accessToken: pair.data.access_token,
    refreshToken: pair.data.refresh_token,
    expiresAt:
      details.success && details.data.expires_in !== undefined
        ? Date.now() + details.data.expires_in * 1000
        : null,
    scopes: validScopes && accountScopes ? scopes : null,
  };
  return {
    grant,
    valid:
      status >= 200 &&
      status < 300 &&
      details.success &&
      validScopes &&
      accountScopes,
  };
}
function exchangeForm(
  target: ReturnType<typeof nativeOAuthClientTarget>,
  pending: Awaited<ReturnType<typeof claimNativeOAuthPending>>["pending"],
  code: string,
  secret: string | undefined,
) {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: code,
    code_verifier: pending.verifier,
    redirect_uri: pending.redirectUri,
  });
  let basic: string | undefined;
  const relay = target.token_relay_url !== undefined;
  if (!relay && target.token_auth_method === "client_secret_basic")
    basic = btoa(`${encoded(target.clientId)}:${encoded(secret ?? "")}`);
  else form.set("client_id", target.clientId);
  if (!relay && target.token_auth_method === "client_secret_post")
    form.set("client_secret", secret ?? "");
  if (target.resource && target.resource_parameter !== "omit")
    form.set("resource", target.resource);
  return { form, basic };
}
const RejectedExchange = z
  .object({
    error: z.enum([
      "invalid_request",
      "invalid_client",
      "invalid_grant",
      "unauthorized_client",
      "unsupported_grant_type",
      "invalid_scope",
    ]),
    error_description: z.string().max(4096).optional(),
    error_uri: z.string().url().max(4096).optional(),
  })
  .strict();
async function recordDefinitiveRejection(
  claim: Awaited<ReturnType<typeof claimNativeOAuthPending>>,
  response: Awaited<ReturnType<typeof nativeOAuthHttp>>,
): Promise<void> {
  if (
    response.status !== 400 ||
    !RejectedExchange.safeParse(response.body).success
  )
    return;
  await updateNativeConnector(
    claim.record.connectionId,
    nativeOAuthGuard(claim.record),
    nativeOAuthClientClassification(),
    (record) => {
      const intent = record.privateState.recovery.find(
        (item) => item.id === claim.obligation.id,
      );
      if (
        !intent ||
        intent.fingerprint !== claim.pending.fingerprint ||
        intent.grant ||
        intent.credentials?.phase !== "exchange"
      )
        throw new NativeOAuthError("expired");
      record.privateState.recovery = record.privateState.recovery.filter(
        (item) => item.id !== intent.id,
      );
      return record;
    },
  );
}
export interface NativeOAuthClientExchangeReceipt {
  connectionId: string;
  intentId: string;
}
export async function exchangeNativeOAuthClient(
  search: string,
  owner: NativeOAuthClientOwner,
): Promise<NativeOAuthClientExchangeReceipt> {
  assertNativeOAuthClientOwner(owner);
  await initializeNativeOAuthClientCustody();
  assertNativeOAuthClientOwner(owner);
  const claim = await claimNativeOAuthPending(
    search,
    nativeOAuthClientClassification(),
  );
  const id = claim.record.connectionId;
  const target = nativeOAuthClientTarget(claim.record.configuration);
  const pending = claim.pending;
  assertGoogleDriveAccountScopes(pending.providerId, pending.scopes);
  if (
    pending.endpoint !== target.token_endpoint ||
    pending.issuer !== target.issuer ||
    pending.resource !== target.resource ||
    pending.clientId !== target.clientId ||
    pending.redirectUri !== target.redirectUri
  )
    throw new NativeOAuthError("expired");
  assertNativeOAuthClientPolicy(claim.record.configuration, owner);
  const secret = readNativeOAuthClientSecret(id, owner);
  const credentialDigest = await sha256Base64Url(secret ?? "");
  if (
    claim.record.privateState.credentials.oauth_client_consent !==
    `${pending.state}:${credentialDigest}`
  )
    throw new NativeOAuthError("expired");
  const guard = () => {
    assertNativeOAuthClientOwner(owner);
    const current = requireNativeOAuthRecord(id);
    if (
      current.revision !== claim.record.revision ||
      current.configuration.fingerprint !== pending.fingerprint
    )
      throw new NativeOAuthError("expired");
    if (readNativeOAuthClientSecret(id, owner) !== secret)
      throw new NativeOAuthError("expired");
  };
  const { form, basic } = exchangeForm(target, pending, claim.code, secret);
  const endpoint = target.token_relay_url ?? target.token_endpoint;
  const release = markNativeOAuthMutationInFlight(id, claim.obligation.id);
  try {
    const response = await nativeOAuthHttp(
      endpoint,
      form,
      authenticatedTransport(owner.transport, endpoint, basic, guard),
    );
    await recordDefinitiveRejection(claim, response);
    const receipt = issued(response.body, response.status, pending);
    await journalNativeOAuthGrant(
      id,
      claim.obligation.id,
      receipt.grant,
      nativeOAuthClientClassification,
      {
        protocol_valid: String(receipt.valid),
        requested_scopes: JSON.stringify(pending.scopes),
      },
    );
    assertNativeOAuthClientOwner(owner);
    const current = requireNativeOAuthRecord(id);
    if (
      current.configuration.fingerprint !== pending.fingerprint ||
      current.revision !== claim.record.revision + 1
    )
      throw new NativeOAuthError("expired");
    if (readNativeOAuthClientSecret(id, owner) !== secret)
      throw new NativeOAuthError("expired");
    if (!receipt.valid) throw new NativeOAuthError("provider");
    if (
      receipt.grant.scopes &&
      pending.scopes.some((scope) => !receipt.grant.scopes?.includes(scope))
    )
      throw new NativeOAuthError("scope");
    return { connectionId: id, intentId: claim.obligation.id };
  } finally {
    release();
  }
}
