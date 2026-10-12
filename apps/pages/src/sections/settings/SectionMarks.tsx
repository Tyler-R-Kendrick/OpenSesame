/**
 * What Settings › Features and Settings › Integrations both say about a
 * section: a capability's catalog title, and the mark for an always-on
 * capability an operator withdrew (ADR 0142).
 */

import { capabilityPorts } from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
import type { CapabilityId } from "@opensesame/capability-composition";
import { useComposition } from "../../bindings/capabilities.js";
import { StatusMark } from "../../components/StatusMark.js";

export function titleOf(id: CapabilityId): string {
  return (
    capabilityPorts.CAPABILITY_CATALOG.capabilities.find(
      (entry) => entry.id === id,
    )?.title ?? id
  );
}

/**
 * An always-on capability behind a section that an operator withdrew, or one
 * that needs a capability that was. Named on the section it backs rather than
 * drawn as though it ran.
 */
export function WithdrawnMark({
  backedBy,
}: {
  backedBy: readonly CapabilityId[] | undefined;
}) {
  const { plan } = useComposition();
  const withdrawn = (backedBy ?? []).filter((id) => {
    const state = plan?.capabilities[id];
    return state?.tier === "core" && !state.approved;
  });
  if (withdrawn.length === 0) return null;
  const label = `withdrawn by operator: ${withdrawn.map(titleOf).join(", ")}`;
  return <StatusMark tone="err" label={label} />;
}
