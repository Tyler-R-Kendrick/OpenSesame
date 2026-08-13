import { useEffect, useState } from "react";
import { WEBAUTHN_FALLBACK, detectWebAuthn } from "../lib/webauthn.js";
import { IconAlert } from "./Icons.js";

export function PasskeyCeremonyNote() {
  const [support, setSupport] = useState<"ok" | "partial" | "missing" | null>(
    null,
  );
  useEffect(() => {
    void detectWebAuthn().then(setSupport);
  }, []);
  if (support === null || support === "ok") return null;
  return (
    <p className="note note--warn">
      <IconAlert />
      {WEBAUTHN_FALLBACK}
    </p>
  );
}
