import { useState } from "react";
/**
 * The drop branch of the claim acceptance page (ADR 0062): an account-free
 * recipient enters the user code, the page presents `{token, userCode}`
 * exactly once, decrypts the returned manifest with the fragment key, and
 * reveals the text or offers the file for download. Opening burns the drop —
 * a second visit anywhere is refused by the single-use CAS and this page
 * renders "This drop was already opened."
 */

import { type DropPayload, openDrop, presentDrop } from "../lib/drop.js";

function downloadFile(payload: {
  name: string;
  contentType: string;
  bytes: Uint8Array;
}): void {
  // SAFETY: Blob accepts a typed array view; bytes is a fresh local buffer.
  const blob = new Blob([payload.bytes], { type: payload.contentType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = payload.name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function DropAcceptance({
  token,
  fragmentKey,
}: {
  token: string;
  fragmentKey: string;
}) {
  const [userCode, setUserCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<DropPayload | null>(null);
  const [copied, setCopied] = useState(false);

  async function open() {
    const code = userCode.trim();
    if (!code) return;
    setBusy(true);
    setError(null);
    try {
      const manifest = await presentDrop(token, code);
      // Decrypt immediately, in the same gesture: presentation burns the
      // drop, so the reveal must happen in this sitting.
      setPayload(await openDrop(manifest, fragmentKey));
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The drop could not be opened.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (payload) {
    return (
      <section className="panel">
        <div className="badge">Secret drop</div>
        <h1>{payload.name || "Your drop"}</h1>
        <p>
          This drop is now burned — it cannot be opened again by anyone,
          including you. Take what you need before leaving this page.
        </p>
        {payload.kind === "text" ? (
          <>
            <pre className="drop-reveal">{payload.text}</pre>
            <div className="actions">
              <button
                type="button"
                className="primary"
                onClick={() => void copyText(payload.text)}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </>
        ) : (
          <div className="actions">
            <button
              type="button"
              className="primary"
              onClick={() => downloadFile(payload)}
            >
              Download {payload.name || "file"}
            </button>
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="badge">Secret drop</div>
      <h1>Someone dropped you a secret</h1>
      <p>
        It opens exactly once. Enter the code the sender shared separately — the
        link alone is not enough — and the secret is revealed here, then gone
        for everyone.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void open();
        }}
      >
        <div className="field">
          <label htmlFor="drop-code">Drop code</label>
          <input
            id="drop-code"
            autoComplete="one-time-code"
            placeholder="ABCD-EFGH"
            value={userCode}
            disabled={busy}
            onChange={(event) => setUserCode(event.target.value.toUpperCase())}
          />
        </div>
        {error ? (
          <p className="err" role="alert">
            {error}
          </p>
        ) : null}
        <div className="actions">
          <button
            type="submit"
            className="primary"
            disabled={busy || !userCode.trim()}
            aria-busy={busy}
          >
            {busy ? "Opening…" : "Open drop"}
          </button>
        </div>
      </form>
    </section>
  );
}
