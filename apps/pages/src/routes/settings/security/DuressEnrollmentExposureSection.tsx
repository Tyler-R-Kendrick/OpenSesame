import type { DuressEnrollmentViewModel } from "./useDuressEnrollmentPanel.js";

export function DuressEnrollmentExposureSection({
  vm,
}: {
  vm: Pick<DuressEnrollmentViewModel, "preview" | "importDocPreview">;
}) {
  const { preview, importDocPreview } = vm;
  return (
    <section
      aria-label="Compiler exposure summary"
      className="duress-enroll__exposure"
    >
      <h3>Exposure summary</h3>
      {preview?.ok ? (
        <ul>
          {preview.lines.map((line) => (
            <li key={`${line.kind}:${line.text}`}>{line.text}</li>
          ))}
        </ul>
      ) : (
        <p>
          {preview
            ? `Compile blocked: ${preview.diagnostics[0]?.message ?? "invalid policy"}`
            : "Select a preset or paste a valid policy to preview exposure."}
        </p>
      )}
      {importDocPreview ? (
        <p className="duress-enroll__hint">
          Dry-run wouldArm={String(importDocPreview.wouldArm)}; import never
          arms.
        </p>
      ) : null}
    </section>
  );
}
