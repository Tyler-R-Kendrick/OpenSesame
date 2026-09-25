/**
 * The ownership claim's screens, one per step of `createClaimCeremony`
 * (ADR 0045, ADR 0140 plan step 8): a link to paste, a claim waiting for
 * someone to accept as, the claim to review with the code its creator read
 * out, and the accepted mark. Every answer is a mark; a failure's words also
 * reach the notifications tray (`useClaimCeremony`), never a box on the page.
 */

import type {
  ClaimOpen,
  ClaimStep,
} from "@opensesame/app-core/lib/claims/ceremony.js";
import { CLAIM_ACCEPTED } from "@opensesame/app-core/lib/claims/route-model.js";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { FormCommit } from "../../components/FormCommit.js";
import { IconArrowRight, IconRefresh } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import type { ClaimTone } from "./useClaimCeremony.js";

type Said = { tone: ClaimTone | null; words: string | null };

function Mark({ id, said }: { id: string; said: Said }) {
  return (
    <output id={id} aria-live="polite">
      {said.tone && said.words ? (
        <StatusMark tone={said.tone} label={said.words} />
      ) : null}
    </output>
  );
}

/** No link arrived: paste one, or the bare token. Read once, then cleared. */
export function ClaimEntry({
  said,
  busy,
  onEntry,
}: {
  said: Said;
  busy: boolean;
  onEntry: (raw: string) => void;
}) {
  const [value, setValue] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    const raw = value;
    // The pasted bearer is not kept in the page once it has been read.
    setValue("");
    onEntry(raw);
  }
  return (
    <section className="panel" aria-label="Paste a claim">
      <div className="panel__body">
        <form onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="claim-entry">Claim link</label>
            <div className="field-inline">
              <input
                id="claim-entry"
                type="text"
                className="mono"
                autoComplete="off"
                spellCheck={false}
                placeholder="osc_clm_…"
                value={value}
                disabled={busy}
                aria-describedby={said.words ? "claim-entry-mark" : undefined}
                onChange={(event) => setValue(event.target.value)}
              />
              <Mark id="claim-entry-mark" said={said} />
              <button
                type="submit"
                className="icon-btn"
                disabled={busy || !value.trim()}
                aria-label="Open claim"
                title="Open claim"
              >
                <IconArrowRight size={16} />
              </button>
            </div>
          </div>
        </form>
      </div>
    </section>
  );
}

/** Waiting on something outside the page: a session, or the network. */
export function ClaimPaused({
  step,
  tone,
  busy,
  onRetry,
  onGuest,
}: {
  step: ClaimStep;
  tone: ClaimTone | null;
  busy: boolean;
  onRetry: () => void;
  onGuest: () => void;
}) {
  const identity =
    step.phase.kind === "paused" && step.phase.reason === "identity";
  return (
    <section className="panel" aria-label="Claim waiting">
      <div className="panel__head">
        <h2>
          Claim waiting{" "}
          {tone && step.message ? (
            <StatusMark tone={tone} label={step.message} />
          ) : null}
        </h2>
      </div>
      <div className="panel__body">
        <div className="actions">
          {identity ? (
            // The guest road is a choice object, so it keeps its words: a
            // provisional principal to accept as (`continueAsGuest`).
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={onGuest}
            >
              Continue as guest
            </button>
          ) : (
            <button
              type="button"
              className="icon-btn"
              disabled={busy}
              onClick={onRetry}
              aria-label="Try again"
              title="Try again"
            >
              <IconRefresh size={16} />
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function short(digest: string): string {
  return digest.length > 20 ? `${digest.slice(0, 20)}…` : digest;
}

/** The claim as presented, and the code that says the person consents. */
export function ClaimReviewForm({
  open,
  said,
  busy,
  online,
  onComplete,
}: {
  open: ClaimOpen;
  said: Said;
  busy: boolean;
  online: boolean;
  onComplete: (open: ClaimOpen, userCode: string) => void;
}) {
  const [code, setCode] = useState("");
  const codeRef = useRef<HTMLInputElement | null>(null);
  const { claim } = open;
  useEffect(() => {
    codeRef.current?.focus();
  }, []);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !code.trim()) return;
    onComplete(open, code);
  }
  return (
    <section className="panel" aria-label="Claim to review">
      <div className="panel__body">
        <dl className="kv">
          <div>
            <dt>Kind</dt>
            <dd>{claim.type}</dd>
          </div>
          <div>
            <dt>Items</dt>
            <dd>{claim.itemIds.length}</dd>
          </div>
          <div>
            <dt>Manifest</dt>
            <dd>
              <code title={claim.targetManifestDigest}>
                {short(claim.targetManifestDigest)}
              </code>
            </dd>
          </div>
        </dl>
        <form onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="claim-code">Consent code</label>
            <div className="field-inline">
              <input
                id="claim-code"
                ref={codeRef}
                type="text"
                className="mono"
                autoComplete="one-time-code"
                autoCapitalize="characters"
                spellCheck={false}
                value={code}
                disabled={busy}
                aria-describedby={said.words ? "claim-code-mark" : undefined}
                onChange={(event) => setCode(event.target.value)}
              />
              <Mark id="claim-code-mark" said={said} />
            </div>
          </div>
          <FormCommit
            label={busy ? "Accepting…" : "Accept claim"}
            disabled={busy || !online || !code.trim()}
            busy={busy}
          />
        </form>
      </div>
    </section>
  );
}

/** Accepted. The key that answered is gone, so the answer takes the focus. */
export function ClaimDone() {
  const root = useRef<HTMLElement | null>(null);
  useEffect(() => {
    root.current?.focus();
  }, []);
  return (
    <section
      className="panel"
      aria-label="Claim accepted"
      ref={root}
      tabIndex={-1}
    >
      <div className="panel__head">
        <h2>
          {CLAIM_ACCEPTED} <StatusMark tone="ok" label={CLAIM_ACCEPTED} />
        </h2>
      </div>
    </section>
  );
}
