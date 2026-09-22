/**
 * Honest SC-* entry-point status for the duress journey harness.
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
];

const PRESET = {
  status: "production_entry_wired",
  entryPoint: "DuressEnrollmentPanel presets|unlock-*-duress|preset-build",
  note: "preset selectable + complete-code unlock gate; effect modules present",
};

const UNLOCK_PRESENTATION = {
  status: "production_entry_wired",
  entryPoint:
    "unlock-*-duress|unlock-duress-continue|unlock-passkey-duress|DuressEnrollmentPanel|PresentationShell",
  note: "application_code / passkey-then-code match → activate → presentation runtime + guest continue",
};

/** @type {Record<string, Record<string, unknown>>} */
const STATIC_ROWS = {
  "SC-ALERT-ONLY": {
    status: "exercised_fixture",
    entryPoint: "J-CRYPTO-SLOT|J-TRIGGER",
    note: "presentation sealed/opened via fixture modules",
  },
  "SC-RESTRICTED": UNLOCK_PRESENTATION,
  "SC-DECOY": UNLOCK_PRESENTATION,
  "SC-LOCAL-HOLD": { status: "exercised_fixture", entryPoint: "J-RESTART" },
  "SC-CUSTODIAN-HOLD": PRESET,
  "SC-QUARANTINE": {
    status: "exercised_fixture",
    entryPoint: "J-PEER-ENVELOPE",
  },
  "SC-LOCAL-REMOVE": PRESET,
  "SC-LIMITED-CARRY": PRESET,
  "SC-APPROVAL-DURESS": {
    status: "production_entry_wired",
    entryPoint:
      "ceremony/approval.ts|duress-approval-bridge|RequestApproval|DuressEnrollmentPanel",
    note: "access approval gate + evaluateApprovalCeremony + preset",
  },
  "SC-LOST-DEVICE": {
    status: "production_entry_wired",
    entryPoint: "peer/|removal/device-retirement|DuressEnrollmentPanel",
    note: "delegated_peer_request preset + peer envelope modules",
  },
  "SC-SPLIT-SCOPE": PRESET,
  "SC-CANARY": {
    status: "production_entry_wired",
    entryPoint: "canary/detect.ts|DuressEnrollmentPanel preset SC-CANARY",
    note: "detection modules + preset; UI is enrollment, not a separate canary screen",
  },
};

/** @param {boolean} armBlocked */
export function buildScenarioMatrix(armBlocked) {
  /** @type {Record<string, Record<string, unknown>>} */
  const matrix = {};
  for (const id of SCENARIO_IDS) {
    if (id === "SC-REHEARSAL") {
      matrix[id] = {
        status: armBlocked === false ? "exercised_fixture" : "failed",
        entryPoint: "arming-checklist",
        detail: { canArmWithoutRehearsal: armBlocked },
      };
      continue;
    }
    matrix[id] = STATIC_ROWS[id];
  }
  return matrix;
}
