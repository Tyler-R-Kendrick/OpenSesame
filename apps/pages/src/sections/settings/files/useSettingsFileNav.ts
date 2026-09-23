/**
 * Which representation Settings shows — the Form, or the file viewer in a
 * spelling — and which file the viewer has open. The open file is kept per
 * category, so moving to another category opens that one's own document.
 * `fileNav` is what a Form row calls to open the file it is drawn from.
 */
import type { RawFormat } from "@opensesame/app-core/sections/settings/settings-files.js";
import { useMemo, useState } from "react";
import type { SettingsFileNav } from "./context.js";

export function useSettingsFileNav(category: string) {
  const [representation, setRepresentation] = useState<"form" | RawFormat>(
    "form",
  );
  const [opened, setOpened] = useState<{
    category: string;
    path: string | null;
  }>();
  const openPath = opened?.category === category ? opened.path : null;
  const setOpenPath = (path: string | null) => setOpened({ category, path });
  const fileNav = useMemo<SettingsFileNav>(
    () => ({
      openFile: (path: string) => {
        setOpened({ category, path });
        setRepresentation((current) => (current === "form" ? "yaml" : current));
        document
          .querySelector(".section__inner")
          ?.scrollIntoView?.({ block: "start" });
      },
    }),
    [category],
  );
  return { representation, setRepresentation, openPath, setOpenPath, fileNav };
}
