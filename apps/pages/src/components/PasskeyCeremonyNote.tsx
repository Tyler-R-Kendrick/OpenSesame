import { useEffect, useState } from "react";
import {
  loadSettings,
  saveSettings,
  subscribeSettings,
} from "../lib/settings.js";
import { webauthnSeams } from "../lib/webauthn.js";
import { FieldShell } from "./FieldShell.js";
import { IconAlert, IconPhone } from "./Icons.js";
import { QrCode } from "./QrCode.js";

function PasskeyCeremonyNoteDefault() {
  const [support, setSupport] = useState<"ok" | "partial" | "missing" | null>(
    null,
  );
  const [mfaAppUrl, setMfaAppUrl] = useState(() =>
    loadSettings().mfaAppUrl.trim(),
  );

  useEffect(() => {
    void webauthnSeams.detectWebAuthn().then(setSupport);
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
        <p>{webauthnSeams.WEBAUTHN_FALLBACK}</p>
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
          // Setting the URL is one field, so it happens here — a sentence
          // pointing at Settings was a dead end with nothing to click.
          <MfaUrlField />
        )}
      </div>
    </div>
  );
}

/** The Mobile MFA URL, editable in place. Commits on blur, like Endpoints. */
function MfaUrlField() {
  const [value, setValue] = useState("");
  return (
    <FieldShell
      id="passkey-note-mfa-url"
      label="Mobile MFA app URL"
      type="url"
      mono
      lead={<IconPhone size={17} />}
      placeholder="https://phone.example/mfa"
      value={value}
      onValueChange={setValue}
      onCommit={(raw) => {
        const next = raw.trim().replace(/\/$/, "");
        const current = loadSettings();
        if (!next || current.mfaAppUrl === next) return;
        saveSettings({ ...current, mfaAppUrl: next });
      }}
      hint="Saves when you leave the field; the handoff QR appears here."
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
