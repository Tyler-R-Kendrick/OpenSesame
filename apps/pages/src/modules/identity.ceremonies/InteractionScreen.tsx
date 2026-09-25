/**
 * `/i/:ref` (ADR 0086; ADR 0140 plan step 9, D7): the phone half of a
 * cross-device approval, moved here from `apps/mobile-mfa`. Resolving the
 * link needs nothing; reading what it asks needs an Identity session; an
 * approval needs a passkey touch bound to this request — never a vault. The
 * route opens before unlock, on a locked or empty device too.
 *
 * The ceremony is ceremony-kit's (`createInteractionApproval`): the digest
 * first shown is frozen and echoed, an approval begins an activation naming
 * that digest and the verb, the authenticator runs over the authority's
 * options unaltered, and the approve names the activation the authority
 * verified (it binds the policy digest and spends it by compare-and-set). A
 * deny echoes the digest and needs no proof. Every refusal is the model's
 * words on a mark, and in the tray.
 *
 * Loaded only on this route (`lazy-routes.tsx`).
 */

import {
  captureInteractionArrivalFromPage,
  peekInteractionArrival,
} from "@opensesame/app-core/lib/interactions-link.js";
import {
  INTERACTION_LABELS,
  INTERACTION_SIGN_IN,
  type InteractionEntry,
  type InteractionPhase,
  type Outcome,
  interactionEntry,
  outcomeMark,
} from "@opensesame/app-core/lib/interactions-route.js";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { FormCommit } from "../../components/FormCommit.js";
import { IconKey } from "../../components/IconKey.js";
import { IconPasskey, IconRefresh, IconX } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { firstControl, keyboardIsIdle, landFocus } from "../../lib/focus.js";
import { useIdentityConfigured } from "../../lib/use-configured.js";
import { useOnline } from "../../lib/use-online.js";
import { ConnectIdentityNote } from "../../sections/identity/ConnectIdentityNote.js";
import { type InteractionView, useInteraction } from "./useInteraction.js";

type Review = Extract<InteractionPhase, { kind: "review" }>;

/** The question is over: its word, and its mark. The answer takes the focus. */
function Ended({ outcome, words }: { outcome: Outcome; words?: string }) {
  const root = useRef<HTMLElement | null>(null);
  const mark = outcomeMark(outcome);
  useEffect(() => {
    root.current?.focus();
  }, []);
  return (
    <section className="panel" aria-label={mark.label} ref={root} tabIndex={-1}>
      <div className="panel__head">
        <h2>
          {mark.label}{" "}
          <StatusMark tone={mark.tone} label={words ?? mark.words} />
        </h2>
      </div>
    </section>
  );
}

function Said({ message }: { message: string | null }) {
  return (
    <output aria-live="polite">
      {message ? <StatusMark tone="err" label={message} /> : null}
    </output>
  );
}

function ReviewPanel({
  phase,
  view,
  online,
}: {
  phase: Review;
  view: InteractionView;
  online: boolean;
}) {
  const { view: shown, mechanism } = phase;
  const { busy } = view;
  return (
    <section className="panel" aria-label={shown.title}>
      <div className="panel__head">
        <h2>{shown.title}</h2>
      </div>
      <div className="panel__body">
        <dl className="kv">
          {shown.match === undefined ? null : (
            <div>
              <dt>{INTERACTION_LABELS.match}</dt>
              <dd>
                <strong>{shown.match}</strong>
              </dd>
            </div>
          )}
        </dl>
        <ul>
          {shown.facts.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <FormCommit
          label={INTERACTION_LABELS.approve}
          icon={<IconPasskey size={18} />}
          disabled={busy || !online || mechanism === undefined}
          busy={busy}
          onClick={view.approve}
        >
          <IconKey
            label={INTERACTION_LABELS.deny}
            danger
            disabled={busy || !online}
            onClick={view.deny}
          >
            <IconX size={16} />
          </IconKey>
          <Said message={view.step.message} />
        </FormCommit>
      </div>
    </section>
  );
}

function Ceremony({ ceremonyRef }: { ceremonyRef: string }) {
  const online = useOnline();
  const view = useInteraction(ceremonyRef);
  const root = useRef<HTMLDivElement | null>(null);
  const { phase, message } = view.step;

  // A step that replaces the one holding the focus lands on its first key,
  // when nothing else holds it — or only the page's own landmark.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new phase is the trigger
  useEffect(() => {
    const onLandmark = document.activeElement === root.current?.closest("main");
    if (keyboardIsIdle() || onLandmark) landFocus(firstControl(root.current));
  }, [phase.kind]);

  let body = null;
  if (phase.kind === "done") body = <Ended outcome={phase.outcome} />;
  else if (phase.kind === "review")
    body = <ReviewPanel phase={phase} view={view} online={online} />;
  else if (phase.kind === "stalled")
    body = (
      <section className="panel" aria-label={INTERACTION_LABELS.retry}>
        <div className="panel__body">
          <div className="actions">
            <IconKey
              label={INTERACTION_LABELS.retry}
              disabled={view.busy || !online}
              onClick={view.load}
            >
              <IconRefresh size={16} />
            </IconKey>
            <Said message={message} />
          </div>
        </div>
      </section>
    );
  else if (phase.kind === "signin")
    body = (
      <>
        <section className="panel" aria-label={INTERACTION_LABELS.read}>
          <div className="panel__head">
            <h2>
              {INTERACTION_LABELS.read}{" "}
              <StatusMark tone="warn" label={message ?? INTERACTION_SIGN_IN} />
            </h2>
          </div>
          {phase.expiresAt ? (
            <div className="panel__body">
              <p className="hint">
                <time dateTime={phase.expiresAt.toISOString()}>
                  {phase.expiresAt.toLocaleString()}
                </time>
              </p>
            </div>
          ) : null}
        </section>
        <ConnectIdentityNote online={online} what="the requests sent to you" />
      </>
    );
  return <div ref={root}>{body}</div>;
}

/** Which reference this address opens, read once per mount. */
function useEntry(): InteractionEntry {
  const { pathname } = useLocation();
  const [arrival] = useState(() => {
    // An in-app navigation never passed through boot: read it here, the
    // same way, before anything is called.
    captureInteractionArrivalFromPage();
    return peekInteractionArrival();
  });
  return interactionEntry(arrival, pathname);
}

export function InteractionScreen() {
  const online = useOnline();
  const configured = useIdentityConfigured();
  const entry = useEntry();
  return (
    <div className="section__inner">
      <div className="section__head">
        <h1>{INTERACTION_LABELS.title}</h1>
      </div>
      {entry.kind === "ended" ? (
        <Ended outcome={entry.outcome} words={entry.words} />
      ) : configured ? (
        <Ceremony ceremonyRef={entry.ref} />
      ) : (
        <ConnectIdentityNote online={online} what="the requests sent to you" />
      )}
    </div>
  );
}
