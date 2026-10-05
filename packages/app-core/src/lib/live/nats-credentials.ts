/**
 * The NATS credentials a live session mints for itself (ADR 0166), from the
 * account signing key the owner keeps in their sealed profile. No server of
 * ours issues them: the owner's tab does, as it mints TURN REST credentials.
 *
 * Two are minted per session, each a fresh user key and a JWT that expires
 * when the session does — so nats-server itself disconnects them then:
 *
 * - **joiner** — goes in the link, for every link holder: publish and
 *   subscribe only under the session's own subject, `opensesame.live.<topic>`
 *   and below (its request/reply inbox lives there too).
 * - **owner** — stays in this tab: the same subjects, plus answering `$SRV`
 *   discovery and one reply per request, so the session is a NATS service.
 *
 * Neither can reach another session's subjects or anything else on the
 * account, and only WebSocket connections may use them.
 */

import { createUser } from "@nats-io/nkeys";
import {
  type SubjectPermissions,
  encodeUserJwt,
  keyFromSeed,
} from "./nats-jwt.js";
import type { NatsMint } from "./nats-route.js";

export type NatsCredential = Readonly<{ jwt: string; seed: string }>;
export type NatsRole = "owner" | "joiner";

/** The subject a session's carrier, channels and service live under. */
export function sessionSubject(topic: string): string {
  return `opensesame.live.${topic}`;
}

/** What each role may touch, given the session's subject. */
export function permissionsFor(
  role: NatsRole,
  topic: string,
): SubjectPermissions {
  const base = sessionSubject(topic);
  const own = [base, `${base}.>`];
  return role === "owner"
    ? { pub: own, sub: [...own, "$SRV.>"], responses: true }
    : { pub: own, sub: own };
}

/** A fresh user credential for `role` in the session on `topic`. */
export async function mintNatsCredential(
  mint: NatsMint,
  role: NatsRole,
  topic: string,
  expiresAt: number,
): Promise<NatsCredential> {
  const signer = keyFromSeed(mint.signingKey);
  const user = createUser();
  const jwt = await encodeUserJwt(
    signer,
    mint.account,
    user.getPublicKey(),
    `opensesame-live-${role}`,
    permissionsFor(role, topic),
    Math.ceil(expiresAt / 1000),
  );
  return { jwt, seed: new TextDecoder().decode(user.getSeed()) };
}
