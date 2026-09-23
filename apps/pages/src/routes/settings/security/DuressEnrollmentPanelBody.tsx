import { activationRequiresNewPermissionPrompt } from "@opensesame/app-core/lib/duress/settings/index.js";
import { DuressEnrollmentCodesSection } from "./DuressEnrollmentCodesSection.js";
import { DuressEnrollmentFooterSection } from "./DuressEnrollmentFooterSection.js";
import { DuressEnrollmentMiddleSection } from "./DuressEnrollmentMiddleSection.js";
import { DuressEnrollmentModeSection } from "./DuressEnrollmentModeSection.js";
import type { DuressEnrollmentViewModel } from "./useDuressEnrollmentPanel.js";

export function DuressEnrollmentPanelBody({
  vm,
}: {
  vm: DuressEnrollmentViewModel;
}) {
  const { titleId, motion, layout, focusOrder } = vm;
  return (
    <section
      className={`panel set__security duress-enroll${motion === "reduced" ? " duress-enroll--reduced" : ""}${layout.stackVertically ? " duress-enroll--stack" : ""}`}
      id="duress-profiles"
      aria-labelledby={titleId}
      data-permission-prompt={String(activationRequiresNewPermissionPrompt())}
      data-focus-order={focusOrder.map((f) => f.id).join(" ")}
    >
      <div className="panel__head">
        <div>
          <h2 id={titleId}>Duress profiles</h2>
        </div>
      </div>
      <div className="panel__body duress-enroll__body">
        <DuressEnrollmentModeSection vm={vm} />
        <DuressEnrollmentMiddleSection vm={vm} />
        <DuressEnrollmentCodesSection vm={vm} />
        <DuressEnrollmentFooterSection vm={vm} />
      </div>
    </section>
  );
}
