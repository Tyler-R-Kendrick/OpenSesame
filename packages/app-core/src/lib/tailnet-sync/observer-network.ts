import { isString } from "@opensesame/os-domain";
import { assertNotDecoySession } from "../decoy-session.js";
import { explainNetworkFailure, networkGate } from "./network-access.js";
import type { DrivePairing } from "./pairing.js";

/** What a failed pass tells the person: the gate's reason when it caused it. */
export async function failureMessage(error: Error | string): Promise<string> {
  if (isString(error)) return error;
  return (await explainNetworkFailure(error)) ?? error.message;
}

/**
 * Let `drive` be reached: the gate refuses (blocked) or allows, and a person's
 * own pass waits out the browser's prompt on its first request.
 */
export async function openTheWay(
  drive: DrivePairing,
  interactive: boolean,
  generation: number,
  reach: (drive: DrivePairing, waitMs: number) => Promise<void>,
): Promise<string | null> {
  assertNotDecoySession(generation);
  const gate = await networkGate(interactive);
  assertNotDecoySession(generation);
  if (!gate.go) return gate.reason;
  if (gate.waitMs) await reach(drive, gate.waitMs);
  assertNotDecoySession(generation);
  return null;
}
