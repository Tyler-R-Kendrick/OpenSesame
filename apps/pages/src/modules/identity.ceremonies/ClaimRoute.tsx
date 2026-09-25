/**
 * `/claim` (ADR 0140 plan step 8): the one route a claim link opens, and a
 * dispatcher. `#token=osc_clm_…` is an ownership claim, reviewed and accepted
 * here over `createClaimCeremony`; `#token=…&key=…` is a drop, opened by
 * whatever `sharing.drops` handed over; a bearer in the query string is
 * refused. The link left the address before the first paint
 * (`app-core/lib/claims/arrival.ts`, run by `bootCore`); this screen takes
 * what arrived from memory.
 *
 * Drops are optional. This module never imports their code: the opener is a
 * `claim-opener` contribution, registered only by an approved `sharing.drops`
 * module that the loader brought in under the current lease. On an
 * installation without drops the route says so, in the tray, and loads
 * nothing.
 *
 * Behind unlock like `/device`: the tray a failure is reported in lives in
 * the shell, and a locked device shows its sign-in and guest roads first.
 */

import { useComposition } from "../../bindings/capabilities.js";
import { useContributions } from "../../bindings/contributions.js";

import {
  captureClaimArrivalFromPage,
  markClaimShown,
  peekClaimArrival,
  takeClaimArrival,
} from "@opensesame/app-core/lib/claims/arrival.js";
import { CLAIM_WORDS } from "@opensesame/app-core/lib/claims/ceremony.js";
import type { ClaimArrival } from "@opensesame/app-core/lib/claims/link.js";
import {
  DROPS_UNAVAILABLE,
  claimEntry,
  clearClaimNotice,
  reportDropsUnavailable,
} from "@opensesame/app-core/lib/claims/route-model.js";
import { type RefObject, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { StatusMark } from "../../components/StatusMark.js";
import { firstControl, keyboardIsIdle, landFocus } from "../../lib/focus.js";
import { useOnline } from "../../lib/use-online.js";
import { ConnectIdentityNote } from "../../sections/identity/ConnectIdentityNote.js";
import {
  ClaimDone,
  ClaimEntry,
  ClaimPaused,
  ClaimReviewForm,
} from "./ClaimSteps.js";
import { useClaimCeremony } from "./useClaimCeremony.js";

const DROPS = "sharing.drops";

/** Whether this plan approves drops; `null` while no plan is resolved. */
function useDropsApprovedDefault(): boolean | null {
  const { plan } = useComposition();
  return plan === null ? null : plan.approvedCapabilities.includes(DROPS);
}

export const claimRouteSeams = { useDropsApproved: useDropsApprovedDefault };

/** A drop: the opener `sharing.drops` registered, or why there is none. */
function DropDispatch({
  token,
  fragmentKey,
}: {
  token: string;
  fragmentKey: string;
}) {
  const approved = claimRouteSeams.useDropsApproved();
  const opener = useContributions("claim-opener").find(
    (entry) => entry.link === "drop",
  );
  // Approved, the opener arrives with the module; until then, nothing.
  const unavailable = !opener && approved === false;

  // Said in the tray, and nothing loaded. The link stays in memory only —
  // never stored — until a lock or sign-out, so a plan that approves Drops
  // later in this sitting (an unlock re-resolves it; so does switching
  // Sharing on) still opens it, and takes the notice down.
  useEffect(() => {
    if (unavailable) reportDropsUnavailable();
    else if (opener) clearClaimNotice();
  }, [unavailable, opener]);

  if (opener) {
    const { Opener } = opener;
    return (
      <Opener
        token={token}
        fragmentKey={fragmentKey}
        onSettled={() => takeClaimArrival()}
      />
    );
  }
  if (!unavailable) return null;
  return (
    <section className="panel" aria-label="Drop not opened">
      <div className="panel__head">
        <h2>
          Drop not opened <StatusMark tone="warn" label={DROPS_UNAVAILABLE} />
        </h2>
      </div>
    </section>
  );
}

/** An ownership claim, step by step; with nothing arrived, a place to paste. */
function ClaimFlow({
  arrival,
  onArrival,
  root,
}: {
  arrival: ClaimArrival;
  onArrival: (next: ClaimArrival) => void;
  root: RefObject<HTMLDivElement | null>;
}) {
  const online = useOnline();
  const view = useClaimCeremony(arrival);
  const { step, tone, busy } = view;
  const said = { tone, words: step.message };
  const { phase } = step;

  // A step that arrives after a load replaces the one that held the focus;
  // when nothing holds it now, it lands on the new step's first key.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new step is the trigger
  useEffect(() => {
    if (keyboardIsIdle()) landFocus(firstControl(root.current));
  }, [phase.kind, busy]);

  if (busy && phase.kind === "token") return null;

  if (phase.kind === "open") {
    return (
      <ClaimReviewForm
        open={phase}
        said={said}
        busy={busy}
        online={online}
        onComplete={view.complete}
      />
    );
  }
  if (phase.kind === "done") return <ClaimDone />;
  if (phase.kind === "paused") {
    return (
      <>
        <ClaimPaused
          step={step}
          tone={tone}
          busy={busy}
          onRetry={view.retry}
          onGuest={view.guest}
        />
        {phase.reason === "identity" ? (
          <ConnectIdentityNote
            online={online}
            what="the claims shared with you"
          />
        ) : null}
      </>
    );
  }
  return (
    <ClaimEntry
      said={said}
      busy={busy}
      onEntry={(raw) => {
        const entry = claimEntry(raw);
        if (entry === null) return;
        if (entry.kind === "none") view.say(CLAIM_WORDS.notAToken);
        else onArrival(entry);
      }}
    />
  );
}

export function ClaimRoute() {
  const location = useLocation();
  const navigate = useNavigate();
  const root = useRef<HTMLDivElement | null>(null);
  // An in-app navigation to `/claim#token=…` never passed through boot: read
  // it here, the same way. What boot took waits in memory until spent.
  const [arrival, setArrival] = useState<ClaimArrival>(() => {
    captureClaimArrivalFromPage();
    return peekClaimArrival();
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, on arrival
  useEffect(() => {
    markClaimShown();
    if (location.search || location.hash) {
      navigate(location.pathname, { replace: true });
    }
  }, []);

  const drop = arrival.kind === "drop" ? arrival : null;
  return (
    <div className="section__inner" ref={root}>
      <div className="section__head">
        <h1>{drop ? "Open a drop" : "Accept a claim"}</h1>
      </div>
      {drop ? (
        <DropDispatch token={drop.token} fragmentKey={drop.key} />
      ) : (
        <ClaimFlow arrival={arrival} onArrival={setArrival} root={root} />
      )}
    </div>
  );
}
