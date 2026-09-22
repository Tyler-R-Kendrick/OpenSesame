import type { DuressEnrollmentViewModel } from "./useDuressEnrollmentPanel.js";

export function DuressEnrollmentConsentFieldset({
  vm,
}: {
  vm: Pick<DuressEnrollmentViewModel, "checklist" | "toggleCheck">;
}) {
  const { checklist, toggleCheck } = vm;
  return (
    <fieldset className="duress-enroll__consent">
      <legend>Owner consent</legend>
      <label id="duress-consent-owner">
        <input
          type="checkbox"
          checked={checklist.ownerConsent}
          onChange={(e) => toggleCheck("ownerConsent", e.currentTarget.checked)}
        />{" "}
        I am the affected owner and authorize this scope
      </label>
      <label id="duress-consent-destructive">
        <input
          type="checkbox"
          checked={checklist.destructiveAck}
          onChange={(e) =>
            toggleCheck("destructiveAck", e.currentTarget.checked)
          }
        />{" "}
        I understand destructive and hold effects (application-scoped only; not
        forensic erasure)
      </label>
      <label>
        <input
          type="checkbox"
          checked={checklist.exposureReviewed}
          onChange={(e) =>
            toggleCheck("exposureReviewed", e.currentTarget.checked)
          }
        />{" "}
        I reviewed the compiler exposure summary
      </label>
    </fieldset>
  );
}
