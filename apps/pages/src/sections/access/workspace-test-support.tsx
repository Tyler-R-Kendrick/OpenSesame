import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";

export function renderAccess(
  ui: ReactNode,
  path = "/access?view=grants#local-grants/grant-record",
) {
  return render(ui, {
    wrapper: ({ children }) => (
      <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
    ),
  });
}
