import { randomBytes, randomInt } from "node:crypto";
import { constantTimeEqual, hmacDigest } from "./claim-token.js";

/** Purpose labels keep AgentAuth digests domain-separated from osc_clm_ claims. */
export const AGENT_CLAIM_TOKEN_PURPOSE = "opensesame:agent-auth:claim-token:v1";
export const AGENT_CLAIM_ATTEMPT_PURPOSE =
  "opensesame:agent-auth:claim-attempt:v1";
export const AGENT_USER_CODE_PURPOSE = "opensesame:agent-auth:user-code:v1";
export const AGENT_ACCESS_TOKEN_PURPOSE =
  "opensesame:agent-auth:access-token:v1";

export const AGENT_CLAIM_TOKEN_PREFIX = "clm_";
export const AGENT_CLAIM_ATTEMPT_PREFIX = "clat_";
export const AGENT_ACCESS_TOKEN_PREFIX = "aat_";
export const AGENT_REGISTRATION_PREFIX = "areg_";

function encodeBase64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export interface GeneratedOpaqueToken {
  token: string;
  publicId: string;
  secret: string;
  digest: Uint8Array;
}

function generatePrefixedToken(
  prefix: string,
  purpose: string,
  pepper: Uint8Array | string,
  publicId: string = encodeBase64Url(randomBytes(16)),
  secretBytes: Buffer = randomBytes(32),
): GeneratedOpaqueToken {
  const secret = encodeBase64Url(secretBytes);
  const token = `${prefix}${publicId}.${secret}`;
  const digest = hmacDigest(pepper, purpose, publicId, secret);
  return { token, publicId, secret, digest };
}

function parsePrefixedToken(
  prefix: string,
  token: string,
): { publicId: string; secret: string } | null {
  if (!token.startsWith(prefix)) return null;
  const rest = token.slice(prefix.length);
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot === rest.length - 1) return null;
  const publicId = rest.slice(0, dot);
  const secret = rest.slice(dot + 1);
  if (!publicId || !secret) return null;
  return { publicId, secret };
}

export function generateAgentClaimToken(
  pepper: Uint8Array | string,
): GeneratedOpaqueToken {
  return generatePrefixedToken(
    AGENT_CLAIM_TOKEN_PREFIX,
    AGENT_CLAIM_TOKEN_PURPOSE,
    pepper,
  );
}

export function parseAgentClaimToken(
  token: string,
): { publicId: string; secret: string } | null {
  return parsePrefixedToken(AGENT_CLAIM_TOKEN_PREFIX, token);
}

export function digestAgentClaimToken(
  pepper: Uint8Array | string,
  token: string,
): Uint8Array | null {
  const parsed = parseAgentClaimToken(token);
  if (!parsed) return null;
  return hmacDigest(
    pepper,
    AGENT_CLAIM_TOKEN_PURPOSE,
    parsed.publicId,
    parsed.secret,
  );
}

export function verifyAgentClaimToken(
  pepper: Uint8Array | string,
  token: string,
  expectedDigest: Uint8Array,
): boolean {
  const digest = digestAgentClaimToken(pepper, token);
  if (!digest) return false;
  return constantTimeEqual(digest, expectedDigest);
}

export function generateAgentClaimAttemptToken(
  pepper: Uint8Array | string,
): GeneratedOpaqueToken {
  return generatePrefixedToken(
    AGENT_CLAIM_ATTEMPT_PREFIX,
    AGENT_CLAIM_ATTEMPT_PURPOSE,
    pepper,
  );
}

export function parseAgentClaimAttemptToken(
  token: string,
): { publicId: string; secret: string } | null {
  return parsePrefixedToken(AGENT_CLAIM_ATTEMPT_PREFIX, token);
}

export function digestAgentClaimAttemptToken(
  pepper: Uint8Array | string,
  token: string,
): Uint8Array | null {
  const parsed = parseAgentClaimAttemptToken(token);
  if (!parsed) return null;
  return hmacDigest(
    pepper,
    AGENT_CLAIM_ATTEMPT_PURPOSE,
    parsed.publicId,
    parsed.secret,
  );
}

export function verifyAgentClaimAttemptToken(
  pepper: Uint8Array | string,
  token: string,
  expectedDigest: Uint8Array,
): boolean {
  const digest = digestAgentClaimAttemptToken(pepper, token);
  if (!digest) return false;
  return constantTimeEqual(digest, expectedDigest);
}

export function generateAgentAccessToken(
  pepper: Uint8Array | string,
): GeneratedOpaqueToken {
  return generatePrefixedToken(
    AGENT_ACCESS_TOKEN_PREFIX,
    AGENT_ACCESS_TOKEN_PURPOSE,
    pepper,
  );
}

export function digestAgentAccessToken(
  pepper: Uint8Array | string,
  token: string,
): Uint8Array | null {
  const parsed = parsePrefixedToken(AGENT_ACCESS_TOKEN_PREFIX, token);
  if (!parsed) return null;
  return hmacDigest(
    pepper,
    AGENT_ACCESS_TOKEN_PURPOSE,
    parsed.publicId,
    parsed.secret,
  );
}

export function verifyAgentAccessToken(
  pepper: Uint8Array | string,
  token: string,
  expectedDigest: Uint8Array,
): boolean {
  const digest = digestAgentAccessToken(pepper, token);
  if (!digest) return false;
  return constantTimeEqual(digest, expectedDigest);
}

export function generateAgentRegistrationId(): string {
  return `${AGENT_REGISTRATION_PREFIX}${encodeBase64Url(randomBytes(16))}`;
}

export function generateAgentClaimAttemptId(): string {
  return `cla_${encodeBase64Url(randomBytes(16))}`;
}

export function generateAgentAccessTokenId(): string {
  return `aatid_${encodeBase64Url(randomBytes(12))}`;
}

/** Six-digit numeric user code as specified by the auth.md claim ceremony. */
export function generateAgentUserCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function normalizeAgentUserCode(code: string): string {
  return code.replace(/[\s-]/g, "");
}

export function digestAgentUserCode(
  pepper: Uint8Array | string,
  attemptId: string,
  code: string,
): Uint8Array {
  if (!attemptId) {
    throw new Error("digestAgentUserCode requires the claim attempt id");
  }
  return hmacDigest(
    pepper,
    AGENT_USER_CODE_PURPOSE,
    attemptId,
    normalizeAgentUserCode(code),
  );
}

export function verifyAgentUserCode(
  pepper: Uint8Array | string,
  attemptId: string,
  code: string,
  expectedDigest: Uint8Array,
): boolean {
  const digest = digestAgentUserCode(pepper, attemptId, code);
  return constantTimeEqual(digest, expectedDigest);
}

export function looksLikeAgentClaimToken(token: string): boolean {
  return parseAgentClaimToken(token) !== null;
}

export function looksLikeAgentAccessToken(token: string): boolean {
  return parsePrefixedToken(AGENT_ACCESS_TOKEN_PREFIX, token) !== null;
}
