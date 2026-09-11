import { type FormEvent, useEffect, useRef, useState } from "react";
import { IconAlert, IconCheck } from "../../components/Icons.js";
import { approveDevice } from "../../lib/directory.js";
import type { IdentitySession } from "../../lib/identity.js";
import { useIdentityConfigured } from "../../lib/use-configured.js";
import { useVaultStore } from "../../lib/vault/hooks.js";
import type { Flash } from "../connections/shared.js";
import { ConnectIdentityNote } from "./ConnectIdentityNote.js";
import { LocalDevicesPanel } from "./LocalDevicesPanel.js";

export function DevicesPanel({
  online,
  session,
}: {
  online: boolean;
  session: IdentitySession | null;
}) {
  const configured = useIdentityConfigured();
  const tomb = useVaultStore().activeTomb();
  return (
    <>
      <LocalDevicesPanel key={tomb} tomb={tomb} />
      {configured && session ? <ApproveDeviceCard online={online} /> : null}
      {configured && !session ? (
        <ConnectIdentityNote
          online={online}
          what="Approving the devices that sign in"
        />
      ) : null}
    </>
  );
}

function ApproveDeviceCard({ online }: { online: boolean }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Flash | null>(null);
  const codeRef = useRef<HTMLInputElement | null>(null);

  // The user code is the whole ceremony, so it leads the form.
  useEffect(() => {
    codeRef.current?.focus();
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const userCode = code.trim();
    if (!userCode) return;
    setBusy(true);
    setResult(null);
    try {
      await approveDevice(userCode);
      setResult({ tone: "ok", text: "Device approved." });
      setCode("");
      codeRef.current?.focus();
    } catch (caught) {
      setResult({
        tone: "err",
        text:
          caught instanceof Error ? caught.message : "Something went wrong.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Approve a device</h2>
        </div>
      </div>

      <div className="panel__body">
        <form
          className="identity-claim"
          onSubmit={(event) => void submit(event)}
          noValidate
        >
          <div className="field">
            <label className="label" htmlFor="identity-device-code">
              User code
            </label>
            <input
              id="identity-device-code"
              ref={codeRef}
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="WORD-WORD"
              value={code}
              disabled={busy}
              onChange={(event) => {
                setCode(event.target.value);
                setResult(null);
              }}
            />
          </div>

          {result ? (
            <p
              className={`note note--${result.tone}`}
              role={result.tone === "err" ? "alert" : undefined}
            >
              {result.tone === "ok" ? <IconCheck /> : <IconAlert />}
              {result.text}
            </p>
          ) : null}

          <div className="actions actions--end">
            <button
              type="submit"
              className="btn btn--primary"
              disabled={busy || !online || !code.trim()}
              aria-busy={busy || undefined}
            >
              {busy ? "Approving…" : "Approve device"}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
