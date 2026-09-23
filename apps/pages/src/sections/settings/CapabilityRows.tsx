/**
 * Settings › Capabilities › Advanced — one row per optional capability.
 *
 * The granular view an operator reaches for: each optional capability with
 * its lifecycle as a glyph and a short label, and the actions that row
 * actually has. A running one can be disabled now (the store's emergency
 * disable, in memory first) or retired safely (a reviewed commit with the
 * root removed); one this installation has not taken can be added through
 * the same review. A capability the distribution does not carry, or policy
 * does not permit, offers nothing rather than a disabled key. Always-on
 * capabilities are not listed: nothing about them can change.
 */

import type { FeatureProposal } from "@opensesame/app-core/lib/capabilities/features.js";
import {
  CAPABILITY_CATALOG,
  compositionStore,
} from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
import type { CapabilityId } from "@opensesame/capability-composition";
import { useComposition } from "../../bindings/capabilities.js";
import { IconPlus, IconTrash, IconX } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { capabilityStatus } from "../../screens/capabilities/status.js";

export function CapabilityRows({
  current,
  onPropose,
}: {
  current: FeatureProposal;
  onPropose: (proposal: FeatureProposal) => void;
}) {
  const snapshot = useComposition();
  const { roots } = current;
  const toggle = (id: CapabilityId) =>
    onPropose({
      ...current,
      roots: roots.includes(id)
        ? roots.filter((root) => root !== id)
        : [...roots, id],
    });
  return (
    <ul className="capspanel" aria-label="Optional capabilities">
      {CAPABILITY_CATALOG.capabilities
        .filter((descriptor) => descriptor.tier === "optional")
        .map((descriptor) => {
          const state = snapshot.plan?.capabilities[descriptor.id];
          const status = capabilityStatus(
            state,
            snapshot.lifecycle[descriptor.id],
          );
          const running = Boolean(state?.approved);
          const addable =
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
                      onClick={() => toggle(descriptor.id)}
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
                    onClick={() => toggle(descriptor.id)}
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
