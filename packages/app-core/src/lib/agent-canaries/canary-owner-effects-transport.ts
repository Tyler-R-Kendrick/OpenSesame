/** Paired detection-only challenge proof, with exact accepted command and receiver audience. */
import { SignJWT } from "jose";
import {
  type CanaryOwnerCustody,
  canaryDigest,
} from "./canary-owner-effects-custody.js";
import { captureControlledCanaryClientData } from "./controlled-client-data.js";
import {
  type ControlledCanaryCommand,
  encodeControlledCanaryCommand,
} from "./controlled-receiver-contract.js";
import {
  type CanaryReceiverProfile,
  controlledCanaryAudience,
} from "./receiver-profile-data.js";
export async function executeCanaryOwnerCommand(
  profile: CanaryReceiverProfile,
  held: CanaryOwnerCustody,
  command: ControlledCanaryCommand,
  check: () => void,
  signal: AbortSignal,
) {
  const client = captureControlledCanaryClientData(profile, check, signal);
  const hash = await canaryDigest(encodeControlledCanaryCommand(command));
  check();
  const challenge = await client.challenge(command);
  check();
  const now = Date.now();
  if (
    challenge.serviceId !== profile.serviceId ||
    challenge.commandHash !== hash ||
    challenge.audience !== controlledCanaryAudience(profile, hash) ||
    challenge.expiresAt <= now ||
    challenge.expiresAt > now + 60000
  )
    throw new Error(
      "Canary receiver challenge differs from the accepted command.",
    );
  const signing = await crypto.subtle.importKey(
    "jwk",
    held.privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  check();
  const idToken = await new SignJWT({ nonce: challenge.nonce })
    .setProtectedHeader({ alg: "ES256" })
    .setSubject(held.keyId)
    .setAudience(challenge.audience)
    .setIssuedAt(Math.floor(now / 1000))
    .setExpirationTime(Math.floor(challenge.expiresAt / 1000))
    .sign(signing);
  check();
  const result = await client.execute({ nonce: challenge.nonce, idToken });
  check();
  return result;
}
