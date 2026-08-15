import { type ClaimState, canTransitionClaim } from "@opensesame/os-domain";
import { FuzzedDataProvider } from "./provider.js";

const STATES: ClaimState[] = [
  "pending",
  "presented",
  "authenticated",
  "reviewed",
  "completed",
  "denied",
  "revoked",
  "expired",
];

export function fuzz(data: Buffer): void {
  const p = new FuzzedDataProvider(data);
  const from =
    STATES[p.consumeIntegralInRange(0, STATES.length - 1)] ?? "pending";
  const to =
    STATES[p.consumeIntegralInRange(0, STATES.length - 1)] ?? "pending";
  const allowed = canTransitionClaim(from, to);
  if (
    (from === "completed" || from === "denied" || from === "revoked") &&
    allowed
  ) {
    throw new Error(`terminal claim ${from} transitioned to ${to}`);
  }
}
