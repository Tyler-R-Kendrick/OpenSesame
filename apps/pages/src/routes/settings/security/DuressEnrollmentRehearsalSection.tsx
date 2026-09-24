import { IconKey } from "../../../components/IconKey.js";
import { IconPlay } from "../../../components/Icons.js";
import type { DuressEnrollmentViewModel } from "./useDuressEnrollmentPanel.js";

export function DuressEnrollmentRehearsalSection({
  vm,
}: {
  vm: Pick<DuressEnrollmentViewModel, "rehearsalNote" | "runRehearsal">;
}) {
  const { rehearsalNote, runRehearsal } = vm;
  return (
    <div className="duress-enroll__rehearsal">
      <IconKey
        label="Run isolated rehearsal"
        id="duress-rehearsal-run"
        onClick={runRehearsal}
      >
        <IconPlay size={16} />
      </IconKey>
      {rehearsalNote ? <p>{rehearsalNote}</p> : null}
    </div>
  );
}
