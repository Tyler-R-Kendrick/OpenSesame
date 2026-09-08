import { useCallback, useEffect, useRef, useState } from "react";
import {
  type PairingPrompt,
  beginBrowserPairing,
  clearBrowserPairing,
  pollBrowserPairing,
} from "../lib/browser-pairing.js";
import { CeremonyShell } from "./CeremonyShell.js";

export function BrowserPairingCeremony({
  hostApi,
  onComplete,
  onCancel,
}: { hostApi: string; onComplete: () => void; onCancel: () => void }) {
  const [prompt, setPrompt] = useState<PairingPrompt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const completed = useRef(false);
  const mounted = useRef(true);
  const polling = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    let live = true;
    generation.current += 1;
    completed.current = false;
    mounted.current = true;
    void beginBrowserPairing(hostApi).then(
      (value) => {
        if (live) setPrompt(value);
      },
      () => {
        if (live)
          setError(
            "Could not start pairing. Close this ceremony and try again.",
          );
      },
    );
    return () => {
      live = false;
      mounted.current = false;
      if (!completed.current) clearBrowserPairing();
    };
  }, [hostApi]);

  const poll = useCallback(async () => {
    if (polling.current || completed.current) return;
    polling.current = true;
    const activeGeneration = generation.current;
    setBusy(true);
    try {
      const grant = await pollBrowserPairing();
      if (grant && mounted.current && generation.current === activeGeneration) {
        completed.current = true;
        onComplete();
      }
    } catch {
      if (mounted.current && generation.current === activeGeneration)
        setError(
          "Approval expired or was refused. Close this ceremony and try again.",
        );
    } finally {
      polling.current = false;
      if (mounted.current && generation.current === activeGeneration)
        setBusy(false);
    }
  }, [onComplete]);
  useEffect(() => {
    if (!prompt || error) return;
    const timer = setInterval(() => void poll(), prompt.interval * 1000);
    return () => clearInterval(timer);
  }, [prompt, error, poll]);

  return (
    <PairingCard
      prompt={prompt}
      error={error}
      busy={busy}
      poll={poll}
      onCancel={onCancel}
    />
  );
}

function PairingCard({
  prompt,
  error,
  busy,
  poll,
  onCancel,
}: {
  prompt: PairingPrompt | null;
  error: string | null;
  busy: boolean;
  poll: () => Promise<void>;
  onCancel: () => void;
}) {
  return (
    <CeremonyShell
      ok={false}
      top="Local approval"
      name={prompt?.userCode ?? "Starting pairing…"}
      primary={{
        label: "Check approval",
        onClick: () => void poll(),
        busy,
        disabled: !prompt || !!error,
      }}
      secondary={{
        label: "Cancel",
        onClick: () => {
          clearBrowserPairing();
          onCancel();
        },
      }}
    >
      <ApprovalScope />
      {prompt ? (
        <p className="hint">
          <a
            href={prompt.verificationUri}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open local instructions
          </a>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="hint">
          {error}
        </p>
      ) : null}
    </CeremonyShell>
  );
}

function ApprovalScope() {
  return (
    <p className="hint">
      Enter this code in the Host's local approval ceremony. This grants
      encrypted sync only, expires in five minutes, and ends when this vault
      locks.
    </p>
  );
}
