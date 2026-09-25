/**
 * Opening a drop (ADR 0062, ADR 0090): the one-time code the sender shared,
 * then the payload, decrypted here under the key the link carried.
 *
 * The `/claim` route (always-on `identity.ceremonies`, ADR 0140) takes the
 * link out of the address at boot and dispatches a drop — bearer and key —
 * to this opener, which `sharing.drops` hands over as a `claim-opener`
 * contribution. Nothing here reads the address: the fragment left it before
 * the first paint, and the key is held in memory only, never stored.
 *
 * Works without an Identity API: the sealed claim lives on this origin when
 * Pages is the claim host. A refusal's words are `dropRefusal`'s, shown as a
 * mark beside the code and in the notifications tray, never in a box.
 */

import type { ClaimOpenerProps } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import {
  clearClaimNotice,
  reportClaim,
} from "@opensesame/app-core/lib/claims/route-model.js";
import {
  DropError,
  type DropPayload,
  openDrop,
  presentDrop,
} from "@opensesame/app-core/lib/vault/drop.js";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { FormCommit } from "../components/FormCommit.js";
import { IconDownload } from "../components/Icons.js";
import { StatusMark } from "../components/StatusMark.js";

const TITLE = "Drop";
const OPENED = "Drop opened";
const FALLBACK = "The drop could not be opened.";

/** Refusals the same link and code could still get past. */
const RETRYABLE: ReadonlySet<string> = new Set(["invalid_code", "unreachable"]);

function spent(caught: unknown): boolean {
  return !(caught instanceof DropError && RETRYABLE.has(caught.code));
}

function PayloadView({ payload }: { payload: DropPayload }) {
  const href = useMemo(
    () =>
      payload.kind === "text"
        ? null
        : URL.createObjectURL(
            new Blob([payload.bytes], { type: payload.contentType }),
          ),
    [payload],
  );
  useEffect(() => () => (href ? URL.revokeObjectURL(href) : undefined), [href]);
  return (
    <section className="detail__group" aria-label="Opened drop">
      <h2 className="detail__grouphead">
        {payload.name} <StatusMark tone="ok" label={OPENED} />
      </h2>
      {payload.kind === "text" ? (
        <pre className="codeblock">{payload.text}</pre>
      ) : (
        <div className="field-inline">
          <span className="mono">{payload.contentType}</span>
          <a
            className="icon-btn"
            href={href ?? undefined}
            download={payload.name}
            aria-label={`Download ${payload.name}`}
            title={`Download ${payload.name}`}
          >
            <IconDownload size={16} />
          </a>
        </div>
      )}
    </section>
  );
}

export function DropClaimScreen({
  token,
  fragmentKey,
  onSettled,
}: ClaimOpenerProps) {
  const [userCode, setUserCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [payload, setPayload] = useState<DropPayload | null>(null);
  const codeRef = useRef<HTMLInputElement | null>(null);

  // Arriving with a drop, the only question left is the code.
  useEffect(() => {
    codeRef.current?.focus();
  }, []);

  async function open(event: FormEvent) {
    event.preventDefault();
    if (busy || !userCode.trim()) return;
    setBusy(true);
    setFailure(null);
    try {
      const { targetManifest } = await presentDrop(token, userCode.trim());
      setPayload(await openDrop(targetManifest, fragmentKey));
      clearClaimNotice();
      onSettled();
    } catch (caught) {
      const words = caught instanceof Error ? caught.message : FALLBACK;
      reportClaim(words, TITLE);
      setFailure(words);
      // A drop is presented once: past a refusal it cannot come back from,
      // the link is forgotten here too.
      if (spent(caught)) onSettled();
      else codeRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  if (payload) return <PayloadView payload={payload} />;
  return (
    <form
      className="drop-open"
      aria-label="Open a drop"
      onSubmit={(event) => void open(event)}
      noValidate
    >
      <div className="field">
        <label htmlFor="drop-user-code">One-time code</label>
        <div className="field-inline">
          <input
            id="drop-user-code"
            ref={codeRef}
            name="userCode"
            className="mono"
            autoComplete="one-time-code"
            spellCheck={false}
            value={userCode}
            disabled={busy}
            aria-describedby={failure ? "drop-user-code-mark" : undefined}
            onChange={(event) => {
              setUserCode(event.target.value);
              if (failure) {
                setFailure(null);
                clearClaimNotice();
              }
            }}
          />
          <output id="drop-user-code-mark" aria-live="polite">
            {failure ? <StatusMark tone="err" label={failure} /> : null}
          </output>
        </div>
      </div>
      <FormCommit
        label={busy ? "Opening…" : "Open drop"}
        disabled={busy || !userCode.trim()}
        busy={busy}
      />
    </form>
  );
}
