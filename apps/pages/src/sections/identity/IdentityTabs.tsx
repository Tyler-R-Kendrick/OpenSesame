import { useStripItem } from "../../lib/strip.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { useEnabledIdentityViews } from "./identity-views.js";

import {
  IDENTITY_LABELS,
  type IDENTITY_VIEWS,
} from "@opensesame/app-core/lib/section-view-names.js";
export type IdentityTab = (typeof IDENTITY_VIEWS)[number];

export function IdentityTabs({
  selected,
  onSelect,
  views,
}: {
  selected: IdentityTab;
  onSelect: (tab: IdentityTab) => void;
  /** The tabs on the page; defaults to the capabilities' contributions. */
  views?: readonly IdentityTab[];
}) {
  const contributed = useEnabledIdentityViews();
  const shown = views ?? contributed;
  return (
    <div className="identity-tabs" role="tablist" aria-label="Identity views">
      {shown.map((id) => (
        <IdentityTabButton
          key={id}
          id={id}
          active={selected === id}
          onSelect={() => onSelect(id)}
        />
      ))}
    </div>
  );
}

function IdentityTabButton({
  id,
  active,
  onSelect,
}: { id: IdentityTab; active: boolean; onSelect: () => void }) {
  const guideRef = useGuideTarget<HTMLButtonElement>(`identity.${id}`);
  const stripRef = useStripItem<HTMLButtonElement>(active, guideRef);
  return (
    <button
      ref={stripRef}
      type="button"
      role="tab"
      aria-selected={active}
      className={`identity-tab${active ? " is-active" : ""}`}
      onClick={onSelect}
    >
      {IDENTITY_LABELS[id]}
    </button>
  );
}
