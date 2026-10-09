/**
 * `/claim`: the recipient's side of a secret-drop link (ADR 0140 D2).
 *
 * A drop arrives as `#token=…&key=…` (token stays URL plumbing — scrubbed
 * before first paint by `bootCore` / `captureClaimArrivalFromPage`). This
 * route opens the drop receive view. Ownership-claim paste and "Accept a
 * claim" are not a product surface: incomplete or non-drop arrivals refuse
 * in the tray and show only the open-drop shell.
 *
 * Always-on (`gate: "any"`): works on a locked or empty device. Only
 * *sending* a drop is `sharing.drops`.
 */

import {
  captureClaimArrivalFromPage,
  peekClaimArrival,
  takeClaimArrival,
} from "@opensesame/app-core/lib/claims/arrival.js";
import type { ClaimArrival } from "@opensesame/app-core/lib/claims/link.js";
import {
  clearClaimNotice,
  reportClaim,
} from "@opensesame/app-core/lib/claims/route-model.js";
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { StatusMark } from "../../components/StatusMark.js";

const DropClaimScreen = lazy(() =>
  import("./DropClaimScreen.js").then((m) => ({ default: m.DropClaimScreen })),
);

const TITLE = "Open a drop";
/** Incomplete drop / non-drop arrival — never "claim" wording. */
const DROP_INCOMPLETE = "This drop link is incomplete.";
const DROP_LEAKED =
  "This drop link carried its token where it may have been logged, so it was not used. Ask for a fresh drop link.";

function refuseNonDrop(arrival: ClaimArrival): string | null {
  if (arrival.kind === "drop") return null;
  if (arrival.kind === "leaked") return DROP_LEAKED;
  if (arrival.kind === "claim") return DROP_INCOMPLETE;
  return null;
}

/** Refused arrival: open-drop shell with a mark; no paste field, no claim copy. */
function DropReceiveIdle({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <section className="panel" aria-label={TITLE}>
      <div className="panel__body">
        <StatusMark tone="err" label={message} />
      </div>
    </section>
  );
}

export function ClaimRoute() {
  const location = useLocation();
  const navigate = useNavigate();
  const root = useRef<HTMLDivElement | null>(null);
  const [arrival, setArrival] = useState<ClaimArrival>(() => {
    captureClaimArrivalFromPage();
    return peekClaimArrival();
  });
  const [refusal, setRefusal] = useState<string | null>(() =>
    refuseNonDrop(peekClaimArrival()),
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, on arrival
  useEffect(() => {
    if (location.search || location.hash) {
      navigate(location.pathname, { replace: true });
    }
  }, []);

  const drop = arrival.kind === "drop" ? arrival : null;

  useEffect(() => {
    if (drop) {
      clearClaimNotice();
      setRefusal(null);
      return;
    }
    const words = refuseNonDrop(arrival);
    if (!words) return;
    setRefusal(words);
    reportClaim(words, TITLE);
    if (arrival.kind === "leaked" || arrival.kind === "claim") {
      takeClaimArrival();
      setArrival({ kind: "none" });
    }
  }, [drop, arrival]);

  return (
    <div className="section__inner" ref={root}>
      <div className="section__head">
        <h1>{TITLE}</h1>
      </div>
      {drop ? (
        <Suspense fallback={null}>
          <DropClaimScreen
            token={drop.token}
            fragmentKey={drop.key}
            onSettled={() => takeClaimArrival()}
          />
        </Suspense>
      ) : (
        <DropReceiveIdle message={refusal} />
      )}
    </div>
  );
}
