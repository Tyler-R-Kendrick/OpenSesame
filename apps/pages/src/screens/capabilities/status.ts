/**
 * One status per capability, as a glyph tone and a short label (P-TRUTH).
 *
 * Each claim is its own: deselected, prohibited by operator, unavailable in
 * this distribution, unsupported by this browser, consent required, active,
 * restart required. None implies another, and a preview never reads as
 * applied.
 */

import type {
  CapabilityLifecycle,
  CapabilityState,
} from "@opensesame/capability-composition";
import type { StatusTone } from "../../components/StatusMark.js";

export type CapabilityStatus = Readonly<{ tone: StatusTone; label: string }>;

export function capabilityStatus(
  state: CapabilityState | null | undefined,
  lifecycle: CapabilityLifecycle | undefined,
  previewSelected: boolean | null = null,
): CapabilityStatus {
  if (!state) return { tone: "idle", label: "unknown to this catalog" };
  if (state.tier === "core") return { tone: "ok", label: "always on" };
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
  if (state.restartRequired || lifecycle === "disabled-restart-required") {
    return { tone: "warn", label: "restart required" };
  }
  if (previewSelected === true && !state.approved) {
    return { tone: "warn", label: "selected · not yet applied" };
  }
  if (previewSelected === false && state.approved) {
    return { tone: "warn", label: "deselected · not yet applied" };
  }
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
