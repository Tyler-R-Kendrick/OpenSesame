import {
  type PageTreeLeaf,
  type PageTreeSource,
  pageTabTree,
} from "../../lib/page-to-tree.js";
import { ACCESS_LABELS, ACCESS_VIEWS } from "../../lib/section-views.js";

export type AccessPlanes = {
  host?: boolean;
  identity?: boolean;
  shares?: readonly { id: string; label: string }[];
};

function panel(view: string, id: string, label: string): PageTreeLeaf {
  return { id, label, href: `/access?view=${view}#${id}` };
}

function tab(
  id: (typeof ACCESS_VIEWS)[number],
  items: PageTreeLeaf[],
): PageTreeSource {
  return {
    id,
    label: ACCESS_LABELS[id],
    href: `/access?view=${id}`,
    items,
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
      panel("grants", "identity-shares", "Identity shares"),
      ...shares.map((share) =>
        panel("grants", `share-${share.id}`, share.label),
      ),
      ...(host ? [panel("grants", "host-grants", "Grants")] : []),
    ]),
    tab("requests", [
      panel("requests", "local-requests", "Local requests"),
      ...(host ? [panel("requests", "host-requests", "Requests")] : []),
    ]),
    tab("sessions", [
      panel("sessions", "local-sessions", "Local sessions & grants"),
      ...(host ? [panel("sessions", "host-sessions", "Host task sessions")] : []),
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
