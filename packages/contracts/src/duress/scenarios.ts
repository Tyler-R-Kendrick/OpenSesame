/**
 * Scenario catalog IDs — must stay 1:1 with
 * `.duress-swarm/SEMANTIC_CONTRACT.ts` `SCENARIO_IDS`.
 */
export const SCENARIO_IDS = [
  "SC-ALERT-ONLY",
  "SC-RESTRICTED",
  "SC-DECOY",
  "SC-LOCAL-HOLD",
  "SC-CUSTODIAN-HOLD",
  "SC-QUARANTINE",
  "SC-LOCAL-REMOVE",
  "SC-LIMITED-CARRY",
  "SC-APPROVAL-DURESS",
  "SC-LOST-DEVICE",
  "SC-SPLIT-SCOPE",
  "SC-CANARY",
  "SC-REHEARSAL",
] as const;

export type ScenarioId = (typeof SCENARIO_IDS)[number];

export function isScenarioId(value: string): value is ScenarioId {
  for (const id of SCENARIO_IDS) {
    if (value === id) {
      return true;
    }
  }
  return false;
}
