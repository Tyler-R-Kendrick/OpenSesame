/**
 * One status per capability, as a glyph tone and a short label (P-TRUTH).
 *
 * Each claim is its own: deselected, prohibited by operator, unavailable in
 * this distribution, unsupported by this browser, consent required, active,
 * restart required. None implies another, and a preview never reads as
 * applied. The ladder is read in three passes — what this installation can
 * even run, what the draft is previewing, and what is running now — so no
 * single test collapses two different truths.
 */

import type {
  CapabilityLifecycle,
  CapabilityState,
} from "@opensesame/capability-composition";
import type { StatusTone } from "../../components/StatusMark.js";

export type CapabilityStatus = Readonly<{ tone: StatusTone; label: string }>;

/** Nothing this installation cannot run gets past here. */
function availability(state: CapabilityState): CapabilityStatus | null {
  if (state.tier === "core") {
    // Always on is the default; an operator may still withdraw it (ADR 0138).
    return state.approved
      ? { tone: "ok", label: "always on" }
      : { tone: "err", label: "withdrawn by operator" };
  }
  if (!state.distributed) {
    return { tone: "idle", label: "unavailable in this distribution" };
  }
  if (state.reasons.includes("PROHIBITED_BY_INSTANCE")) {
    return { tone: "err", label: "prohibited by operator" };
  }
  if (state.reasons.includes("NOT_PERMITTED_BY_INSTANCE")) {
    return { tone: "idle", label: "not permitted by operator" };
  }
  if (!state.runtimeSupported) {
    return { tone: "warn", label: "unsupported by this browser" };
  }
  return null;
}

/** A draft is a preview: it may never read as though it had been applied. */
function preview(
  state: CapabilityState,
  previewSelected: boolean | null,
): CapabilityStatus | null {
  if (previewSelected === true && !state.approved) {
    return { tone: "warn", label: "selected · not yet applied" };
  }
  if (previewSelected === false && state.approved) {
    return { tone: "warn", label: "deselected · not yet applied" };
  }
  return null;
}

function standing(
  state: CapabilityState,
  lifecycle: CapabilityLifecycle | undefined,
): CapabilityStatus {
  if (state.reasons.includes("DEPENDENCY_CONFLICT")) {
    return { tone: "err", label: "conflict" };
  }
  if (state.reasons.includes("REQUIRED_NOT_ACCEPTED")) {
    return { tone: "warn", label: "acceptance required" };
  }
  if (lifecycle === "active") return { tone: "ok", label: "active" };
  if (lifecycle === "loading") return { tone: "ok", label: "starting" };
  if (state.approved) return { tone: "ok", label: "approved" };
  if (
    state.reasons.includes("CONSENT_REQUIRED") ||
    lifecycle === "consent-required"
  ) {
    return { tone: "warn", label: "consent required" };
  }
  if (lifecycle === "disabled") return { tone: "idle", label: "disabled" };
  return { tone: "idle", label: "deselected" };
}

export function capabilityStatus(
  state: CapabilityState | null | undefined,
  lifecycle: CapabilityLifecycle | undefined,
  previewSelected: boolean | null = null,
): CapabilityStatus {
  if (!state) return { tone: "idle", label: "unknown to this catalog" };
  const unavailable = availability(state);
  if (unavailable) return unavailable;
  if (state.restartRequired || lifecycle === "disabled-restart-required") {
    return { tone: "warn", label: "restart required" };
  }
  return preview(state, previewSelected) ?? standing(state, lifecycle);
}
