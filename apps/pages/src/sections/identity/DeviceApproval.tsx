/**
 * The device-approval form (ADR 0140 plan step 7): one control, drawn by the
 * `/device` route and by Identity › Devices, over one view-model
 * (`app-core/lib/device-approval.ts`) and one request (ceremony-kit's
 * `approveDevice`, through `directory.ts`).
 *
 * Arriving with a code — a link a device printed — the only question left is
 * whether it matches the code on that device, so the key that answers it takes
 * the focus and the code sits above it to read. Arriving without one, the
 * field takes the focus. An answer is a mark beside the code; a failure's
 * words also go to the notifications tray, never into a box on the page.
 */

import {
  DEVICE_APPROVED,
  type DeviceApprovalResult,
  approveDeviceEntry,
  clearDeviceApprovalNotice,
} from "@opensesame/app-core/lib/device-approval.js";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { FormCommit } from "../../components/FormCommit.js";
import { StatusMark } from "../../components/StatusMark.js";

export type DeviceApprovalProps = {
  online: boolean;
  /** A code a link carried, shown for the person to confirm. */
  arrivedCode?: string | null;
  /** A failure the surface already knows of (a refused link). */
  initialResult?: DeviceApprovalResult | null;
  id?: string;
};

export function DeviceApproval({
  online,
  arrivedCode = null,
  initialResult = null,
  id = "device-approval-code",
}: DeviceApprovalProps) {
  const [code, setCode] = useState(arrivedCode ?? "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DeviceApprovalResult | null>(
    initialResult,
  );
  const codeRef = useRef<HTMLInputElement | null>(null);
  const goRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (arrivedCode && online) goRef.current?.focus();
    else codeRef.current?.focus();
  }, [arrivedCode, online]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    setResult(null);
    const answer = await approveDeviceEntry(code);
    setBusy(false);
    setResult(answer);
    if (answer.tone === "ok") setCode(answer.userCode);
    else codeRef.current?.focus();
  }

  return (
    <form
      className="device-approval"
      onSubmit={(event) => void submit(event)}
      noValidate
    >
      <div className="field">
        <label htmlFor={id}>User code</label>
        <div className="field-inline">
          <input
            id={id}
            ref={codeRef}
            type="text"
            className="mono"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="WORD-WORD"
            value={code}
            disabled={busy}
            aria-describedby={result ? `${id}-mark` : undefined}
            onChange={(event) => {
              setCode(event.target.value);
              if (result) {
                setResult(null);
                clearDeviceApprovalNotice();
              }
            }}
          />
          <output id={`${id}-mark`} aria-live="polite">
            {result ? (
              <StatusMark
                tone={result.tone}
                label={result.tone === "ok" ? DEVICE_APPROVED : result.words}
              />
            ) : null}
          </output>
        </div>
      </div>
      <FormCommit
        label={busy ? "Approving…" : "Approve device"}
        buttonRef={goRef}
        disabled={busy || !online || !code.trim()}
        busy={busy}
      />
    </form>
  );
}
