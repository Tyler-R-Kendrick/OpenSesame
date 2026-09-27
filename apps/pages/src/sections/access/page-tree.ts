import {
  type PageTreeLeaf,
  type PageTreeSource,
  pageTabTree,
} from "../../lib/page-to-tree.js";

import {
  ACCESS_LABELS,
  type ACCESS_VIEWS,
} from "@opensesame/app-core/lib/section-view-names.js";
export type AccessPlanes = {
  host?: boolean;
  identity?: boolean;
  shares?: readonly { id: string; label: string }[];
};

function leaf(view: string, id: string, label: string): PageTreeLeaf {
  return { id, label, href: `/access?view=${view}#${id}` };
}

/**
 * A panel is a heading on the tab's page. Only one that lists records (the
 * identity shares) is a directory; the rest are places to jump to, drawn
 * without a caret that would open onto nothing.
 */
function panel(
  view: string,
  id: string,
  label: string,
  items?: PageTreeLeaf[],
): PageTreeSource {
  return {
    id,
    label,
    href: `/access?view=${view}#${id}`,
    keepEmpty: true,
    items,
  };
}

/**
 * Every tab is the same kind of row: a sibling under Access that opens onto
 * the panels its page shows. Collapsing a one-panel tab into a caret-less
 * row drew some tabs as places and others as directories, one indent
 * apart, so a tab read as the child of the tab above it.
 */
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
      panel("sessions", "local-sessions", "Local sessions"),
      panel("sessions", "local-authority-templates", "Audience templates"),
      panel("sessions", "vault-share-sessions", "Vault share sessions"),
      ...(host
        ? [
            panel("sessions", "host-shared-sessions", "Host shared sessions"),
            panel("sessions", "host-sessions", "Host task sessions"),
          ]
        : []),
    ]),
    tab("connectors", [panel("connectors", "local-connectors", "Connectors")]),
    tab("resources", [
      panel("resources", "local-resources", "Local resources"),
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
