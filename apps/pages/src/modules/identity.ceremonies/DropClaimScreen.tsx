/**
 * Opening a drop (ADR 0062, ADR 0090; ADR 0140 D2): the separate code the
 * sender shared, then the payload, decrypted here under the key the link
 * carried.
 *
 * The recipient's side of a drop is always-on: the `/claim` route takes the
 * link out of the address at boot and draws this for a drop — bearer and
 * key — on every installation, whether or not this device can *send* drops
 * (`sharing.drops`). It is loaded lazily inside the ceremonies module, only
 * when a drop arrives. Nothing here reads the address, and the key is held
 * in memory only, never stored.
 *
 * Works without an Identity API: the sealed claim lives on this origin when
 * Pages is the claim host. A refusal's words are `dropRefusal`'s, shown as a
 * mark beside the code (and in the notifications tray, where the shell is
 * mounted), never in a box.
 */

import {
  DropError,
  type DropPayload,
  openDrop,
  presentDrop,
} from "@opensesame/app-core/lib/claims/drop-open.js";
import {
  DROP_FAILURE_MARK_WITH_TRAY,
  reportClaim,
} from "@opensesame/app-core/lib/claims/route-model.js";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { FormCommit } from "../../components/FormCommit.js";
import { IconDownload } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { asBufferSource } from "@opensesame/os-domain";

/** What a drop link carried. */
export type DropOpenerProps = Readonly<{
  token: string;
  /** The drop key from the link's `#key=`; never stored, never sent. */
  fragmentKey: string;
  /** A portable drop's sealed packet from the link's `#pkt=`, when present. */
  pkt?: string | undefined;
  /** The drop was opened, or refused for good: forget the arrival. */
  onSettled: () => void;
}>;

const TITLE = "Drop";
const OPENED = "Drop opened";
const FALLBACK = "The drop could not be opened.";
/** A portable bearer with no `#key=` beside it can never open. */
const MISSING_SECRET =
  "This link is missing its secret part. Ask the sender for the full link.";

/** Refusals the same link and code could still get past. */
const RETRYABLE: ReadonlySet<string> = new Set(["invalid_code", "unreachable"]);
const LOCKED_OUT = "locked_out";

type DropFailureMark = Readonly<{ tone: "err"; label: string }>;

function spent(err: Error): boolean {
  return !(err instanceof DropError && RETRYABLE.has(err.code));
}

function failureMark(err: Error): DropFailureMark {
  if (err instanceof DropError && err.code === LOCKED_OUT) {
    return { tone: "err", label: "Locked out" };
  }
  return { tone: "err", label: DROP_FAILURE_MARK_WITH_TRAY };
}

function PayloadView({ payload }: { payload: DropPayload }) {
  const href = useMemo(
    () =>
      payload.kind === "text"
        ? null
        : URL.createObjectURL(
            new Blob([asBufferSource(payload.bytes)], { type: payload.contentType }),
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
  pkt,
  onSettled,
}: DropOpenerProps) {
  const [userCode, setUserCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [failureMarkLabel, setFailureMarkLabel] = useState(
    DROP_FAILURE_MARK_WITH_TRAY,
  );
  const [payload, setPayload] = useState<DropPayload | null>(null);
  const codeRef = useRef<HTMLInputElement | null>(null);

  // Arriving with a drop, the only question left is the code.
  useEffect(() => {
    codeRef.current?.focus();
  }, []);

  // A link whose key never arrived is refused before anything is presented.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, on arrival
  useEffect(() => {
    if (fragmentKey !== "") return;
    reportClaim(MISSING_SECRET, TITLE);
    setFailureMarkLabel(DROP_FAILURE_MARK_WITH_TRAY);
    setFailed(true);
    onSettled();
  }, []);

  async function open(event: FormEvent) {
    event.preventDefault();
    if (busy || !userCode.trim() || fragmentKey === "") return;
    setBusy(true);
    setFailed(false);
    setFailureMarkLabel(DROP_FAILURE_MARK_WITH_TRAY);
    try {
      const { targetManifest } = await presentDrop(token, userCode.trim(), pkt);
      setPayload(await openDrop(targetManifest, fragmentKey));
      onSettled();
    } catch (caught) {
      const err = caught instanceof Error ? caught : new Error(FALLBACK);
      reportClaim(err.message, TITLE);
      setFailureMarkLabel(failureMark(err).label);
      setFailed(true);
      // A drop is presented once: past a refusal it cannot come back from,
      // the link is forgotten here too.
      if (spent(err)) onSettled();
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
        <label htmlFor="drop-user-code">
          {pkt === undefined ? "One-time code" : "Code"}
        </label>
        <div className="field-inline">
          <input
            id="drop-user-code"
            ref={codeRef}
            name="userCode"
            className="mono f__input--mono"
            autoComplete="one-time-code"
            spellCheck={false}
            value={userCode}
            disabled={busy}
            aria-describedby={failed ? "drop-user-code-mark" : undefined}
            onChange={(event) => {
              setUserCode(event.target.value);
              if (failed) {
                setFailed(false);
                setFailureMarkLabel(DROP_FAILURE_MARK_WITH_TRAY);
              }
            }}
          />
          <output id="drop-user-code-mark" aria-live="polite">
            {failed ? <StatusMark tone="err" label={failureMarkLabel} /> : null}
          </output>
        </div>
      </div>
      <FormCommit
        label={busy ? "Opening…" : "Open drop"}
        disabled={busy || !userCode.trim() || fragmentKey === ""}
        busy={busy}
      />
    </form>
  );
}
