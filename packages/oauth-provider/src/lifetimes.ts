import { overlapCast } from "@opensesame/os-domain";
import { type KoaContext, errors } from "oidc-provider";
import { SERVICE_ACCESS_TOKEN_MAX_SECONDS } from "./grants/client-credentials.js";

/**
 * How long each artifact the provider issues lives, and who may introspect
 * or revoke a token.
 *
 * oidc-provider has a default for each and, on first use, asks that a
 * deployment decide instead ("you SHOULD change it"). These are those
 * decisions, written down: the lifetimes and policies the defaults already
 * gave, so that changing one is a reviewed diff here rather than a side
 * effect of a library upgrade. Features this provider leaves off (CIBA,
 * pre-authorized codes) have no entry.
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The part of a token these rules read. */
type TokenView = {
  clientId?: string;
  resourceServer?: { accessTokenTTL?: number };
  isSenderConstrained?: () => boolean;
};

/** The part of a client these rules read. */
type ClientView = {
  clientId: string;
  clientAuthMethod?: string;
  applicationType?: string;
};

/** The part of the request context these rules read. */
type ContextView = {
  oidc?: { entities?: { RotatedRefreshToken?: { remainingTTL: number } } };
};

const tokenOf = (value: KoaContext) =>
  overlapCast<KoaContext, TokenView>(value);
const clientOf = (value: KoaContext) =>
  overlapCast<KoaContext, ClientView>(value);

export const ARTIFACT_LIFETIMES = {
  /** An hour, unless the resource server the token is for says otherwise. */
  AccessToken: (_ctx: KoaContext, token: KoaContext) =>
    tokenOf(token).resourceServer?.accessTokenTTL || HOUR,
  AuthorizationCode: MINUTE,
  ClientCredentials: SERVICE_ACCESS_TOKEN_MAX_SECONDS,
  DeviceCode: 10 * MINUTE,
  IdToken: HOUR,
  Interaction: HOUR,
  Session: 14 * DAY,
  Grant: 14 * DAY,
  /**
   * Fourteen days; but a browser app's rotated refresh token that is not
   * bound to a key cannot outlive the one it replaced, so rotation never
   * makes it last forever.
   */
  RefreshToken: (
    ctx: KoaContext | undefined,
    token: KoaContext,
    client: KoaContext,
  ) => {
    // A token made outside a request (a background job) has no context.
    const rotated = overlapCast<
      KoaContext | undefined,
      ContextView | undefined
    >(ctx)?.oidc?.entities?.RotatedRefreshToken;
    const { applicationType, clientAuthMethod } = clientOf(client);
    if (
      rotated &&
      applicationType === "web" &&
      clientAuthMethod === "none" &&
      tokenOf(token).isSenderConstrained?.() !== true
    ) {
      return rotated.remainingTTL;
    }
    return 14 * DAY;
  },
};

/**
 * A public client may introspect only its own tokens; a client that
 * authenticates may introspect any (RFC 7662 § 2.1 leaves the choice here).
 */
export async function introspectionAllowed(
  _ctx: KoaContext,
  client: KoaContext,
  token: KoaContext,
): Promise<boolean> {
  const caller = clientOf(client);
  return !(
    caller.clientAuthMethod === "none" &&
    tokenOf(token).clientId !== caller.clientId
  );
}

/**
 * Only the client a token was issued to may revoke it. A public client that
 * tries another's is told it succeeded, so revocation cannot be used to test
 * whether a guessed token is live (RFC 7009 § 2.2); a client that
 * authenticates is refused outright.
 */
export async function revocationAllowed(
  _ctx: KoaContext,
  client: KoaContext,
  token: KoaContext,
): Promise<boolean> {
  const caller = clientOf(client);
  if (tokenOf(token).clientId === caller.clientId) return true;
  if (caller.clientAuthMethod === "none") return false;
  throw new errors.InvalidRequest(
    "client is not authorized to revoke the presented token",
  );
}
