/**
 * Whether a run may be claimed right now, decided in one place and read fresh
 * before every claim. The order is the order of the questions that matter: is
 * it over, does a person hold the page, is it an origin this runner drives at
 * all, did the person arm it, does the browser still grant it, and is
 * everything a step will need already in place.
 */
import type { AgentRunView } from "@opensesame/api-client";
import type { RunnerDeps, Skip } from "./loop-types";
import { drivable } from "./origin";

export async function skipReason(
  deps: RunnerDeps,
  run: AgentRunView,
  now: number,
): Promise<Skip | null> {
  if (run.closed_at !== null) return "closed";
  if (Date.parse(run.expires_at) <= now) return "expired";
  if (run.driver !== "agent") return "human_holds_page";
  if (run.control_state !== "agent_driving") return "not_driving";
  if (!drivable(run.origin)) return "origin_refused";
  if (!(await deps.settings.isArmed(run.origin))) return "not_armed";
  if (!(await deps.grants.has(run.origin))) return "no_grant";
  if (!(await deps.vault.getEntry(run.origin))) return "no_credential";
  if (!(await deps.vault.recipient())) return "no_recovery_key";
  if (!(await deps.grants.privateAllowed())) return "no_private_context";
  return null;
}
