import { z } from "zod";
import type {
  NativeConfiguration,
  NativeGrant,
} from "./native-connector-schema.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import { nativeOAuthHttp } from "./native-oauth-http.js";
import {
  type NativeOriginOwner,
  assertNativeOriginPolicy,
  importNativeOriginPrivateKey,
  nativeOriginTarget,
  readNativeOriginPrivateKey,
} from "./native-origin-configuration.js";
import { createNativeOriginAppJwt } from "./native-origin-jwt.js";

const Minted = z
  .object({
    token: z
      .string()
      .max(32768)
      .regex(/^oit_[!-~]+$/),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();
export class NativeOriginMintError extends Error {
  constructor(readonly status: number) {
    super("Origin could not mint an installation access token");
    this.name = "NativeOriginMintError";
  }
}
export function nativeOriginInstallationTokenUrl(
  configuration: NativeConfiguration,
  installationId: string,
): string {
  const target = nativeOriginTarget(configuration);
  const id = z.string().min(1).max(256).parse(installationId);
  return `${target.token_endpoint}/${encodeURIComponent(id)}/access_tokens`;
}
function guardedTransport(
  owner: NativeOriginOwner,
  endpoint: string,
  check: () => void,
): NativeProviderTransport {
  const wrap =
    (send: typeof fetch): typeof fetch =>
    async (input, init) => {
      check();
      const request = new Request(input, init);
      if (request.url !== endpoint || request.method !== "POST")
        throw new NativeOAuthError("expired");
      return send(request);
    };
  const transport: NativeProviderTransport = {
    fetch: wrap(owner.transport.fetch),
    assertCurrent: check,
    signal: owner.transport.signal,
  };
  if (owner.transport.settleCredentialMutation)
    transport.settleCredentialMutation = wrap(
      owner.transport.settleCredentialMutation,
    );
  return transport;
}
export async function mintNativeOriginInstallationToken(input: {
  connectionId: string;
  configuration: NativeConfiguration;
  installationId: string;
  scopes: readonly string[];
  repositoryIds?: readonly string[];
  owner: NativeOriginOwner;
  check?: () => void;
}): Promise<NativeGrant> {
  const {
    connectionId,
    configuration,
    installationId,
    scopes,
    repositoryIds = [],
    owner,
  } = input;
  const target = nativeOriginTarget(configuration);
  const endpoint = nativeOriginInstallationTokenUrl(
    configuration,
    installationId,
  );
  const check = () => {
    assertNativeOriginPolicy(configuration, owner, endpoint);
    input.check?.();
  };
  check();
  const pem = readNativeOriginPrivateKey(connectionId, owner);
  const appKey = await importNativeOriginPrivateKey(pem);
  const appJwt = await createNativeOriginAppJwt(target.clientId, appKey);
  check();
  const selectedScopes = z
    .array(z.string().min(1).max(512))
    .max(256)
    .parse([...new Set(scopes)]);
  const repositories = z
    .array(z.string().min(1).max(256))
    .max(50)
    .parse(repositoryIds);
  if (new Set(repositories).size !== repositories.length)
    throw new NativeOAuthError("scope");
  const body: Record<string, string[]> = {};
  if (selectedScopes.length) body.scopes = selectedScopes;
  if (repositories.length) body.repositoryIds = repositories;
  const response = await nativeOAuthHttp(
    endpoint,
    JSON.stringify(body),
    guardedTransport(owner, endpoint, check),
    appJwt.token,
  );
  check();
  if (response.status < 200 || response.status >= 300)
    throw new NativeOriginMintError(response.status);
  const parsed = Minted.safeParse(response.body);
  if (!parsed.success) throw new NativeOAuthError("provider");
  const expiresAt = Date.parse(parsed.data.expiresAt);
  const now = Date.now();
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + 900_000 ||
    expiresAt > appJwt.expiresAt
  )
    throw new NativeOAuthError("provider");
  check();
  return {
    kind: "oauth",
    providerId: configuration.providerId,
    actor: "user",
    fingerprint: configuration.fingerprint,
    targetId: installationId,
    issuer: target.issuer,
    endpoint: target.token_endpoint,
    clientId: target.clientId,
    resource: target.resource,
    accessToken: parsed.data.token,
    expiresAt,
    scopes: selectedScopes,
  };
}
