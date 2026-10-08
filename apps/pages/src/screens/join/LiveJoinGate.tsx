/**
 * The door's road into somebody else's live session (ADR 0150 §1, §7).
 *
 * Joining connects this browser to the owner's — directly by default — once
 * the pairing codes have crossed, by hand or over a carrier the link names.
 * That is the `sharing.live`
 * capability, and an optional capability never loads before consent
 * (ADR 0130). So the road opens on the same review Settings shows: what
 * switching Live sessions on adds, the peer connection among it. Apply is
 * the consent, committed with its receipt like any other switch, and the
 * join screen — the capability's own route — opens next. Where the
 * capability is already on, the road goes straight there.
 *
 * The link, if the address bar carried one, waits in memory for that screen.
 */

import {
  type FeatureProposal,
  featureById,
  switchCapability,
} from "@opensesame/app-core/lib/capabilities/features.js";
import { capabilityPorts } from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
import {
  type LiveLink,
  holdLiveLink,
} from "@opensesame/app-core/lib/live/link.js";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useComposition } from "../../bindings/capabilities.js";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconX } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { Wordmark } from "../../components/Wordmark.js";
import {
  commitProposal,
  currentRoots,
  selectionFor,
} from "../../sections/settings/useCapabilityChange.js";
import { useSupportRoute } from "../../tutorial/session.js";
import { CapabilityReview } from "../capabilities/CapabilityReview.js";
import "../setup.css";

export const LIVE = "sharing.live";
export const LIVE_PATH = "/live";

const NOT_ALLOWED = "Live sessions are not allowed on this installation";

/**
 * What the gate reads and calls beside the capability store: the composition
 * hook, the support route, the switch's proposal and its review, the commit,
 * and the review sheet itself.
 */
export const liveJoinGateSeams = {
  holdLiveLink,
  useComposition,
  useSupportRoute,
  proposalFor: (snapshot: ReturnType<typeof useComposition>) =>
    switchCapability(
      {
        roots: currentRoots(snapshot.selection),
        alternatives: snapshot.selection?.chosenAlternatives ?? {},
      },
      featureById("sharing"),
      LIVE,
      true,
      snapshot.plan,
      capabilityPorts.CAPABILITY_CATALOG,
    ),
  reviewFor: (
    snapshot: ReturnType<typeof useComposition>,
    proposal: FeatureProposal,
  ) =>
    capabilityPorts.compositionStore.review(selectionFor(snapshot, proposal)),
  commitProposal,
  Review: CapabilityReview,
};

/** The commit that did not land, and an installation that refuses: each its own notice. */
function CommitFailure({
  notice,
  notAllowed,
}: {
  notice: string | null;
  notAllowed: boolean;
}) {
  return (
    <>
      {notice ? <StatusMark tone="err" label={notice} /> : null}
      <FailureNotice
        id="join:live-not-allowed"
        title="Live sessions"
        message={notAllowed ? NOT_ALLOWED : null}
      />
      <FailureNotice
        id="join:live-commit"
        title="Live sessions"
        message={notice}
      />
    </>
  );
}

export function LiveJoinGate({
  link,
  onClose,
}: {
  /** A live link the address bar carried, already taken out of it. */
  link: LiveLink | null;
  onClose: () => void;
}) {
  liveJoinGateSeams.useSupportRoute("/unlock");
  const navigate = useNavigate();
  const snapshot = liveJoinGateSeams.useComposition();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const state = snapshot.plan?.capabilities[LIVE];
  const approved = state?.approved === true;
  const allowed = state?.distributed === true && state.permitted;
  const notAllowed = snapshot.plan !== null && !allowed && !approved;

  // Keep the link in memory across consent and navigation (ADR 0150).
  useEffect(() => {
    if (link) liveJoinGateSeams.holdLiveLink(link);
  }, [link]);

  // Already on: straight to the join screen, with the link.
  useEffect(() => {
    if (!approved) return;
    liveJoinGateSeams.holdLiveLink(link);
    navigate(LIVE_PATH);
  }, [approved, link, navigate]);

  const proposal = liveJoinGateSeams.proposalFor(snapshot);
  const review =
    approved || !allowed
      ? null
      : liveJoinGateSeams.reviewFor(snapshot, proposal);

  async function accept(): Promise<void> {
    setBusy(true);
    try {
      const outcome = await liveJoinGateSeams.commitProposal(
        snapshot,
        proposal,
      );
      setNotice(outcome);
      if (!outcome && link) liveJoinGateSeams.holdLiveLink(link);
      // The approved plan brings the route; the effect above then opens it.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="setup join">
      <div className="setup__frame">
        <div className="setup__bar">
          <Wordmark className="setup__wordmark" />
          <button
            type="button"
            className="icon-btn setup__back"
            aria-label="Close"
            title="Close"
            disabled={busy}
            onClick={onClose}
          >
            <IconX size={18} />
          </button>
        </div>
        <main className="setup__body" id="main">
          <div className="setup__head">
            <h1>Join a session</h1>
          </div>
          <div className="setup__stack">
            {review ? (
              <liveJoinGateSeams.Review
                review={review}
                catalog={capabilityPorts.CAPABILITY_CATALOG}
                alternativesFor={() => []}
                busy={busy}
                onApply={() => void accept()}
                onCancel={onClose}
                onReplace={() => {}}
              />
            ) : notAllowed ? (
              <StatusMark tone="err" label={NOT_ALLOWED} />
            ) : (
              <StatusMark tone="idle" label="Opening…" />
            )}
            <CommitFailure notice={notice} notAllowed={notAllowed} />
          </div>
        </main>
      </div>
    </div>
  );
}
