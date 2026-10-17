/**
 * Owner-side peer trust signal for browser-only live peering (lazy chunk).
 */
import { sasFromFingerprint } from "@opensesame/app-core/lib/peer-trust/sas.js";
import { useEffect, useState } from "react";
import {
  CopyButton,
  FieldRow,
  useCopyFeedback,
} from "../../components/FieldRow.js";
import { IconEye, IconEyeOff } from "../../components/Icons.js";
import { QrCode } from "../../components/QrCode.js";
import { StatusMark } from "../../components/StatusMark.js";
import { ensureOwnerDtlsPin } from "./live-dtls-pin.js";

type ExportReady =
  | Readonly<{
      signal: string;
      fingerprint: string;
    }>
  | Readonly<{ failed: true }>;

export default function LivePeerTrustExport() {
  const [ready, setReady] = useState<ExportReady | null>(null);
  const [showQr, setShowQr] = useState(false);
  const signalCopy = useCopyFeedback();

  useEffect(() => {
    let cancelled = false;
    const fail = () => {
      if (!cancelled) setReady({ failed: true });
    };
    void ensureOwnerDtlsPin()
      .then((ownerDtls) =>
        import("@opensesame/app-core/lib/live/peer-trust-peering.js").then(
          (peering) => peering.exportLivePeerTrustSignal({ ownerDtls }),
        ),
      )
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setReady({ failed: true });
          return;
        }
        const fingerprint = sasFromFingerprint(result.spkiFingerprint);
        if (!fingerprint) {
          setReady({ failed: true });
          return;
        }
        setReady({ signal: result.signal, fingerprint });
      })
      .catch(fail);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) return null;
  if ("failed" in ready) {
    return (
      <StatusMark
        tone="warn"
        label="Peer trust is not available on this device"
      />
    );
  }
  const qrLabel = showQr ? "Hide fingerprint QR" : "Show fingerprint QR";

  return (
    <>
      <FieldRow
        label="Fingerprint"
        actions={
          <>
            <CopyButton
              value={ready.signal}
              label="peer trust signal"
              fieldKey="live-peer-trust-signal"
              copied={signalCopy.copied}
              failed={signalCopy.failed}
              onCopy={signalCopy.copy}
            />
            <button
              type="button"
              className="icon-btn"
              aria-label={qrLabel}
              title={qrLabel}
              onClick={() => setShowQr((open) => !open)}
            >
              {showQr ? <IconEyeOff size={16} /> : <IconEye size={16} />}
            </button>
          </>
        }
      >
        <span className="frow__value frow__value--mono live-sas">
          {ready.fingerprint}
        </span>
      </FieldRow>
      {showQr ? (
        <QrCode value={ready.signal} label="Peer trust signal" />
      ) : null}
    </>
  );
}
