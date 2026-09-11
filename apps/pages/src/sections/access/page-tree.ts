import {
  type PageTreeLeaf,
  type PageTreeSource,
  pageTabTree,
} from "../../lib/page-to-tree.js";
import { ACCESS_LABELS, type ACCESS_VIEWS } from "../../lib/section-views.js";

export type AccessPlanes = {
  host?: boolean;
  identity?: boolean;
  shares?: readonly { id: string; label: string }[];
};

function leaf(view: string, id: string, label: string): PageTreeLeaf {
  return { id, label, href: `/access?view=${view}#${id}` };
}

function panel(
  view: string,
  id: string,
  label: string,
  items: PageTreeLeaf[] = [],
): PageTreeSource {
  return {
    id,
    label,
    href: `/access?view=${view}#${id}`,
    keepEmpty: true,
    items,
  };
}

function tab(
  id: (typeof ACCESS_VIEWS)[number],
  sections: PageTreeSource[],
): PageTreeSource {
  return {
    id,
    label: ACCESS_LABELS[id],
    href: `/access?view=${id}`,
    keepEmpty: true,
    sections,
  };
}

/** Access page: each tab is a subtree of the panels that tab actually shows. */
export function accessPageSources({
  host = false,
  identity = false,
  shares = [],
}: AccessPlanes = {}): PageTreeSource[] {
  return [
    tab("grants", [
      panel("grants", "local-grants", "Local application grants"),
      panel(
        "grants",
        "identity-shares",
        "Identity shares",
        shares.map((share) => leaf("grants", `share-${share.id}`, share.label)),
      ),
      ...(host ? [panel("grants", "host-grants", "Grants")] : []),
    ]),
    tab("requests", [
      panel("requests", "local-requests", "Local requests"),
      ...(host ? [panel("requests", "host-requests", "Requests")] : []),
    ]),
    tab("sessions", [
      panel("sessions", "local-sessions", "Local sessions & grants"),
      ...(host
        ? [panel("sessions", "host-sessions", "Host task sessions")]
        : []),
    ]),
    tab("resources", [
      ...(identity ? [panel("resources", "resource-sites", "Sites")] : []),
    ]),
    tab("policies", [
      panel("policies", "local-policies", "Local application policies"),
      ...(host ? [panel("policies", "host-policies", "Policies")] : []),
    ]),
  ];
}

export function accessPageTree(planes?: AccessPlanes) {
  return pageTabTree(accessPageSources(planes));
}
