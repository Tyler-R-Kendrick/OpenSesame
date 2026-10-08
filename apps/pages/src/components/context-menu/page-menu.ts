import {
  isSettingsCategory,
  settingsConfigRoute,
} from "@opensesame/app-core/lib/crumbs.js";
import { isDecoySession } from "@opensesame/app-core/lib/decoy-session.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { focusCommandBar } from "../../lib/command-bar/focus.js";
import {
  navigationContext,
  runSessionHistoryNavigation,
  runSessionNavigation,
  sessionNavigationAllowed,
} from "../../lib/decoy-navigation.js";
import { keymapLabel } from "../../lib/gestures.js";
import { showKeymapHelp } from "../../lib/keymap-help.js";
import type { MenuGroup, MenuItem } from "./menu-model.js";

/** Write text the page produced (a link, a selection) — never a secret. */
export function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

type Navigate = (to: string) => void;

/** The settings directory a link opens, if it opens one. */
function settingsDirectory(link: HTMLAnchorElement): string | null {
  const route = link.getAttribute("href") ?? "";
  const match = /\/settings(?:\/([^/?#]+))?\/?$/.exec(
    route.split(/[?#]/)[0] ?? "",
  );
  if (!match) return null;
  const category = match[1] ?? "general";
  return isSettingsCategory(category) ? category : null;
}

function linkGroup(
  link: HTMLAnchorElement | null,
  navigate: Navigate,
): MenuItem[] {
  if (!link) return [];
  const directory = settingsDirectory(link);
  const config: MenuItem[] = directory
    ? [
        {
          id: "link-config",
          label: "Open config.yaml",
          run: () => navigate(settingsConfigRoute(directory)),
        },
      ]
    : [];
  return [
    ...config,
    {
      id: "link-open",
      label: "Open link",
      disabled: !sessionNavigationAllowed(
        link.href,
        navigationContext(link.target),
      ),
      run: () => {
        runSessionNavigation(
          link.href,
          () => link.click(),
          navigationContext(link.target),
        );
      },
    },
    {
      id: "link-tab",
      label: "Open link in new tab",
      disabled: !sessionNavigationAllowed(link.href, "new_context"),
      run: () => {
        runSessionNavigation(
          link.href,
          () => {
            window.open(link.href, "_blank", "noopener");
          },
          "new_context",
        );
      },
    },
    {
      id: "link-copy",
      label: "Copy link address",
      run: () => copyText(link.href),
    },
  ];
}

/** Moving around, which the browser's own menu would have offered. */
export function navigationGroup(): MenuItem[] {
  return [
    {
      id: "back",
      label: "Back",
      hint: "Alt+←",
      disabled: isDecoySession(),
      run: () => {
        runSessionHistoryNavigation(() => history.back());
      },
    },
    {
      id: "forward",
      label: "Forward",
      hint: "Alt+→",
      disabled: isDecoySession(),
      run: () => {
        runSessionHistoryNavigation(() => history.forward());
      },
    },
    { id: "reload", label: "Reload", run: () => location.reload() },
  ];
}

/** The shell's own entry points, where the shell is mounted. */
export function shellGroup(): MenuItem[] {
  if (!document.getElementById("command-bar-input")) return [];
  const items: MenuItem[] = [
    { id: "command", label: "Command bar", hint: ":", run: focusCommandBar },
    {
      id: "keymap",
      label: keymapLabel(),
      hint: "?",
      run: showKeymapHelp,
    },
  ];
  if (vaultStore.getSnapshot().status === "unlocked") {
    items.push({
      id: "lock",
      label: "Lock vault",
      run: () => void vaultStore.lock(),
    });
  }
  return items;
}

/**
 * The menu for anything without one of its own: the link under the pointer,
 * the text selected, then the page.
 */
export function pageMenu(
  target: Element | null,
  selection: string,
  navigate: Navigate,
): MenuGroup[] {
  const link = target?.closest<HTMLAnchorElement>("a[href]") ?? null;
  const copy: MenuItem[] = selection.trim()
    ? [
        {
          id: "copy",
          label: "Copy",
          hint: "Ctrl+C",
          run: () => copyText(selection),
        },
      ]
    : [];
  return [linkGroup(link, navigate), copy, navigationGroup(), shellGroup()];
}
