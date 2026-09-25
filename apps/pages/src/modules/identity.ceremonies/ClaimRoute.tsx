/**
 * `/claim` (ADR 0140 plan step 8): the one route a claim link opens, and a
 * dispatcher. `#token=osc_clm_…` is an ownership claim, reviewed and accepted
 * here over `createClaimCeremony`; `#token=…&key=…` is a drop, opened here
 * too (D2: the recipient's side is always-on — only *sending* a drop is
 * `sharing.drops`); a bearer in the query string is refused. The link left
 * the address before the first paint (`app-core/lib/claims/arrival.ts`, run
 * by `bootCore`); this screen takes what arrived from memory.
 *
 * It never touches the vault (ADR 0140 §2): `gate: "any"`, so on a locked or
 * empty device it opens by itself, with no unlock prompt, and needs only an
 * Identity session — the Connect note and the guest road are on the route.
 * The shell's notifications tray is not mounted there, so every refusal is
 * also the mark on the page, in the model's words.
 */

import {
  captureClaimArrivalFromPage,
  peekClaimArrival,
  takeClaimArrival,
} from "@opensesame/app-core/lib/claims/arrival.js";
import { CLAIM_WORDS } from "@opensesame/app-core/lib/claims/ceremony.js";
import type { ClaimArrival } from "@opensesame/app-core/lib/claims/link.js";
import { claimEntry } from "@opensesame/app-core/lib/claims/route-model.js";
import {
  type RefObject,
  Suspense,
  lazy,
  useEffect,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate } from "react-router";
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

// The drop opener and the decryption it runs arrive only when a drop does:
// a claim, a paste or a refusal never loads them.
const DropClaimScreen = lazy(() =>
  import("./DropClaimScreen.js").then((m) => ({ default: m.DropClaimScreen })),
);

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
  // when nothing holds it now — or only the page's own landmark, which the
  // frame focuses on arrival — it lands on the new step's first key.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new step is the trigger
  useEffect(() => {
    const onLandmark = document.activeElement === root.current?.closest("main");
    if (keyboardIsIdle() || onLandmark) landFocus(firstControl(root.current));
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
        <Suspense fallback={null}>
          <DropClaimScreen
            token={drop.token}
            fragmentKey={drop.key}
            onSettled={() => takeClaimArrival()}
          />
        </Suspense>
      ) : (
        <ClaimFlow arrival={arrival} onArrival={setArrival} root={root} />
      )}
    </div>
  );
}
