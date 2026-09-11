import type {
  LocalIdentity,
  LocalIdentityKind,
} from "../../lib/local-directory.js";
import {
  type PageTreeLeaf,
  type PageTreeSource,
  pageTabTree,
} from "../../lib/page-to-tree.js";
import { IDENTITY_LABELS, IDENTITY_VIEWS } from "../../lib/section-views.js";

export type IdentityRailSnapshot = {
  directory?: readonly LocalIdentity[];
  providers?: readonly { id: string; label: string }[];
  devices?: readonly { id: string; name: string }[];
};

const VIEW_KIND = {
  people: "person",
  agents: "agent",
  "service-accounts": "application",
  organization: "organization",
} as const satisfies Partial<
  Record<(typeof IDENTITY_VIEWS)[number], LocalIdentityKind>
>;

function leaf(view: string, id: string, label: string): PageTreeLeaf {
  return {
    id,
    label,
    href: `/identity?view=${view}#${encodeURIComponent(id)}`,
  };
}

function itemsFor(
  view: (typeof IDENTITY_VIEWS)[number],
  snapshot: IdentityRailSnapshot,
): PageTreeLeaf[] {
  const directory = snapshot.directory ?? [];
  if (view === "providers") {
    return (snapshot.providers ?? []).map((record) =>
      leaf(view, record.id, record.label),
    );
  }
  if (view === "devices") {
    return (snapshot.devices ?? []).map((device) =>
      leaf(view, device.id, device.name),
    );
  }
  const kind = VIEW_KIND[view as keyof typeof VIEW_KIND];
  if (!kind) return [];
  return directory
    .filter((entry) => entry.kind === kind)
    .map((entry) => leaf(view, entry.id, entry.name));
}

/** Identity page: each tab is a subtree of the records that tab shows. */
export function identityPageSources(
  snapshot: IdentityRailSnapshot = {},
): PageTreeSource[] {
  return IDENTITY_VIEWS.map((id) => ({
    id,
    label: IDENTITY_LABELS[id],
    href: `/identity?view=${id}`,
    items: itemsFor(id, snapshot),
  }));
}

export function identityPageTree(snapshot: IdentityRailSnapshot = {}) {
  return pageTabTree(identityPageSources(snapshot));
}
