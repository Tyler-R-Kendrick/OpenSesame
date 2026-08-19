import { useEffect, useState } from "react";
import { loadSettings, subscribeSettings } from "../lib/settings.js";
import { WEBAUTHN_FALLBACK, detectWebAuthn } from "../lib/webauthn.js";
import { IconAlert } from "./Icons.js";
import { QrCode } from "./QrCode.js";

export function PasskeyCeremonyNote() {
  const [support, setSupport] = useState<"ok" | "partial" | "missing" | null>(
    null,
  );
  const [mfaAppUrl, setMfaAppUrl] = useState(() =>
    loadSettings().mfaAppUrl.trim(),
  );

  useEffect(() => {
    void detectWebAuthn().then(setSupport);
  }, []);

  useEffect(() => {
    return subscribeSettings(() => {
      setMfaAppUrl(loadSettings().mfaAppUrl.trim());
    });
  }, []);

  if (support === null || support === "ok") return null;

  return (
    <div className="note note--warn passkey-note">
      <IconAlert />
      <div className="passkey-note__body">
        <p>{WEBAUTHN_FALLBACK}</p>
        {mfaAppUrl ? (
          <div className="passkey-note__qr">
            <QrCode
              value={mfaAppUrl}
              label="Scan to open the Mobile MFA app and finish with a passkey on your phone"
              size={128}
            />
            <p className="hint">
              Scan with your phone to open the MFA app and finish with a passkey
              there.{" "}
              <a href={mfaAppUrl} target="_blank" rel="noreferrer noopener">
                Open link
              </a>
            </p>
          </div>
        ) : (
          <p className="hint">
            Set a Mobile MFA URL in Settings to show a handoff QR here.
          </p>
        )}
      </div>
    </div>
  );
}
