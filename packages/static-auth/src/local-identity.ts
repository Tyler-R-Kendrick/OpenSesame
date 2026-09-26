import { type BoundaryValue, isString } from "@opensesame/os-domain";
import type {
  LocalAuthorizationRequest,
  localMessage,
} from "./local-protocol.js";

export type LocalBrowserIdentity = Readonly<{
  subject: string;
  audience: string;
  issuer: string;
  authTime: number;
  expiresAt: number;
}>;
export type LocalEnvelope = NonNullable<ReturnType<typeof localMessage>>;

/** An agent challenge lives at most two minutes and is not yet spent. */
export function validChallengeExpiry(expiresAt: number) {
  const now = Date.now();
  return (
    Number.isSafeInteger(expiresAt) &&
    expiresAt > now &&
    expiresAt - now <= 120_000
  );
}

function matchesSubject(
  sub: BoundaryValue,
  agent: LocalAuthorizationRequest["agent"],
): sub is string {
  return (
    isString(sub) &&
    /^local_[0-9a-f-]{36}$/.test(sub) &&
    (!agent || sub === agent.principalId)
  );
}

/** Accept an issuer's identity answer only for this exact request and origin. */
export function verifiedIdentity(
  message: LocalEnvelope,
  request: LocalAuthorizationRequest,
  origin: string,
  scope: string,
  now: number,
): LocalBrowserIdentity {
  const expiresAt = Number(message.expiresAt);
  const authTime = Number(message.authTime);
  if (
    message.type !== "identity" ||
    message.issuer !== origin ||
    message.audience !== request.applicationId ||
    message.nonce !== request.nonce ||
    message.scope !== scope ||
    !matchesSubject(message.sub, request.agent) ||
    !Number.isSafeInteger(expiresAt) ||
    !Number.isSafeInteger(authTime) ||
    authTime > now ||
    authTime < 0 ||
    expiresAt <= now ||
    expiresAt - authTime > 900_000
  )
    throw new Error("invalid_identity");
  return Object.freeze({
    subject: message.sub,
    audience: request.applicationId,
    issuer: origin,
    authTime,
    expiresAt,
  });
}
