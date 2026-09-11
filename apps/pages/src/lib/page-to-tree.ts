/** A page heading or leaf that the rail can walk in document order. */
export type PageTreeLeaf = {
  id: string;
  label: string;
  href: string;
  /** Keyboard preview; activation still follows `href`. */
  selectTo?: string;
  count?: number;
  dir?: boolean;
};

export type PageTreeNode = PageTreeLeaf & {
  children: PageTreeNode[];
  /** True for page subheaders, even when the region currently has no items. */
  branch: boolean;
};

/** One page region: a subheader, optional nested subheaders, then its items. */
export type PageTreeSource = PageTreeLeaf & {
  keepEmpty?: boolean;
  items?: readonly PageTreeLeaf[];
  sections?: readonly PageTreeSource[];
};

/** A page tablist: each tab is a subtree section in document order. */
export function pageTabTree(
  tabs: readonly (PageTreeLeaf & {
    items?: readonly PageTreeLeaf[];
    sections?: readonly PageTreeSource[];
  })[],
): PageTreeNode[] {
  return pageToTree(
    tabs.map((tab) => ({
      ...tab,
      keepEmpty: true,
    })),
  );
}

/** Turn page sections into navigable subtrees, preserving page order. */
export function pageToTree(
  sections: readonly PageTreeSource[],
): PageTreeNode[] {
  const tree: PageTreeNode[] = [];
  for (const section of sections) {
    const children = [
      ...pageToTree(section.sections ?? []),
      ...(section.items ?? []).map((item) => ({
        ...item,
        children: [],
        branch: false,
      })),
    ];
    if (children.length === 0 && !section.keepEmpty) continue;
    tree.push({
      id: section.id,
      label: section.label,
      href: section.href,
      children,
      branch: true,
    });
  }
  return tree;
}

/** True when `current` is this href or a more specific path under it. */
export function hrefContainsCurrent(href: string, current: string): boolean {
  if (!href) return false;
  if (current === href) return true;
  if (!current.startsWith(href)) return false;
  return "/?#&-".includes(current.charAt(href.length));
}

/** True when this node, or a descendant, is the current rail path. */
export function pageTreeContains(
  node: PageTreeNode,
  current: string,
): boolean {
  if (hrefContainsCurrent(node.href, current)) return true;
  return node.children.some((child) => pageTreeContains(child, current));
}

export function pageTreeLeaves(nodes: readonly PageTreeNode[]): PageTreeNode[] {
  const leaves: PageTreeNode[] = [];
  for (const node of nodes) {
    if (node.branch || node.children.length > 0)
      leaves.push(...pageTreeLeaves(node.children));
    else leaves.push(node);
  }
  return leaves;
}

/** Keep the first `limit` leaves in page order, dropping empty subheaders. */
export function limitPageTree(
  sections: readonly PageTreeSource[],
  limit: number,
): PageTreeSource[] {
  let remaining = limit;
  const limited: PageTreeSource[] = [];
  for (const section of sections) {
    if (remaining <= 0) break;
    const nested = limitPageTree(section.sections ?? [], remaining);
    remaining -= pageTreeLeaves(pageToTree(nested)).length;
    const items =
      remaining > 0 ? (section.items ?? []).slice(0, remaining) : [];
    remaining -= items.length;
    if (nested.length === 0 && items.length === 0 && !section.keepEmpty)
      continue;
    limited.push({
      ...section,
      sections: nested.length ? nested : undefined,
      items: items.length ? items : undefined,
    });
  }
  return limited;
}
