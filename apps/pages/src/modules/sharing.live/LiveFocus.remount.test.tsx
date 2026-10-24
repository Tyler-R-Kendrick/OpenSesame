/** @vitest-environment jsdom */
import { act, render, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { LiveJoinRoute } from "./LiveJoinRoute.js";
import {
  asked,
  hosted,
  installLiveFocusTests,
  landsOn,
} from "./live-focus-test-support.js";

installLiveFocusTests();

function scene(vault: string) {
  return (
    <MemoryRouter>
      <main id="main" tabIndex={-1}>
        <button type="button">Keep my focus</button>
        <LiveJoinRoute key={vault} />
      </main>
    </MemoryRouter>
  );
}

async function requestingDevice() {
  const { session } = await hosted();
  const view = render(scene("empty-vault"));
  await asked(within(view.container), session?.code ?? "");
  return view;
}

it("restores the request copy key after own-vault creation remounts the route on the main fallback", async () => {
  const view = await requestingDevice();
  const main = view.container.querySelector("main");
  act(() => main?.focus());
  expect(document.activeElement).toBe(main);
  view.rerender(scene("owned-vault"));
  await landsOn(
    within(view.container).getByRole("button", {
      name: "Copy your join request",
    }),
  );
});

it("preserves a real control the person chose across the owned-vault remount", async () => {
  const view = await requestingDevice();
  const chosen = within(view.container).getByRole("button", {
    name: "Keep my focus",
  });
  act(() => chosen.focus());
  view.rerender(scene("owned-vault"));
  await landsOn(chosen);
});
