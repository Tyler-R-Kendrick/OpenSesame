import { ACCESS_LABELS, ACCESS_VIEWS } from "../../lib/section-views.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";

/** The Access views as tabs, each named so a guide can point at it. */
export const ACCESS_TABS = ACCESS_VIEWS.map((id) => ({
  id,
  label: ACCESS_LABELS[id],
  guideId: `access.${id}`,
}));

/** One tab, named so a guide can point at it without knowing the markup. */
export function AccessTabButton({
  guideId,
  label,
  active,
  onSelect,
}: {
  guideId: string;
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  const ref = useGuideTarget<HTMLButtonElement>(guideId);
  return (
    <button
      ref={ref}
      type="button"
      role="tab"
      aria-selected={active}
      className={`access-tab${active ? " is-active" : ""}`}
      onClick={onSelect}
    >
      {label}
    </button>
  );
}
