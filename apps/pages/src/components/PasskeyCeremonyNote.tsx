import { webauthnSeams } from "@opensesame/app-core/lib/webauthn.js";
import { useEffect, useState } from "react";
import { FailureNotice } from "./FailureNotice.js";

/**
 * Said once, where a connect ceremony would need a passkey this browser
 * cannot make. The Mobile MFA hand-off QR that used to sit here went with
 * `mfaAppUrl` (ADR 0140 D10): an account's passkey is added in Settings ›
 * Security on a device that can make one.
 */
function PasskeyCeremonyNoteDefault() {
  const [support, setSupport] = useState<"ok" | "partial" | "missing" | null>(
    null,
  );

  useEffect(() => {
    void webauthnSeams.detectWebAuthn().then(setSupport);
  }, []);

  return (
    <FailureNotice
      id="connection:passkey-support"
      title="Passkey"
      message={
        support === null || support === "ok"
          ? null
          : webauthnSeams.WEBAUTHN_FALLBACK
      }
      tone="warn"
    />
  );
}

export const passkeyCeremonyNoteSeams = {
  PasskeyCeremonyNote: PasskeyCeremonyNoteDefault,
};

export function PasskeyCeremonyNote() {
  const Impl = passkeyCeremonyNoteSeams.PasskeyCeremonyNote;
  return <Impl />;
}
