import { Link } from "react-router";

import { useStripItem } from "../../lib/strip.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";

import {
  ACCESS_LABELS,
  ACCESS_VIEWS,
} from "@opensesame/app-core/lib/section-view-names.js";
/** The Access views as tabs, each named so a guide can point at it. */
export const ACCESS_TABS = ACCESS_VIEWS.map((id) => ({
  id,
  label: ACCESS_LABELS[id],
  guideId: `access.${id}`,
}));

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
  const guideRef = useGuideTarget<HTMLAnchorElement>(guideId);
  const stripRef = useStripItem<HTMLAnchorElement>(current, guideRef);
  return (
    <Link
      ref={stripRef}
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
