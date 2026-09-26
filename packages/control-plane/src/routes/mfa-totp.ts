import { createHmac, timingSafeEqual } from "node:crypto";
import { type SecurityMap, updateSecurityMap } from "../repos/durable-map.js";

/**
 * The account's TOTP factor: the code it computes, and the one rule that
 * makes a code a proof rather than a password — each thirty-second step is
 * accepted once per principal (RFC 6238 §5.2: "the verifier MUST NOT accept
 * the second attempt of the OTP after the successful validation has been
 * issued for the first OTP").
 *
 * The step ledger is shared by every route that accepts the code
 * (`/v1/mfa/totp/verify` and the step-up on `DELETE /v1/mfa/factors/:id`),
 * so a code seen once — typed to confirm an enrolment, say — cannot be
 * presented again anywhere within its thirty seconds.
 */

export const TOTP_STEP_SECONDS = 30;

/** DEV/test TOTP: HMAC-SHA1 truncated to 6 digits (RFC 6238-style). */
export function totpCode(
  secretB64: string,
  step = TOTP_STEP_SECONDS,
  digits = 6,
  at = Date.now(),
): string {
  const key = Buffer.from(secretB64, "base64");
  const counter = Math.floor(at / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = (hmac.at(-1) ?? 0) & 0x0f;
  const bin = hmac.readUInt32BE(offset) & 0x7fffffff;
  const otp = bin % 10 ** digits;
  return otp.toString().padStart(digits, "0");
}

export function totpCodesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** The RFC 6238 time step `at` falls in. */
export function totpStep(at = Date.now()): number {
  return Math.floor(at / 1000 / TOTP_STEP_SECONDS);
}

/** How a presented code fared: taken, not this step's, or this step's again. */
export type TotpSpend = "accepted" | "mismatch" | "replayed";

/**
 * Accept `code` for `principalId` once: it must be the current step's code,
 * and that step must not have been accepted for this principal before. The
 * ledger moves forward by compare-and-set, so two requests carrying the same
 * code cannot both win, on one replica or several.
 */
export async function spendTotpCode(
  ledger: SecurityMap<number>,
  principalId: string,
  secretB64: string,
  code: string,
  at = Date.now(),
): Promise<TotpSpend> {
  const step = totpStep(at);
  if (!totpCodesEqual(code, totpCode(secretB64, TOTP_STEP_SECONDS, 6, at))) {
    return "mismatch";
  }
  let won = false;
  await updateSecurityMap(ledger, principalId, (spent) => {
    if (spent !== undefined && spent >= step) return spent;
    won = true;
    return step;
  });
  return won ? "accepted" : "replayed";
}
