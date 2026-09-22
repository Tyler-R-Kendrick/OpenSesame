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

const PRESET_UNLOCK_ENTRY =
  "DuressEnrollmentPanel presets|unlock-*-duress|preset-build";

const PRESET_UNLOCK_NOTE =
  "preset selectable + complete-code unlock gate; effect modules present";

/** @param {boolean} armBlocked */
export function buildScenarioMatrix(armBlocked) {
  /** @type {Record<string, Record<string, unknown>>} */
  const matrix = {};
  for (const id of SCENARIO_IDS) {
    matrix[id] = rowForScenario(id, armBlocked);
  }
  return matrix;
}

/** @param {string} id @param {boolean} armBlocked */
function rowForScenario(id, armBlocked) {
  if (id === "SC-ALERT-ONLY") {
    return {
      status: "exercised_fixture",
      entryPoint: "J-CRYPTO-SLOT|J-TRIGGER",
      note: "presentation sealed/opened via fixture modules",
    };
  }
  if (id === "SC-RESTRICTED" || id === "SC-DECOY") {
    return {
      status: "production_entry_wired",
      entryPoint:
        "unlock-*-duress|unlock-duress-continue|unlock-passkey-duress|DuressEnrollmentPanel|PresentationShell",
      note: "application_code / passkey-then-code match → activate → presentation runtime + guest continue",
    };
  }
  if (
    id === "SC-CUSTODIAN-HOLD" ||
    id === "SC-LOCAL-REMOVE" ||
    id === "SC-LIMITED-CARRY" ||
    id === "SC-SPLIT-SCOPE"
  ) {
    return {
      status: "production_entry_wired",
      entryPoint: PRESET_UNLOCK_ENTRY,
      note: PRESET_UNLOCK_NOTE,
    };
  }
  if (id === "SC-APPROVAL-DURESS") {
    return {
      status: "production_entry_wired",
      entryPoint:
        "ceremony/approval.ts|duress-approval-bridge|RequestApproval|DuressEnrollmentPanel",
      note: "access approval gate + evaluateApprovalCeremony + preset",
    };
  }
  if (id === "SC-LOST-DEVICE") {
    return {
      status: "production_entry_wired",
      entryPoint: "peer/|removal/device-retirement|DuressEnrollmentPanel",
      note: "delegated_peer_request preset + peer envelope modules",
    };
  }
  if (id === "SC-LOCAL-HOLD") {
    return { status: "exercised_fixture", entryPoint: "J-RESTART" };
  }
  if (id === "SC-QUARANTINE") {
    return { status: "exercised_fixture", entryPoint: "J-PEER-ENVELOPE" };
  }
  if (id === "SC-REHEARSAL") {
    return {
      status: armBlocked === false ? "exercised_fixture" : "failed",
      entryPoint: "arming-checklist",
      detail: { canArmWithoutRehearsal: armBlocked },
    };
  }
  if (id === "SC-CANARY") {
    return {
      status: "production_entry_wired",
      entryPoint: "canary/detect.ts|DuressEnrollmentPanel preset SC-CANARY",
      note: "detection modules + preset; UI is enrollment, not a separate canary screen",
    };
  }
  return {
    status: "blocked",
    entryPoint: null,
    blocker:
      "production unlock/settings entry points not wired for this scenario",
  };
}
