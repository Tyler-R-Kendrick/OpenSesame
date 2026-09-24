import { planRecipient } from "@opensesame/app-core/lib/duress/settings/index.js";
import { IconKey } from "../../../components/IconKey.js";
import { IconPlus } from "../../../components/Icons.js";
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
      <IconKey
        label={`Add ${preset.requiresRecipient ? "alert recipient" : "custodian"}`}
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
        <IconPlus size={16} />
      </IconKey>
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
