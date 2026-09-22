import type { DuressEnrollmentViewModel } from "./useDuressEnrollmentPanel.js";

export function DuressEnrollmentRehearsalSection({
  vm,
}: {
  vm: Pick<DuressEnrollmentViewModel, "rehearsalNote" | "runRehearsal">;
}) {
  const { rehearsalNote, runRehearsal } = vm;
  return (
    <div className="duress-enroll__rehearsal">
      <button type="button" id="duress-rehearsal-run" onClick={runRehearsal}>
        Run isolated rehearsal
      </button>
      {rehearsalNote ? <p>{rehearsalNote}</p> : null}
    </div>
  );
}
