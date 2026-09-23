/**
 * Settings › Capabilities — what this device uses (the member view).
 *
 * One row per catalog capability with its lifecycle as a glyph and a short
 * label, and two actions: Disable now (the store's emergency disable, in
 * memory first) and Retire safely (a reviewed commit with the root removed).
 * A capability that was already evaluated in this realm reads "restart
 * required" until the document reloads. Visual, Source and Effective are
 * three views of the same documents; Source commits through the S04
 * adapter, Effective is read-only. Policy editing lives in
 * `InstanceCapabilitiesPanel`, which a member of a managed instance never
 * sees (SURFACE-06).
 */

import { effectivePlanToYaml } from "@opensesame/app-core/lib/configuration/capabilities-document.js";
import {
  CAPABILITY_CATALOG,
  buildConsentReceipt,
  compositionStore,
  previewPlan,
  viewOutcome,
} from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
import type { CapabilityId } from "@opensesame/capability-composition";
import { useState } from "react";
import {
  IconPlus,
  IconRefresh,
  IconTrash,
  IconX,
} from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useVault } from "../../lib/vault/hooks.js";
import {
  alternativesFor,
  baseFromSnapshot,
  draftFromSelection,
  draftToSelection,
  toggleRoot,
} from "../../screens/capabilities/CapabilityDraft.js";
import { CapabilityReview } from "../../screens/capabilities/CapabilityReview.js";
import { capabilityStatus } from "../../screens/capabilities/status.js";
import {
  CapabilitiesViewToggle,
  CapabilitySourceView,
  type CapabilityView,
} from "./CapabilitiesPanelViews.js";
import { InstanceCapabilitiesPanel } from "./InstanceCapabilitiesPanel.js";
import "./capabilities.css";

import { useComposition } from "../../bindings/capabilities.js";
export const capabilitiesPanelSeams = {
  reload: () => window.location.reload(),
  now: () => new Date().toISOString(),
};

/**
 * One row per catalog capability, with the actions that row actually has.
 *
 * A running optional capability can be disabled now or retired safely. One
 * this installation has not taken can be added, which is the same toggle
 * read the other way: before this, a capability could be chosen once — in
 * the setup ceremony, which lives before sign-in — and afterwards only ever
 * narrowed, so a person who signed in and then wanted drops had no road
 * back. Adding goes through the same review and the same receipt; a
 * capability the distribution does not carry, or policy does not permit,
 * offers nothing rather than a disabled key.
 */
function Rows({ onToggle }: { onToggle: (id: CapabilityId) => void }) {
  const snapshot = useComposition();
  return (
    <ul className="capspanel" aria-label="What this device uses">
      {CAPABILITY_CATALOG.capabilities.map((descriptor) => {
        const state = snapshot.plan?.capabilities[descriptor.id];
        const status = capabilityStatus(
          state,
          snapshot.lifecycle[descriptor.id],
        );
        const optional = descriptor.tier === "optional";
        const running = Boolean(state?.approved) && optional;
        const addable =
          optional &&
          !running &&
          state !== undefined &&
          state.permitted &&
          state.distributed;
        return (
          <li key={descriptor.id} className="capspanel__row">
            <span className="capspanel__name">
              <strong>{descriptor.title}</strong>
              <span>{status.label}</span>
            </span>
            <span className="capspanel__side">
              <StatusMark tone={status.tone} label={status.label} />
              {running ? (
                <>
                  <button
                    type="button"
                    className="icon-btn icon-btn--sm icon-btn--danger"
                    aria-label={`Disable ${descriptor.title} now`}
                    title={`Disable ${descriptor.title} now`}
                    onClick={() =>
                      void compositionStore.emergencyDisable(descriptor.id)
                    }
                  >
                    <IconX size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn icon-btn--sm"
                    aria-label={`Retire ${descriptor.title} safely`}
                    title={`Retire ${descriptor.title} safely`}
                    onClick={() => onToggle(descriptor.id)}
                  >
                    <IconTrash size={14} />
                  </button>
                </>
              ) : null}
              {addable ? (
                <button
                  type="button"
                  className="icon-btn icon-btn--sm"
                  aria-label={`Add ${descriptor.title}`}
                  title={`Add ${descriptor.title}`}
                  onClick={() => onToggle(descriptor.id)}
                >
                  <IconPlus size={14} />
                </button>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function RestartNotice() {
  const snapshot = useComposition();
  const pending = Object.values(snapshot.plan?.capabilities ?? {}).some(
    (state) => state.restartRequired,
  );
  if (!pending) return null;
  return (
    <p className="capspanel__notice" data-testid="capabilities-restart">
      <StatusMark tone="warn" label="restart required" />
      <span>reload to finish unloading</span>
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label="Reload now"
        title="Reload now"
        onClick={() => capabilitiesPanelSeams.reload()}
      >
        <IconRefresh size={14} />
      </button>
    </p>
  );
}

export function CapabilitiesPanel() {
  const snapshot = useComposition();
  const { tomb } = useVault();
  const [view, setView] = useState<CapabilityView>("visual");
  const [pending, setPending] = useState<CapabilityId | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const selectionFor = (id: CapabilityId) =>
    draftToSelection(
      toggleRoot(
        {
          ...draftFromSelection(snapshot.selection, "customize"),
          roots: snapshot.selection?.selectedOptional ?? [],
        },
        id,
      ),
      baseFromSnapshot(snapshot, capabilitiesPanelSeams.now()),
    );
  const review = pending
    ? compositionStore.review(selectionFor(pending))
    : null;
  /** Commit the one root the row toggled — added or removed, same ceremony. */
  async function applyToggle() {
    if (!pending) return;
    setBusy(true);
    try {
      const selection = selectionFor(pending);
      const plan = previewPlan(selection);
      const receipt = buildConsentReceipt(
        plan,
        CAPABILITY_CATALOG,
        capabilitiesPanelSeams.now(),
      );
      const outcome = viewOutcome(
        await compositionStore.commit(selection, receipt),
        snapshot.durability,
      );
      setNotice(
        outcome.status === "durable" || outcome.status === "session-only"
          ? null
          : `${outcome.status} · ${outcome.message}`,
      );
    } finally {
      setBusy(false);
      setPending(null);
    }
  }
  return (
    <section className="panel" data-testid="capabilities-panel">
      <div className="panel__head capspanel__head">
        <h2>Capabilities</h2>
        <CapabilitiesViewToggle view={view} onChange={setView} />
      </div>
      <div className="panel__body capspanel">
        <RestartNotice />
        {notice ? (
          <p className="capspanel__notice">
            <StatusMark tone="err" label={notice} />
            <span>{notice}</span>
          </p>
        ) : null}
        {view === "visual" && !review ? <Rows onToggle={setPending} /> : null}
        {view === "visual" && review ? (
          <CapabilityReview
            review={review}
            catalog={CAPABILITY_CATALOG}
            alternativesFor={(root) =>
              alternativesFor(root, CAPABILITY_CATALOG, snapshot.plan)
            }
            busy={busy}
            onApply={() => void applyToggle()}
            onCancel={() => setPending(null)}
            onReplace={() => setPending(null)}
          />
        ) : null}
        {view === "source" ? (
          <CapabilitySourceView kind="installation-selection" tomb={tomb} />
        ) : null}
        {view === "effective" ? (
          <pre className="capspanel__source" aria-label="Effective plan">
            {snapshot.plan ? effectivePlanToYaml(snapshot.plan) : ""}
          </pre>
        ) : null}
      </div>
      <InstanceCapabilitiesPanel />
    </section>
  );
}
