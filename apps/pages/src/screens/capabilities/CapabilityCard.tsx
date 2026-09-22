/**
 * One capability, from its descriptor and nothing else (CONSENT-01).
 *
 * The card names what it does, which UI it adds, what it pulls in, whether
 * it sends anything off the device, where it runs, what it may ask the
 * browser for, whether it needs a service, what stops offline, and whether
 * this distribution even contains it. Opening it imports nothing, connects
 * to nothing and asks for nothing — every fact is data already in hand.
 */

import type {
  CapabilityDescriptor,
  CapabilityId,
  CapabilityLifecycle,
  CapabilityState,
  EgressDeclaration,
} from "@opensesame/capability-composition";
import { useId, useState } from "react";
import { IconInfo } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { capabilityStatus } from "./status.js";

function uiUnits(descriptor: CapabilityDescriptor): string {
  const units = descriptor.moduleIds
    .map((id) => id.slice(id.indexOf("/") + 1))
    .filter((unit) => unit !== "runtime" && unit !== "worker");
  return units.length > 0 ? units.join(", ") : descriptor.summary;
}

function egressLine(egress: readonly EgressDeclaration[]): string {
  if (egress.length === 0) return "nothing leaves this device";
  return egress
    .map(
      (entry) =>
        `${entry.class} → ${entry.purpose}${entry.automatic ? " (on its own)" : " (when you act)"}`,
    )
    .join("; ");
}

function dependencyLine(descriptor: CapabilityDescriptor): string {
  const slots = descriptor.alternatives.map(
    (slot) => `${slot.slot}: one of ${slot.oneOf.join(" / ")}`,
  );
  const all = [...descriptor.dependencies, ...slots];
  return all.length > 0 ? all.join("; ") : "none";
}

export function CapabilityFacts({
  descriptor,
  state,
}: {
  descriptor: CapabilityDescriptor;
  state: CapabilityState | null | undefined;
}) {
  const facts: Array<[string, string]> = [
    ["does", descriptor.summary],
    ["adds", uiUnits(descriptor)],
    ["needs", dependencyLine(descriptor)],
    ["sends", egressLine(descriptor.egress)],
    ["runs in", descriptor.environments.join(", ")],
    [
      "may ask for",
      descriptor.browserPermissions.length > 0
        ? descriptor.browserPermissions.join(", ")
        : "no browser permission",
    ],
    ["service", descriptor.requiresService ? "required" : "not required"],
    ["offline", descriptor.offlineLimits || "works the same offline"],
    [
      "in this distribution",
      state ? (state.distributed ? "yes" : "no") : "unknown",
    ],
  ];
  return (
    <dl className="capcard__facts">
      {facts.map(([key, value]) => (
        <FactRow key={key} name={key} value={value} />
      ))}
    </dl>
  );
}

function FactRow({ name, value }: { name: string; value: string }) {
  return (
    <>
      <dt>{name}</dt>
      <dd>{value}</dd>
    </>
  );
}

export function CapabilityCard({
  descriptor,
  state,
  lifecycle,
  selected,
  chosenAlternatives,
  titleOf,
  onToggle,
  onChooseAlternative,
}: {
  descriptor: CapabilityDescriptor;
  state: CapabilityState | null | undefined;
  lifecycle: CapabilityLifecycle | undefined;
  /** Selected in the draft (a preview), or null when there is no draft. */
  selected: boolean | null;
  chosenAlternatives: Readonly<Record<string, CapabilityId>>;
  titleOf: (id: CapabilityId) => string;
  onToggle?: (id: CapabilityId) => void;
  onChooseAlternative?: (slot: string, id: CapabilityId) => void;
}) {
  const [open, setOpen] = useState(false);
  const factsId = useId();
  const status = capabilityStatus(state, lifecycle, selected);
  const core = descriptor.tier === "core";
  const pickable =
    !core && Boolean(onToggle) && (state ? state.permitted && state.distributed : true);
  const on = core || selected === true;
  return (
    <li
      className={`capcard${on ? " is-on" : ""}`}
      data-testid={`capability-card-${descriptor.id}`}
    >
      <button
        type="button"
        className="capcard__pick"
        aria-pressed={core ? true : selected === true}
        disabled={!pickable}
        onClick={() => onToggle?.(descriptor.id)}
      >
        <span className="capcard__name">{descriptor.title}</span>
        <span className="capcard__summary">{descriptor.summary}</span>
      </button>
      <span className="capcard__side">
        <StatusMark tone={status.tone} label={status.label} />
        <span className="capcard__state">{status.label}</span>
        <button
          type="button"
          className={`icon-btn icon-btn--sm${open ? " is-on" : ""}`}
          aria-label={`Details of ${descriptor.title}`}
          title={`Details of ${descriptor.title}`}
          aria-expanded={open}
          aria-controls={factsId}
          onClick={() => setOpen(!open)}
        >
          <IconInfo size={14} />
        </button>
      </span>
      {open ? (
        <div id={factsId} style={{ display: "contents" }}>
          <CapabilityFacts descriptor={descriptor} state={state} />
        </div>
      ) : null}
      {on && descriptor.alternatives.length > 0 && onChooseAlternative ? (
        <div className="capcard__alts" aria-label={`Choices for ${descriptor.title}`}>
          {descriptor.alternatives.flatMap((slot) =>
            slot.oneOf.map((id) => {
              const picked = chosenAlternatives[slot.slot] === id;
              return (
                <button
                  key={`${slot.slot}:${id}`}
                  type="button"
                  className={`preset__opt${picked ? " is-on" : ""}`}
                  aria-pressed={picked}
                  onClick={() => onChooseAlternative(slot.slot, id)}
                >
                  <span className="preset__name">{titleOf(id)}</span>
                  <span className="preset__kind">{slot.slot}</span>
                </button>
              );
            }),
          )}
        </div>
      ) : null}
    </li>
  );
}
