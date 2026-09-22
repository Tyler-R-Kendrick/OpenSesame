import { IDENTITY_LABELS, IDENTITY_VIEWS } from "../../lib/section-views.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { useEnabledIdentityViews } from "./identity-views.js";

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
  const ref = useGuideTarget<HTMLButtonElement>(`identity.${id}`);
  return (
    <button
      ref={ref}
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
