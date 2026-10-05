/**
 * NATS JWT v2, as nats-server reads it (decentralized authentication): a
 * header, the claims, and an Ed25519 signature by the issuer's nkey, each
 * base64url without padding. Only what a live session and its reference
 * server need is written: user claims with subject permissions and an
 * expiry, and the operator and account claims that let a server trust an
 * account signing key (ADR 0167). The nkeys are `@nats-io/nkeys`; the
 * encoding is this file's, and a real nats-server is its oracle
 * (`verify:live-join`).
 */

import { type KeyPair, fromSeed } from "@nats-io/nkeys";
import type { JsonObject, JsonValue } from "@opensesame/os-domain";
import { toB64url } from "./b64.js";

const HEADER = { typ: "JWT", alg: "ed25519-nkey" };
const encoder = new TextEncoder();
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function b64json(value: JsonValue): string {
  return toB64url(encoder.encode(JSON.stringify(value)));
}

/** Subjects a credential may publish and subscribe to. */
export type SubjectPermissions = Readonly<{
  pub: readonly string[];
  sub: readonly string[];
  /** Allow publishing one reply to each request it receives (a service). */
  responses?: boolean;
}>;

export type ClaimsInput = Readonly<{
  /** The key the token is about: a user, an account, an operator. */
  subject: string;
  name: string;
  /** Seconds since the epoch; omitted for a token that never expires. */
  exp?: number;
  nats: JsonObject;
}>;

/** The claims as written, before the id is filled in. */
type JwtBody = {
  jti: string;
  iat: number;
  iss: string;
  name: string;
  sub: string;
  nats: JsonObject;
  exp?: number;
};

/** A user's `nats` claim; `resp` only for a credential that answers requests. */
type UserNats = {
  pub: { allow: string[] };
  sub: { allow: string[] };
  issuer_account: string;
  allowed_connection_types: string[];
  subs: number;
  data: number;
  payload: number;
  type: "user";
  version: number;
  resp?: { max: number; ttl: number };
};

/** Sign `claims` as `issuer`: a complete JWT. */
export async function encodeJwt(
  issuer: KeyPair,
  claims: ClaimsInput,
): Promise<string> {
  const body: JwtBody = {
    jti: "",
    iat: Math.floor(Date.now() / 1000),
    iss: issuer.getPublicKey(),
    name: claims.name,
    sub: claims.subject,
    nats: claims.nats,
  };
  if (claims.exp !== undefined) body.exp = claims.exp;
  // The id is a hash of the claims written with an empty id, as the Go
  // library does; the server reads it but does not recompute it.
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(JSON.stringify(body)),
  );
  body.jti = base32(new Uint8Array(digest));
  const signed = `${b64json(HEADER)}.${b64json(body)}`;
  return `${signed}.${toB64url(issuer.sign(encoder.encode(signed)))}`;
}

/** A user token, issued by an account signing key for `account`. */
export function encodeUserJwt(
  signer: KeyPair,
  account: string,
  user: string,
  name: string,
  permissions: SubjectPermissions,
  exp: number,
): Promise<string> {
  const nats: UserNats = {
    pub: { allow: [...permissions.pub] },
    sub: { allow: [...permissions.sub] },
    issuer_account: account,
    allowed_connection_types: ["WEBSOCKET"],
    // Unwritten limits read as zero: no subscription at all.
    subs: -1,
    data: -1,
    payload: -1,
    type: "user",
    version: 2,
  };
  if (permissions.responses) nats.resp = { max: 1, ttl: 0 };
  return encodeJwt(signer, { subject: user, name, exp, nats });
}

const NO_LIMIT = {
  subs: -1,
  data: -1,
  payload: -1,
  imports: -1,
  exports: -1,
  wildcards: true,
  conn: -1,
  leaf: -1,
};

/** An account token, issued by the operator, trusting `signingKeys`. */
export function encodeAccountJwt(
  operator: KeyPair,
  account: string,
  name: string,
  signingKeys: readonly string[],
): Promise<string> {
  return encodeJwt(operator, {
    subject: account,
    name,
    nats: {
      limits: NO_LIMIT,
      signing_keys: [...signingKeys],
      type: "account",
      version: 2,
    },
  });
}

/** The operator's self-signed token. */
export function encodeOperatorJwt(
  operator: KeyPair,
  name: string,
  systemAccount: string,
): Promise<string> {
  return encodeJwt(operator, {
    subject: operator.getPublicKey(),
    name,
    nats: { system_account: systemAccount, type: "operator", version: 2 },
  });
}

/** A key pair from its seed text (`SA…`, `SU…`, `SO…`). */
export function keyFromSeed(seed: string): KeyPair {
  return fromSeed(encoder.encode(seed));
}
