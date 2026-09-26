import { webauthnSeams } from "@opensesame/app-core/lib/webauthn.js";
import { useEffect, useState } from "react";
import { IconAlert } from "./Icons.js";

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

  if (support === null || support === "ok") return null;

  return (
    <div className="note note--warn passkey-note">
      <IconAlert />
      <div className="passkey-note__body">
        <p>{webauthnSeams.WEBAUTHN_FALLBACK}</p>
      </div>
    </div>
  );
}

export const passkeyCeremonyNoteSeams = {
  PasskeyCeremonyNote: PasskeyCeremonyNoteDefault,
};

export function PasskeyCeremonyNote() {
  const Impl = passkeyCeremonyNoteSeams.PasskeyCeremonyNote;
  return <Impl />;
}
