import { itemKindsSnapshot } from "@opensesame/app-core/lib/item-kinds.js";
import { saveShowHidden } from "@opensesame/app-core/lib/show-hidden.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { MenuGroup, MenuItem } from "./menu-model.js";
import { copyText, navigationGroup, shellGroup } from "./page-menu.js";

type Navigate = (to: string) => void;

/** What the row under the pointer is, read from the attributes it renders. */
function describe(row: HTMLElement) {
  return {
    // Where activating the row goes — not `data-rail-to`, which is the
    // keyboard preview's destination and can be a heading on another page.
    to: row.dataset.railOpen ?? row.dataset.railTo ?? "",
    href: row instanceof HTMLAnchorElement ? row.href : "",
    kind: row.dataset.railKind,
    config: row.dataset.railConfig,
    expanded: row.getAttribute("aria-expanded"),
    level: Number(row.getAttribute("aria-level") ?? 1),
    active: row.classList.contains("is-active"),
    name: row.getAttribute("aria-label") ?? row.textContent?.trim() ?? "",
  };
}

function openGroup(row: HTMLElement, navigate: Navigate): MenuItem[] {
  const entry = describe(row);
  const items: MenuItem[] = [
    { id: "open", label: "Open", hint: "Enter", run: () => navigate(entry.to) },
  ];
  // A section row flips only while it is where you are; anywhere else a
  // click takes you there and opens it. The menu offers what a click does.
  const flips = entry.level > 1 || entry.active || entry.expanded === "false";
  if (entry.expanded !== null && flips) {
    const open = entry.expanded === "true";
    items.push({
      id: "toggle",
      label: open ? "Collapse" : "Expand",
      hint: open ? "←" : "→",
      run: () => row.click(),
    });
  }
  if (entry.config) {
    const config = entry.config;
    items.push({
      id: "config",
      label: "Open config.yaml",
      run: () => navigate(config),
    });
  }
  if (entry.href) {
    items.push({
      id: "tab",
      label: "Open in new tab",
      run: () => window.open(entry.href, "_blank", "noopener"),
    });
  }
  return items;
}

/** A vault directory can hold a new item; a kind's directory, one of it. */
function vaultGroup(row: HTMLElement, navigate: Navigate): MenuItem[] {
  const entry = describe(row);
  if (!entry.to.startsWith("/vault")) return [];
  if (entry.kind === "trash") {
    return [
      {
        id: "empty-trash",
        label: "Empty trash",
        danger: true,
        confirm: "Really empty trash? This cannot be undone",
        run: () => void vaultStore.emptyTrash(),
      },
    ];
  }
  const filter = new URLSearchParams(entry.to.split("?")[1] ?? "").get("f");
  const kind = itemKindsSnapshot().some((known) => known.id === filter)
    ? filter
    : null;
  return [
    {
      id: "new",
      label: kind ? `New ${kind}` : "New item",
      hint: "n",
      run: () => navigate(kind ? `/vault/new/${kind}` : "/vault/new"),
    },
  ];
}

/**
 * The rail's menu. On a row: open it, flip it, open its `config.yaml`, make
 * something in it, copy its link. Anywhere in the rail: whether hidden
 * entries — each directory's `config.yaml`, the vault's `trash/` — are listed.
 */
export function railMenu(
  row: HTMLElement | null,
  showHidden: boolean,
  navigate: Navigate,
): MenuGroup[] {
  const hidden: MenuItem = {
    id: "show-hidden",
    label: "Show hidden items",
    checked: showHidden,
    run: () => saveShowHidden(!showHidden),
  };
  if (!row) return [[hidden], navigationGroup(), shellGroup()];
  const entry = describe(row);
  const copy: MenuItem[] = entry.href
    ? [{ id: "copy-link", label: "Copy link", run: () => copyText(entry.href) }]
    : [];
  return [openGroup(row, navigate), vaultGroup(row, navigate), copy, [hidden]];
}

/** The rail row a `contextmenu` landed on, if any. */
export function railRowAt(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const row = target.closest('[role="treeitem"]');
  return row instanceof HTMLElement ? row : null;
}
