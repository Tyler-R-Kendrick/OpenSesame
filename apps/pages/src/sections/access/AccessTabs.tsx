import { Link } from "react-router";
import { accessPath } from "../../lib/access-routes.js";
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

/** One tab as a route link for the Access pathbar shell. */
export function AccessTabLink({
  guideId,
  label,
  to,
  current,
}: {
  guideId: string;
  label: string;
  to: string;
  current: boolean;
}) {
  const ref = useGuideTarget<HTMLAnchorElement>(guideId);
  return (
    <Link
      ref={ref}
      to={to}
      role="tab"
      aria-selected={current}
      className={`access-tab${current ? " is-active" : ""}`}
      aria-current={current ? "page" : undefined}
    >
      {label}
    </Link>
  );
}
