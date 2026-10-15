/**
 * Owner-side peer trust signal for browser-only live peering (lazy chunk).
 */
import { useEffect, useState } from "react";
import {
  CopyButton,
  FieldRow,
  useCopyFeedback,
} from "../../components/FieldRow.js";
import { StatusMark } from "../../components/StatusMark.js";

type ExportReady =
  | Readonly<{
      signal: string;
      sas: string;
    }>
  | Readonly<{ failed: true }>;

export default function LivePeerTrustExport() {
  const [ready, setReady] = useState<ExportReady | null>(null);
  const signalCopy = useCopyFeedback();
  const sasCopy = useCopyFeedback();

  useEffect(() => {
    let cancelled = false;
    void import("@opensesame/app-core/lib/live/peer-trust-peering.js").then(
      (peering) =>
        peering.exportLivePeerTrustSignal().then((result) => {
          if (cancelled) return;
          if (!result.ok) {
            setReady({ failed: true });
            return;
          }
          setReady({ signal: result.signal, sas: result.sas });
        }),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) return null;
  if ("failed" in ready) {
    return (
      <StatusMark tone="warn" label="Peer trust is not available on this device" />
    );
  }

  return (
    <>
      <FieldRow
        label="Peer trust signal"
        actions={
          <CopyButton
            value={ready.signal}
            label="peer trust signal"
            fieldKey="live-peer-trust-signal"
            copied={signalCopy.copied}
            failed={signalCopy.failed}
            onCopy={signalCopy.copy}
          />
        }
      >
        <span className="frow__value frow__value--mono">…</span>
      </FieldRow>
      <FieldRow
        label="Short authentication string"
        actions={
          <CopyButton
            value={ready.sas}
            label="short authentication string"
            fieldKey="live-peer-trust-sas"
            copied={sasCopy.copied}
            failed={sasCopy.failed}
            onCopy={sasCopy.copy}
          />
        }
      >
        <span className="frow__value frow__value--mono">{ready.sas}</span>
      </FieldRow>
    </>
  );
}
