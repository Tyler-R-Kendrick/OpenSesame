import { planRecipient } from "../../../lib/duress/settings/index.js";
import type { DuressEnrollmentViewModel } from "./useDuressEnrollmentPanel.js";

export function DuressEnrollmentRecipientsFieldset({
  vm,
}: {
  vm: Pick<
    DuressEnrollmentViewModel,
    "preset" | "mode" | "recipients" | "setRecipients"
  >;
}) {
  const { preset, mode, recipients, setRecipients } = vm;
  if (
    !(preset.requiresRecipient || preset.requiresCustodian) ||
    mode !== "preset"
  ) {
    return null;
  }
  return (
    <fieldset className="duress-enroll__recipients">
      <legend>Recipients / custodians</legend>
      <button
        type="button"
        onClick={() =>
          setRecipients((r) => [
            ...r,
            planRecipient(
              preset.requiresRecipient ? "alert_recipient" : "key_custodian",
              preset.requiresRecipient ? "recipient-1" : "custodian-1",
              preset.requiresRecipient ? "Alert recipient" : "Key custodian",
            ),
          ])
        }
      >
        Add {preset.requiresRecipient ? "alert recipient" : "custodian"}
      </button>
      <ul>
        {recipients.map((r) => (
          <li key={`${r.role}:${r.ref}`}>
            {r.label} ({r.role}) — {r.cannot[0]}
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
