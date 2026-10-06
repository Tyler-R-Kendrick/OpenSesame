import { useEffect } from "react";

/**
 * The other ways to add that sit behind the Add button on a phone: Import and
 * Export. Each is a flow with its own sheet, mounted beside the button, which
 * registers one entry here while it is mounted. Holding the button draws the
 * drag area (`AddSlide`): the entry whose `slide` is `up` is chosen by sliding
 * up and released there, the one that is `down` by sliding down. A keyboard
 * or a screen reader, which cannot slide, gets the same entries as a menu.
 */
export type AddEntry = {
  id: string;
  label: string;
  /** Lower first. */
  order: number;
  /** Optional hold direction; omitted entries are available through the menu. */
  slide?: "up" | "down" | undefined;
  run: () => void;
};

const entries = new Map<string, AddEntry>();

export function addEntries(): AddEntry[] {
  return [...entries.values()].sort(
    (left, right) =>
      left.order - right.order || left.id.localeCompare(right.id),
  );
}

/** Register an entry while the calling flow is mounted. */
export function useAddEntry(entry: AddEntry): void {
  const { id, label, order, slide, run } = entry;
  useEffect(() => {
    const own = { id, label, order, slide, run };
    entries.set(id, own);
    return () => {
      if (entries.get(id) === own) entries.delete(id);
    };
  }, [id, label, order, slide, run]);
}
