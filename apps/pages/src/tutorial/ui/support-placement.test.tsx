/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it } from "vitest";
import { SupportProvider } from "../session.js";
import {
  SupportLauncher,
  SupportSlot,
  SupportSlotProvider,
} from "./SupportLauncher.js";

afterEach(cleanup);

function Page({ unlocked }: { unlocked: boolean }) {
  return (
    <MemoryRouter>
      <SupportProvider>
        <SupportSlotProvider>
          {unlocked ? (
            <footer className="statusline">
              <SupportSlot />
            </footer>
          ) : null}
          <SupportLauncher />
        </SupportSlotProvider>
      </SupportProvider>
    </MemoryRouter>
  );
}

it("keeps exactly one support control through unlock and lock", () => {
  const view = render(<Page unlocked={false} />);
  expect(
    screen.getByRole("button", { name: "Support" }).closest("footer"),
  ).toBeNull();
  view.rerender(<Page unlocked />);
  expect(screen.getAllByRole("button", { name: "Support" })).toHaveLength(1);
  expect(
    screen.getByRole("button", { name: "Support" }).closest("footer"),
  ).not.toBeNull();
  view.rerender(<Page unlocked={false} />);
  expect(screen.getAllByRole("button", { name: "Support" })).toHaveLength(1);
  expect(
    screen.getByRole("button", { name: "Support" }).closest("footer"),
  ).toBeNull();
});

it("loads launcher styles before the lazy support panel opens", () => {
  const source = readFileSync("src/tutorial/ui/SupportLauncher.tsx", "utf8");
  expect(source).toContain('import "../support.css"');
});
