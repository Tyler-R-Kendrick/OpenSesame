import { DuressEnrollmentConsentFieldset } from "./DuressEnrollmentConsentFieldset.js";
import { DuressEnrollmentExposureSection } from "./DuressEnrollmentExposureSection.js";
import { DuressEnrollmentRecipientsFieldset } from "./DuressEnrollmentRecipientsFieldset.js";
import { DuressEnrollmentRehearsalSection } from "./DuressEnrollmentRehearsalSection.js";
import type { DuressEnrollmentViewModel } from "./useDuressEnrollmentPanel.js";

export function DuressEnrollmentMiddleSection({
  vm,
}: {
  vm: DuressEnrollmentViewModel;
}) {
  return (
    <>
      <DuressEnrollmentExposureSection vm={vm} />
      <DuressEnrollmentConsentFieldset vm={vm} />
      <DuressEnrollmentRecipientsFieldset vm={vm} />
      <DuressEnrollmentRehearsalSection vm={vm} />
    </>
  );
}
