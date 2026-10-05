/**
 * Installing and removing a community item type is writing and deleting a
 * file (ADR 0134). The outcome is a glyph in the panel head and a sentence
 * for assistive technology.
 */

import { installedPath } from "@opensesame/app-core/sections/settings/item-type-files.js";
import type { VirtualFileProvider } from "@opensesame/app-core/sections/settings/virtual-files.js";
import { itemTypeRegistry } from "@opensesame/vault-core";
import { parseDefinition } from "@opensesame/vault-item-types";
import { useState } from "react";
import type { PackOutcome } from "./usePackActions.js";

export function useFileActions(files: VirtualFileProvider) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<PackOutcome>(null);
  const run = async (task: () => Promise<string>) => {
    setBusy(true);
    setOutcome(null);
    try {
      setOutcome({ tone: "ok", text: await task() });
    } catch (caught) {
      setOutcome({
        tone: "err",
        text: caught instanceof Error ? caught.message : "It did not save.",
      });
    } finally {
      setBusy(false);
    }
  };
  /** Installing is writing `installed/<id>.json`. */
  const install = (text: string) =>
    void run(async () => {
      const parsed = parseDefinition(text, "community");
      if (!parsed.ok) throw new Error("That definition does not parse.");
      const { id } = parsed.definition.metadata;
      const written = await files.write(installedPath(id), text);
      if (!written.ok) throw new Error(written.message);
      return `${parsed.definition.spec.title} installed as ${id}.json.`;
    });
  /** Removing is deleting it. Items of that type keep their values. */
  const remove = (id: string) =>
    void run(async () => {
      const title = itemTypeRegistry().get(id)?.spec.title ?? id;
      const removed = await files.remove(installedPath(id));
      if (!removed.ok) throw new Error(removed.message);
      return `${title} removed. Its items keep their values.`;
    });
  return { busy, outcome, install, remove };
}
