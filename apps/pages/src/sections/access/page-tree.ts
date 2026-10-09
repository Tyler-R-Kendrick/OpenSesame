import {
  type PageTreeLeaf,
  type PageTreeSource,
  pageTabTree,
} from "../../lib/page-to-tree.js";

import { APPROVAL_LABELS } from "@opensesame/app-core/lib/approvals-route.js";
import {
  ACCESS_LABELS,
  type ACCESS_VIEWS,
} from "@opensesame/app-core/lib/section-view-names.js";
export type AccessPlanes = {
  /** An Identity API is configured, so Requests draws its inbox. */
  identity?: boolean;
  /** The access book holds a grant, so Grants draws Portable grants. */
  book?: boolean;
  /** An Identity session is held, so Sessions draws its receipts. */
  receipts?: boolean;
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
    guide: `access.${id}`,
    href: `/access?view=${id}`,
    keepEmpty: true,
    sections,
  };
}

/**
 * Access page: each tab is a subtree of the panels that tab actually draws,
 * in the order it draws them. Nothing here names a Host panel: the page has
 * none, and a rail entry for one opened its tab with nothing to land on.
 */
export function accessPageSources({
  identity = false,
  book = false,
  receipts = false,
  shares = [],
}: AccessPlanes = {}): PageTreeSource[] {
  return [
    tab("grants", [
      ...(book ? [panel("grants", "access-book", "Portable grants")] : []),
      panel("grants", "local-grants", "Local application grants"),
      panel(
        "grants",
        "identity-shares",
        "Identity shares",
        shares.map((share) => leaf("grants", `share-${share.id}`, share.label)),
      ),
    ]),
    tab("requests", [
      // The inbox addressed to an Identity session draws only where an
      // Identity API is configured (ADR 0090), and above the local list.
      ...(identity
        ? [panel("requests", "hosted-requests", APPROVAL_LABELS.inbox)]
        : []),
      panel("requests", "local-requests", "Local requests"),
    ]),
    tab("sessions", [
      panel("sessions", "sent-drops", "Sent"),
      panel("sessions", "local-sessions", "Local sessions"),
      panel("sessions", "local-authority-templates", "Audience templates"),
      panel("sessions", "vault-share-sessions", "Vault share sessions"),
      ...(receipts ? [panel("sessions", "access-receipts", "Receipts")] : []),
    ]),
    tab("connectors", [panel("connectors", "local-connectors", "Connectors")]),
    tab("resources", [
      panel("resources", "local-resources", "Local resources"),
    ]),
    tab("policies", [
      panel("policies", "local-policies", "Local application policies"),
    ]),
  ];
}

export function accessPageTree(planes?: AccessPlanes) {
  return pageTabTree(accessPageSources(planes));
}
