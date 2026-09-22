import { IconCheck, IconX } from "../../../components/Icons.js";
import type { DuressEnrollmentViewModel } from "./useDuressEnrollmentPanel.js";

export function DuressEnrollmentFooterSection({
  vm,
}: {
  vm: DuressEnrollmentViewModel;
}) {
  const {
    importRaw,
    setImportRaw,
    importPreview,
    exportBlob,
    decoySafe,
    foregroundLabels,
    blockers,
    armReady,
    onArm,
    onDisarm,
  } = vm;
  return (
    <>
      <fieldset className="duress-enroll__import">
        <legend>Import / export preview</legend>
        <label>
          Paste policy (JSON or YAML)
          <textarea
            value={importRaw}
            onChange={(e) => setImportRaw(e.currentTarget.value)}
            rows={4}
            spellCheck={false}
          />
        </label>
        {importPreview ? (
          <ul>
            {importPreview.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
            <li>armed={String(importPreview.armed)}</li>
            {importPreview.preview ? (
              <li>wouldArm={String(importPreview.preview.wouldArm)}</li>
            ) : null}
          </ul>
        ) : null}
        {exportBlob ? (
          <details>
            <summary>Export preview (no secrets)</summary>
            <pre>{exportBlob.json}</pre>
          </details>
        ) : null}
      </fieldset>

      <section aria-label="Status" className="duress-enroll__status">
        <h3>Status</h3>
        {decoySafe.showPolicyLabels ? (
          <ul>
            {foregroundLabels.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        ) : (
          <p>{decoySafe.detail}</p>
        )}
      </section>

      <div className="duress-enroll__actions">
        <button
          type="button"
          id="duress-arm"
          className="icon-btn"
          disabled={!armReady}
          onClick={onArm}
          aria-label={
            armReady
              ? "Arm after rehearsal"
              : `Blocked: ${blockers.join(", ") || "compile"}`
          }
          title={
            armReady
              ? "Arm after rehearsal"
              : `Blocked: ${blockers.join(", ") || "compile"}`
          }
        >
          <IconCheck size={18} />
        </button>
        <button
          type="button"
          id="duress-disarm"
          className="icon-btn"
          onClick={onDisarm}
          aria-label="Disarm"
          title="Disarm"
        >
          <IconX size={18} />
        </button>
      </div>
    </>
  );
}
