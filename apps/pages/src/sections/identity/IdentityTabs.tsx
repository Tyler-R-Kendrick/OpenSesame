import { IDENTITY_LABELS, IDENTITY_VIEWS } from "../../lib/section-views.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";

export type IdentityTab = (typeof IDENTITY_VIEWS)[number];

export function IdentityTabs({
  selected,
  onSelect,
}: { selected: IdentityTab; onSelect: (tab: IdentityTab) => void }) {
  return (
    <div className="identity-tabs" role="tablist" aria-label="Identity views">
      {IDENTITY_VIEWS.map((id) => (
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
