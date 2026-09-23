import type { FailureClass } from "./probe-failure.js";
/**
 * The five rows the Transport panel draws, from what the endpoint answered.
 *
 * `desired` is this device's own setting compared with what the endpoint
 * says it runs; credential, runtime, observed and enforcement are whatever
 * was reported, or idle when nothing has been asked. Enforcement is stale
 * the moment the generation moves on or `fresh_until` passes; an endpoint
 * that accepted a certificate but never refused a bare caller is an
 * observation, not enforcement (AT-EVIDENCE-POSITIVE, AT-EVIDENCE-STALE).
 */
import type {
  TransportPolicy,
  TransportStatusView,
} from "./transport-model.js";
import {
  type TransportStatusResult,
  transportStatusSeams,
} from "./transport-status.js";

export type TransportRowTone = "ok" | "warn" | "err" | "idle";

export type TransportRowId =
  | "desired"
  | "credential"
  | "runtime"
  | "observed"
  | "enforcement";

export type TransportRow = {
  id: TransportRowId;
  label: string;
  tone: TransportRowTone;
  /** The state as a sentence — the glyph's aria-label and title. */
  state: string;
  /** Facts beside it: target, generation, time, observer. Never prose. */
  facts: string;
};

export type TransportViewState = {
  target: string | null;
  stale: boolean;
  rows: TransportRow[];
};

const POLICY_LABEL: Record<TransportPolicy, string> = {
  existing_local: "existing local",
  server_tls: "server TLS",
  mtls_required: "mTLS required",
  trusted_ingress: "trusted ingress",
};

export function policyLabel(policy: TransportPolicy): string {
  return POLICY_LABEL[policy];
}

/** The endpoint's non-answer as a fact — a word, not a sentence about it. */
const FAILURE_FACT: Record<FailureClass, string> = {
  offline: "this device is offline",
  timeout: "timed out",
  unreachable: "no answer",
  rejected: "refused",
  "server-error": "server error",
  "not-opensesame": "not an authority endpoint",
};

function short(at: string): string {
  return at.replace(/\.\d+Z$/, "Z");
}

function idle(id: TransportRowId, label: string): TransportRow {
  return { id, label, tone: "idle", state: "Not checked", facts: "" };
}

/** True when the recorded enforcement no longer speaks for the running generation. */
export function enforcementIsStale(
  view: TransportStatusView,
  now: number,
): boolean {
  const e = view.enforcement;
  if (e.kind === "stale") return true;
  if (e.kind !== "verified") return false;
  if (Date.parse(e.fresh_until) <= now) return true;
  return (
    view.runtime.kind === "loaded" && view.runtime.generation !== e.generation
  );
}

function credentialRow(view: TransportStatusView): TransportRow {
  const c = view.credential;
  const label = "Credential";
  switch (c.kind) {
    case "configured":
      return {
        id: "credential",
        label,
        tone: "ok",
        state: "Configured",
        facts: `${c.source} · ${c.custody} · gen ${c.generation} · until ${short(c.not_after)}`,
      };
    case "expired":
      return {
        id: "credential",
        label,
        tone: "err",
        state: "Expired",
        facts: `gen ${c.generation}`,
      };
    case "revoked":
      return {
        id: "credential",
        label,
        tone: "err",
        state: "Revoked",
        facts: `gen ${c.generation}`,
      };
    case "external_provisioning_required":
      return {
        id: "credential",
        label,
        tone: "warn",
        state: "Provisioned outside",
        facts: "",
      };
    case "unsupported_in_browser":
      return {
        id: "credential",
        label,
        tone: "warn",
        state: "Not a browser capability",
        facts: "",
      };
    default:
      return {
        id: "credential",
        label,
        tone: "idle",
        state: "Unconfigured",
        facts: "",
      };
  }
}

function runtimeRow(view: TransportStatusView): TransportRow {
  const r = view.runtime;
  const label = "Runtime";
  if (r.kind === "loaded") {
    return {
      id: "runtime",
      label,
      tone: "ok",
      state: "Loaded",
      facts: `gen ${r.generation} · ${short(r.loaded_at)}`,
    };
  }
  if (r.kind === "reload_failed") {
    return {
      id: "runtime",
      label,
      tone: "err",
      state: "Reload did not apply",
      facts: `gen ${r.generation} · ${r.code}`,
    };
  }
  return { id: "runtime", label, tone: "idle", state: "Not loaded", facts: "" };
}

function observedRow(view: TransportStatusView): TransportRow {
  const o = view.observed;
  if (!o)
    return {
      id: "observed",
      label: "Observed",
      tone: "idle",
      state: "No authenticated peer seen",
      facts: "",
    };
  return {
    id: "observed",
    label: "Observed",
    tone: "ok",
    state: "Peer authenticated",
    facts: `${o.observer} → ${o.target} · gen ${o.generation} · ${short(o.at)}`,
  };
}

function enforcementRow(
  view: TransportStatusView,
  stale: boolean,
): TransportRow {
  const e = view.enforcement;
  const label = "Enforcement";
  if (e.kind === "stale") {
    return {
      id: "enforcement",
      label,
      tone: "warn",
      state: "Stale",
      facts: `verified gen ${e.generation} · now gen ${e.current_generation}`,
    };
  }
  if (e.kind !== "verified") {
    return {
      id: "enforcement",
      label,
      tone: "idle",
      state: "Unverified",
      facts: "",
    };
  }
  const facts = `${e.target} · gen ${e.generation} · ${short(e.at)} · fresh until ${short(e.fresh_until)}`;
  if (stale)
    return { id: "enforcement", label, tone: "warn", state: "Stale", facts };
  if (e.accepted_with_certificate && e.rejected_without_certificate) {
    return {
      id: "enforcement",
      label,
      tone: "ok",
      state: "Verified: certificate required",
      facts,
    };
  }
  // Accepted with a certificate but not refused without one: an observation,
  // never enforcement (AT-EVIDENCE-POSITIVE).
  return {
    id: "enforcement",
    label,
    tone: "warn",
    state: "Accepted, not required",
    facts,
  };
}

/**
 * The rows the panel draws. `desired` comes from this device's own setting
 * and is compared with what the endpoint says it runs; the other four are
 * whatever the endpoint reported, or idle when nothing has been asked.
 */
export function toTransportViewState(
  result: TransportStatusResult | null,
  desired: TransportPolicy,
  now: number = transportStatusSeams.now(),
): TransportViewState {
  const desiredRow: TransportRow = {
    id: "desired",
    label: "Desired",
    tone: "idle",
    state: "Desired on this device",
    facts: policyLabel(desired),
  };
  if (!result || result.kind === "unconfigured") {
    return {
      target: null,
      stale: false,
      rows: [
        desiredRow,
        idle("credential", "Credential"),
        idle("runtime", "Runtime"),
        idle("observed", "Observed"),
        idle("enforcement", "Enforcement"),
      ],
    };
  }
  if (result.kind !== "view") {
    const state =
      result.kind === "unauthorized"
        ? "Not authorized to read status"
        : result.kind === "malformed"
          ? "Answer not understood"
          : "Endpoint did not answer";
    const tone: TransportRowTone = result.kind === "degraded" ? "err" : "warn";
    const facts =
      result.kind === "degraded" ? FAILURE_FACT[result.failure] : "";
    return {
      target: null,
      stale: false,
      rows: [
        desiredRow,
        idle("credential", "Credential"),
        idle("runtime", "Runtime"),
        { id: "observed", label: "Observed", tone, state, facts },
        idle("enforcement", "Enforcement"),
      ],
    };
  }
  const { view } = result;
  const stale = enforcementIsStale(view, now);
  const matches = view.desired === desired;
  return {
    target: view.target,
    stale,
    rows: [
      {
        ...desiredRow,
        tone: matches ? "ok" : "warn",
        state: matches
          ? "Endpoint runs the desired policy"
          : "Endpoint policy differs from desired",
        facts: `${policyLabel(desired)} · endpoint ${policyLabel(view.desired)}`,
      },
      credentialRow(view),
      runtimeRow(view),
      observedRow(view),
      enforcementRow(view, stale),
    ],
  };
}
