import { approveDevice } from "@opensesame/app-core/lib/directory.js";
import type { IdentitySession } from "@opensesame/app-core/lib/identity.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { FormCommit } from "../../components/FormCommit.js";
import { IconAlert, IconCheck } from "../../components/Icons.js";
import { useIdentityConfigured } from "../../lib/use-configured.js";
import { ConnectIdentityNote } from "./ConnectIdentityNote.js";

type DevicesProps = { online: boolean; session: IdentitySession | null };

/** The directory's part of the Devices tab: approving a device that signs in. */
export function DirectoryDevices({ online, session }: DevicesProps) {
  const configured = useIdentityConfigured();
  return (
    <>
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
            <FormCommit
              label={busy ? "Approving…" : "Approve device"}
              disabled={busy || !online || !code.trim()}
              busy={busy || undefined}
            />
          </div>
        </form>
      </div>
    </section>
  );
}
