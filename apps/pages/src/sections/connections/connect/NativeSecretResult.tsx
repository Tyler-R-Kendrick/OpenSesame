import { useState } from "react";
import {
  ConcealedValue,
  CopyButton,
  FieldRow,
  RevealButton,
  useCopyFeedback,
} from "../../../components/FieldRow.js";

/** Explicit provider reads remain ephemeral and masked until the person asks. */
export function NativeSecretResult({
  label,
  value,
}: { label: string; value: string }) {
  const [revealed, setRevealed] = useState(false);
  const feedback = useCopyFeedback();
  return (
    <FieldRow
      label={label}
      actions={
        <>
          <RevealButton
            label={label}
            revealed={revealed}
            onToggle={() => setRevealed((current) => !current)}
          />
          <CopyButton
            value={value}
            label={label}
            fieldKey={label}
            copied={feedback.copied}
            failed={feedback.failed}
            onCopy={feedback.copy}
          />
        </>
      }
    >
      <ConcealedValue label={label} value={value} revealed={revealed} />
    </FieldRow>
  );
}
