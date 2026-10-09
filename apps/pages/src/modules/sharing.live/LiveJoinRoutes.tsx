/**
 * What the joiner's browser would contact for a link that names routes
 * (ADR 0150 §6), shown before anything is contacted: the owner's STUN or
 * TURN servers and the carriers that pass the codes. The person keeps them
 * or pairs directly by hand; and, once asked, where each carrier stands.
 */

import type { Rendezvous } from "@opensesame/app-core/lib/live/rendezvous.js";
import type { CarrierState } from "@opensesame/app-core/lib/live/rendezvous.js";
import {
  type LiveRoutes,
  hasRoutes,
  routeHosts,
} from "@opensesame/app-core/lib/live/transport.js";
import { useEffect, useState } from "react";
import { StatusMark } from "../../components/StatusMark.js";
import { type Standing, standingMark } from "./live-hooks.js";

export function RoutesChoice({
  routes,
  checked,
  disabled,
  onChange,
}: {
  routes: LiveRoutes;
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  if (!hasRoutes(routes)) return null;
  return (
    <label className="join__choice">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>Through {routeHosts(routes).join(", ")}</span>
    </label>
  );
}

/** A carrier's glyph and sentence. */
export function carrierStanding(state: CarrierState): Standing {
  const where =
    state.spec.kind === "broadcast"
      ? "this browser"
      : new URL(state.spec.url).host;
  const name = `${where} (${state.spec.kind})`;
  // The installation said no before anything was contacted: not a fault of
  // the server, so not "Unreachable".
  if (state.status === "blocked")
    return standingMark("warn", `Blocked by this installation: ${where}`);
  if (state.status === "ready")
    return standingMark("ok", `Carrying codes: ${name}`);
  if (state.status === "failed")
    return standingMark("err", `Unreachable: ${name}`);
  return standingMark("idle", `Connecting: ${name}`);
}

/** Where each carrier stands, while it has codes to carry. */
export function CarrierMarks({
  rendezvous,
}: { rendezvous: Rendezvous | null }) {
  const [states, setStates] = useState<readonly CarrierState[]>(
    () => rendezvous?.states ?? [],
  );
  useEffect(() => rendezvous?.subscribe(setStates), [rendezvous]);
  if (!rendezvous || states.length === 0) return null;
  return (
    <div className="live-carriers">
      {states.map((state) => {
        const mark = carrierStanding(state);
        return (
          <StatusMark
            key={`${state.spec.kind} ${state.spec.url}`}
            tone={mark.tone}
            label={mark.label}
          />
        );
      })}
    </div>
  );
}
