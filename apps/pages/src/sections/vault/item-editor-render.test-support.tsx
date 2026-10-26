import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { ItemEditor } from "./ItemEditor.js";

/** The editor at `path`, new or edit, with a catch-all for where saving goes. */
export function renderEditor(path = "/vault/new/account") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/vault/new/:kind?" element={<ItemEditor mode="new" />} />
        <Route
          path="/vault/:itemId/edit"
          element={<ItemEditor mode="edit" />}
        />
        <Route path="*" element={<div>navigated away</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

export function inputByLabel(label: string | RegExp): HTMLInputElement {
  const element = screen.getByLabelText(label);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`expected input for ${String(label)}`);
  }
  return element;
}

/** Missing-item route without a navigation fallback. */
export function renderMissingEditor() {
  render(
    <MemoryRouter initialEntries={["/vault/itm_gone/edit"]}>
      <Routes>
        <Route
          path="/vault/:itemId/edit"
          element={<ItemEditor mode="edit" />}
        />
      </Routes>
    </MemoryRouter>,
  );
}
