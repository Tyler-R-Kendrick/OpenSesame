import { IconCheck } from "../../../components/Icons.js";
import type { DuressEnrollmentViewModel } from "./useDuressEnrollmentPanel.js";

export function DuressEnrollmentCodesSection({
  vm,
}: {
  vm: DuressEnrollmentViewModel;
}) {
  const {
    slotView,
    codeDraft,
    prevCodeDraft,
    codeError,
    slot,
    setCodeDraft,
    setPrevCodeDraft,
    onReplaceCode,
  } = vm;
  return (
    <form className="duress-enroll__codes" onSubmit={onReplaceCode}>
      <h3>Trigger codes</h3>
      <p className="duress-enroll__hint">
        Stored codes are never displayed. Replacement requires the previous code
        when a slot is already enrolled.
      </p>
      {slotView ? (
        <p>
          Slot {slotView.slotId}: {slotView.enrolled ? "enrolled" : "empty"}{" "}
          digest {slotView.materialDigestPrefix || "(none)"}
        </p>
      ) : (
        <p>No enrolled trigger on this device.</p>
      )}
      {slot?.enrolled ? (
        <label>
          Previous code
          <input
            type="password"
            autoComplete="off"
            value={prevCodeDraft}
            onChange={(e) => setPrevCodeDraft(e.currentTarget.value)}
          />
        </label>
      ) : null}
      <label>
        New trigger code
        <input
          id="duress-code-input"
          type="password"
          autoComplete="new-password"
          value={codeDraft}
          onChange={(e) => setCodeDraft(e.currentTarget.value)}
          minLength={8}
          required
        />
      </label>
      {codeError ? <p className="duress-enroll__error">{codeError}</p> : null}
      <button
        type="submit"
        className="icon-btn"
        aria-label="Enroll or replace code"
        title="Enroll or replace code"
      >
        <IconCheck size={18} />
      </button>
    </form>
  );
}
