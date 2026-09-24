/**
 * Which file Settings has open, if any. There is no Form / source switch: a
 * settings directory's files are addressed like pages, `?file=<path>` on the
 * directory's own route — `config.yaml` for the directory's own document,
 * a provider's path (an item type's JSON) for the rest. The rail, the
 * command bar and a Form row's open key all arrive the same way, and Back
 * returns to the form.
 *
 * `fileNav` is what a Form row calls to open the file it is drawn from.
 */
import {
  settingsFileFromSearch,
  settingsFileRoute,
  settingsPath,
} from "@opensesame/app-core/lib/crumbs.js";
import { useMemo } from "react";
import { useNavigate } from "react-router";
import { scrollToPanel } from "../../../lib/scroll-panel.js";
import type { SettingsFileNav } from "./context.js";

export function useSettingsFileNav(category: string, search: string) {
  const navigate = useNavigate();
  const openPath = settingsFileFromSearch(search);
  const fileNav = useMemo<SettingsFileNav>(
    () => ({
      openFile: (path: string) => {
        navigate(settingsFileRoute(category, path));
        const pane = document.querySelector(".section__inner");
        if (pane instanceof HTMLElement) scrollToPanel(pane);
      },
    }),
    [category, navigate],
  );
  const setOpenPath = (path: string | null) => {
    // Moving between a directory's files replaces the entry, so Back still
    // returns to the form rather than walking every file that was opened.
    navigate(
      path === null
        ? settingsPath(category)
        : settingsFileRoute(category, path),
      { replace: true },
    );
  };
  return { openPath, setOpenPath, fileNav };
}
