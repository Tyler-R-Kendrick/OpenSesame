/**
 * Settings › Capabilities — the switch every section and capability tile
 * wears, and the Guests section, which is a switch and nothing else.
 *
 * "Allow guests" is the one switch that is not a capability: the guest road
 * is core and on by default, and only its operator may take it away.
 */

import { setGuestsAllowed } from "@opensesame/app-core/lib/guest-access.js";
import type { ReactNode } from "react";
import { useGuestsAllowed } from "../../bindings/guest-access.js";
import { useVault } from "../../lib/vault/hooks.js";
import { useDeviceOperator } from "./useDeviceOperator.js";

/** The subheader every section wears: its title, and its switch if any. */
export function SectionHead({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="conn-group__label capsection__head">
      <h3 className="capsection__title">{title}</h3>
      {children}
    </div>
  );
}

export function CapabilitySwitch({
  label,
  capabilityTitle,
  on,
  onToggle,
}: {
  label: string;
  /**
   * The catalog title of the one capability this switch adds or removes,
   * when it is exactly one — so a walk that knows a capability by its title
   * finds its switch whether a tile or a section's subheader carries it.
   */
  capabilityTitle?: string | undefined;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="toggle capsection__switch"
      role="switch"
      aria-checked={on}
      aria-pressed={on}
      aria-label={label}
      title={label}
      data-capability-title={capabilityTitle}
      onClick={onToggle}
    />
  );
}

/**
 * Whether the Guests section draws — the rail asks before it lists it.
 *
 * Allow guests is the operator's switch (`useDeviceOperator`). A guest never
 * sees it, so the one person holding the device on the guest road cannot
 * shut that road behind themselves. Once guests are off, anyone signed in
 * here may turn them back on: the default is on, and a device whose operator
 * is gone must still be able to get the road back.
 */
export function useGuestRowShown(): boolean {
  const allowed = useGuestsAllowed();
  const operator = useDeviceOperator();
  const { guest } = useVault();
  return operator || (!allowed && !guest);
}

export function GuestSection() {
  const allowed = useGuestsAllowed();
  if (!useGuestRowShown()) return null;
  return (
    <section
      className="conn-group capsection"
      id="feature-guests"
      aria-label="Guests"
    >
      <SectionHead title="Guests">
        <CapabilitySwitch
          label="Allow guests"
          on={allowed}
          onToggle={() => void setGuestsAllowed(!allowed)}
        />
      </SectionHead>
    </section>
  );
}
