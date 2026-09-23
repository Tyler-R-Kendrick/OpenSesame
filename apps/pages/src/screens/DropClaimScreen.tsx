/**
 * Pages-hosted drop acceptance (ADR 0062 + ADR 0090).
 *
 * Works without an unlocked vault and without an Identity API: the sealed
 * claim lives on this origin when Pages is the claim host.
 */

import {
  type DropPayload,
  openDrop,
  presentDrop,
} from "@opensesame/app-core/lib/vault/drop.js";
import { isString } from "@opensesame/os-domain";
import { useMemo, useState } from "react";
import { Link } from "react-router";

function readFragment(): { token: string; key: string } | null {
  const hash = globalThis.location?.hash?.replace(/^#/, "") ?? "";
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const token = params.get("token");
  const key = params.get("key");
  if (!isString(token) || token.length === 0) return null;
  if (!isString(key) || key.length === 0) return null;
  return { token, key };
}

function PayloadView({ payload }: { payload: DropPayload }) {
  if (payload.kind === "text") {
    return (
      <section className="detail__group" aria-label="Opened drop">
        <h2 className="detail__grouphead">{payload.name}</h2>
        <pre className="codeblock">{payload.text}</pre>
      </section>
    );
  }
  const blob = new Blob([payload.bytes], { type: payload.contentType });
  const href = URL.createObjectURL(blob);
  return (
    <section className="detail__group" aria-label="Opened drop">
      <h2 className="detail__grouphead">{payload.name}</h2>
      <p className="hint">{payload.contentType}</p>
      <a
        className="btn btn--primary btn--sm"
        href={href}
        download={payload.name}
      >
        Download
      </a>
    </section>
  );
}

export function DropClaimScreen() {
  const fragment = useMemo(() => readFragment(), []);
  const [userCode, setUserCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<DropPayload | null>(null);

  async function open() {
    if (!fragment) return;
    setBusy(true);
    setError(null);
    try {
      const { targetManifest } = await presentDrop(
        fragment.token,
        userCode.trim(),
      );
      const opened = await openDrop(targetManifest, fragment.key);
      setPayload(opened);
      // Strip the fragment so a reload cannot re-present from the address bar.
      globalThis.history.replaceState(
        null,
        "",
        `${globalThis.location.pathname}${globalThis.location.search}`,
      );
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

  if (!fragment) {
    return (
      <main className="unlock" aria-label="Open a drop">
        <h1>Open a drop</h1>
        <p className="hint">
          This link is missing its claim token or key. Ask the sender for a
          fresh drop link.
        </p>
        <Link className="btn btn--sm" to="/">
          Back
        </Link>
      </main>
    );
  }

  if (payload) {
    return (
      <main className="unlock" aria-label="Drop opened">
        <h1>Drop opened</h1>
        <p className="hint">This drop can only be opened once.</p>
        <PayloadView payload={payload} />
        <Link className="btn btn--sm" to="/">
          Done
        </Link>
      </main>
    );
  }

  return (
    <main className="unlock" aria-label="Open a drop">
      <h1>Open a drop</h1>
      <p className="hint">
        Enter the code the sender shared out of band. The payload stays sealed
        until the code matches.
      </p>
      <div className="field">
        <label htmlFor="drop-user-code">One-time code</label>
        <input
          id="drop-user-code"
          name="userCode"
          autoComplete="one-time-code"
          inputMode="text"
          value={userCode}
          onChange={(event) => setUserCode(event.target.value)}
          disabled={busy}
        />
      </div>
      {error ? (
        <p className="note note--err" role="alert">
          <span>{error}</span>
        </p>
      ) : null}
      <div className="actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy || userCode.trim().length === 0}
          aria-busy={busy}
          onClick={() => void open()}
        >
          {busy ? "Opening…" : "Open once"}
        </button>
      </div>
    </main>
  );
}
