/**
 * What a NATS carrier may say beyond its address (ADR 0166): how it signs in,
 * and whether the session itself may cross it.
 *
 * - **mint** — the owner's account public key and an account signing key
 *   (`SA…`), kept only in the owner's sealed profile. A session mints a user
 *   credential from it scoped to that session's subjects and expiring with
 *   it (`nats-credentials.ts`); the link carries the minted credential and
 *   never the signing key, as a TURN REST secret never travels.
 * - **jwt** and **seed** — a user credential (a `.creds` file's two halves).
 *   Minted, or one the owner names: then, like a password, it is in the link
 *   in the clear for as long as the server honours it.
 * - **session** — whether the session (catalog, reveals, edits) may run over
 *   this server when the two browsers cannot reach each other: `fallback`
 *   (the default), `always`, or `off` (codes only). It crosses sealed end to
 *   end (`seat-channel.ts`); the server sees ciphertext, as a TURN relay does.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";

export const NATS_SESSIONS = ["off", "fallback", "always"] as const;
export type NatsSession = (typeof NATS_SESSIONS)[number];

/** The account a session's credentials are minted for, and its signer. */
export type NatsMint = Readonly<{
  /** The account's public key, `A…` (56 characters). */
  account: string;
  /** An account signing key's seed, `SA…` (58 characters). */
  signingKey: string;
}>;

/** What a NATS carrier spec may add to its address. */
export type NatsFields = {
  jwt?: string;
  seed?: string;
  session?: NatsSession;
  mint?: NatsMint;
};

const ACCOUNT_KEY = /^A[A-Z2-7]{55}$/;
const ACCOUNT_SEED = /^SA[A-Z2-7]{56}$/;
const USER_SEED = /^SU[A-Z2-7]{56}$/;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const JWT_MAX = 4096;

/** The keys a carrier may name only when it is NATS. */
export const NATS_LINK_KEYS = ["jwt", "seed", "session"] as const;
/** And, in the owner's profile only, the account it mints for. */
export const NATS_SETTING_KEYS = [...NATS_LINK_KEYS, "mint"] as const;

export function isAccountKey(value: string): boolean {
  return ACCOUNT_KEY.test(value);
}

export function isAccountSeed(value: string): boolean {
  return ACCOUNT_SEED.test(value);
}

export function isUserSeed(value: string): boolean {
  return USER_SEED.test(value);
}

export function isUserJwt(value: string): boolean {
  return value.length <= JWT_MAX && JWT.test(value);
}

type Read = Readonly<{
  value: Readonly<Record<string, BoundaryValue>>;
  at: string;
  errors: string[];
  /** The owner's profile, which may hold a signing key; a link may not. */
  settings: boolean;
  /** Whether the carrier names a static login (username, password, token). */
  login: boolean;
}>;

function readMint(
  raw: BoundaryValue | undefined,
  at: string,
  errors: string[],
): NatsMint | undefined {
  if (raw === undefined) return undefined;
  if (!isJsonObject(raw)) {
    errors.push(`${at}.mint must be an object.`);
    return undefined;
  }
  for (const key of Object.keys(raw))
    if (key !== "account" && key !== "signingKey")
      errors.push(`${at}.mint has an unknown key "${key}".`);
  const { account, signingKey } = raw;
  if (!isString(account) || !isAccountKey(account))
    errors.push(`${at}.mint.account must be an account public key (A…).`);
  if (!isString(signingKey) || !isAccountSeed(signingKey))
    errors.push(`${at}.mint.signingKey must be an account signing seed (SA…).`);
  return isString(account) && isString(signingKey)
    ? { account, signingKey }
    : undefined;
}

/** A user credential: both halves, each well formed. */
function readCredential(read: Read, out: NatsFields): void {
  const { value, at, errors } = read;
  const { jwt, seed } = value;
  if (jwt === undefined && seed === undefined) return;
  if (isString(jwt) && isUserJwt(jwt)) out.jwt = jwt;
  else errors.push(`${at}.jwt must be a user JWT.`);
  if (isString(seed) && isUserSeed(seed)) out.seed = seed;
  else errors.push(`${at}.seed must be a user seed (SU…), given with jwt.`);
}

function readSession(read: Read, out: NatsFields): void {
  const { value, at, errors } = read;
  if (value.session === undefined) return;
  const found = NATS_SESSIONS.find((entry) => entry === value.session);
  if (found) out.session = found;
  else errors.push(`${at}.session must be one of ${NATS_SESSIONS.join(", ")}.`);
}

/** In the owner's profile: the account it mints for, and nothing beside it. */
function readMinting(read: Read, out: NatsFields): void {
  const { value, at, errors, settings, login } = read;
  if (!settings || value.mint === undefined) return;
  const mint = readMint(value.mint, at, errors);
  if (mint) out.mint = mint;
  if (login || out.jwt || out.seed)
    errors.push(
      `${at} mints its credential: give no username, password, token, jwt or seed.`,
    );
}

/** A NATS carrier's own fields, read strictly; errors are pushed in place. */
export function readNatsFields(read: Read): NatsFields {
  const out: NatsFields = {};
  readCredential(read, out);
  readSession(read, out);
  readMinting(read, out);
  if ((out.jwt || out.seed) && read.login)
    read.errors.push(
      `${read.at} takes a user credential or a login, not both.`,
    );
  return out;
}

/** How far a NATS carrier carries the session; codes only for any other. */
export function sessionOver(
  carrier: Readonly<{ kind: string; session?: NatsSession }>,
): NatsSession {
  if (carrier.kind !== "nats") return "off";
  return carrier.session ?? "fallback";
}
