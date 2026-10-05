import { useEffect } from "react";

/**
 * The other ways to add that sit behind the Add button on a phone: Import,
 * Export, whatever a capability contributes. Each is a flow with its own
 * sheet, mounted beside the button, which registers one entry here while it
 * is mounted; the button's menu (its ellipsis, or a long press on it) lists
 * what is registered when it opens.
 */
export type AddEntry = {
  id: string;
  label: string;
  /** Lower first. */
  order: number;
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
  const { id, label, order, run } = entry;
  useEffect(() => {
    const own = { id, label, order, run };
    entries.set(id, own);
    return () => {
      if (entries.get(id) === own) entries.delete(id);
    };
  }, [id, label, order, run]);
}
