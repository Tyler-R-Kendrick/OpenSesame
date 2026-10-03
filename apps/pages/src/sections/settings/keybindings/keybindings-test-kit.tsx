import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { KeybindingsPanels } from "./KeybindingsPanels.js";

export function renderPanels() {
  return render(
    <MemoryRouter initialEntries={["/settings/keybindings"]}>
      <KeybindingsPanels />
    </MemoryRouter>,
  );
}

export function row(label: string): HTMLElement {
  const name = screen.getAllByText(label, { selector: ".kb-row__label" })[0];
  const found = name?.closest("li");
  if (!(found instanceof HTMLElement)) throw new Error(`no row ${label}`);
  return found;
}

/** Press keys into whatever holds focus. */
export function press(...keys: string[]) {
  for (const key of keys) {
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key,
      ctrlKey: false,
    });
  }
}

/** Let the microtasks a blur queues run. */
export async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}
