import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

type Segment = "Folder" | "Type";

/** Open a segment the way a person does, with a click, and return its list. */
async function openList(label: Segment) {
  await userEvent.click(screen.getByLabelText(label));
  return screen.getByRole("listbox", { name: `${label} choices` });
}

/** The keys of the rows a segment offers, in order. */
export async function listedKeys(label: Segment): Promise<string[]> {
  const box = await openList(label);
  const keys = within(box)
    .getAllByRole("option")
    .map((option) => option.getAttribute("data-key") ?? "");
  await userEvent.keyboard("{Escape}");
  return keys;
}

/** Choose the row with `key` from a segment's list with the pointer. */
export async function choose(label: Segment, key: string) {
  const box = await openList(label);
  const row = box.querySelector(`[data-key="${key}"]`);
  if (!row) throw new Error(`${label} offers no ${key}`);
  await userEvent.click(row);
}

/** What a segment reads as now: `./`, `Work/`, `.card`. */
export function shown(label: Segment): string {
  const field = screen.getByLabelText(label);
  if (!(field instanceof HTMLInputElement)) throw new Error("Not a field");
  return field.value;
}
