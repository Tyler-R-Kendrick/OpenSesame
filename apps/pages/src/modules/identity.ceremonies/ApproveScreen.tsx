/**
 * `/approve/:ref` (ADR 0084; ADR 0140 plan step 9, D7): the review a
 * notification's rendezvous link and Access › Requests' hosted rows open,
 * moved here from `apps/ceremonies`. It needs an Identity session, never a
 * vault: the route opens before unlock, on a locked or empty device too, and
 * without a session — or with no Identity API configured — it shows the
 * Connect note every Identity-plane panel does.
 *
 * The review is ceremony-kit's (`createApprovalReview`): request, then
 * requirement; decide or report; the digest and policy digest first shown
 * are frozen, and an activation is minted naming that digest and the verb,
 * refused before the passkey is asked for when it came back under another
 * policy, and spent by the settle that names it. Every refusal is the
 * model's words on a mark, and in the tray.
 *
 * Loaded only on this route (`lazy-routes.tsx`).
 */

import {
  captureApprovalArrivalFromPage,
  peekApprovalArrival,
} from "@opensesame/app-core/lib/approvals-link.js";
import {
  APPROVAL_LABELS,
  APPROVAL_LINK_ENDED,
  APPROVAL_SIGN_IN,
  type ApprovalEnding,
  type ApprovalEntry,
  approvalEntry,
  endingMark,
} from "@opensesame/app-core/lib/approvals-route.js";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { useIdentitySession } from "../../bindings/identity.js";
import { IconKey } from "../../components/IconKey.js";
import { IconRefresh } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { firstControl, keyboardIsIdle, landFocus } from "../../lib/focus.js";
import { useIdentityConfigured } from "../../lib/use-configured.js";
import { useOnline } from "../../lib/use-online.js";
import { ConnectIdentityNote } from "../../sections/identity/ConnectIdentityNote.js";
import { ApproveReview } from "./ApproveReview.js";
import { useApprovalReview } from "./useApprovalReview.js";

/** The review is over. The key that ended it is gone, so this takes the focus. */
function Ended({ ending }: { ending: ApprovalEnding }) {
  const root = useRef<HTMLElement | null>(null);
  const mark = endingMark(ending);
  useEffect(() => {
    root.current?.focus();
  }, []);
  return (
    <section className="panel" aria-label={mark.title} ref={root} tabIndex={-1}>
      <div className="panel__head">
        <h2>
          {mark.title} <StatusMark tone={mark.tone} label={mark.words} />
        </h2>
      </div>
    </section>
  );
}

function Review({ ceremonyRef }: { ceremonyRef: string }) {
  const online = useOnline();
  const view = useApprovalReview(ceremonyRef);
  const root = useRef<HTMLDivElement | null>(null);
  const { phase, message } = view.step;

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new phase is the trigger
  useEffect(() => {
    const onLandmark = document.activeElement === root.current?.closest("main");
    if (keyboardIsIdle() || onLandmark) landFocus(firstControl(root.current));
  }, [phase.kind]);

  let body = null;
  if (phase.kind === "done") body = <Ended ending={phase.ending} />;
  else if (phase.kind === "review")
    body = <ApproveReview phase={phase} view={view} online={online} />;
  else if (phase.kind === "stalled")
    body = (
      <section className="panel" aria-label={APPROVAL_LABELS.retry}>
        <div className="panel__body">
          <div className="actions">
            <IconKey
              label={APPROVAL_LABELS.retry}
              disabled={view.busy || !online}
              onClick={view.load}
            >
              <IconRefresh size={16} />
            </IconKey>
            <output aria-live="polite">
              {message ? <StatusMark tone="err" label={message} /> : null}
            </output>
          </div>
        </div>
      </section>
    );
  return <div ref={root}>{body}</div>;
}

/** Which request this address opens, read once per mount. */
function useEntry(): ApprovalEntry {
  const { pathname } = useLocation();
  const [arrival] = useState(() => {
    // An in-app navigation (a hosted row) never passed through boot: read
    // it here, the same way, before anything is called.
    captureApprovalArrivalFromPage();
    return peekApprovalArrival();
  });
  return approvalEntry(arrival, pathname);
}

export function ApproveScreen() {
  const online = useOnline();
  const configured = useIdentityConfigured();
  const session = useIdentitySession();
  const entry = useEntry();
  const ready = configured && session !== null;
  let body = null;
  if (entry.kind === "ended")
    body = (
      <Ended
        ending={{
          kind: "ended",
          title: APPROVAL_LINK_ENDED,
          words: entry.words,
        }}
      />
    );
  else if (ready) body = <Review ceremonyRef={entry.ref} />;
  else
    body = (
      <ConnectIdentityNote online={online} what="the requests sent to you" />
    );
  return (
    <div className="section__inner">
      <div className="section__head">
        <h1>
          {APPROVAL_LABELS.title}
          {configured && !ready && entry.kind === "review" ? (
            <>
              {" "}
              <StatusMark tone="warn" label={APPROVAL_SIGN_IN} />
            </>
          ) : null}
        </h1>
      </div>
      {body}
    </div>
  );
}
