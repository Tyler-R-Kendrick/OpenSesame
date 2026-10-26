import { currentHost } from "@opensesame/app-core/lib/live/session.js";
/** @vitest-environment jsdom */
import { act, render, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { LiveJoinRoute } from "./LiveJoinRoute.js";
import {
  asked,
  enter,
  hosted,
  installLiveFocusTests,
  landsOn,
  press,
  type,
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

async function joinedDevice() {
  const { panel, session } = await hosted();
  const view = render(scene("joining"));
  const joiner = within(view.container);
  const request = await asked(joiner, session?.code ?? "");
  type(panel.getByLabelText("Paste a join request"), request);
  enter(panel.getByLabelText("Paste a join request"));
  press(await panel.findByRole("button", { name: "Let Ada in" }));
  await panel.findByRole("button", { name: "Copy the reply code for Ada" });
  const field = joiner.getByLabelText("The owner's reply code");
  type(field, currentHost()?.state.guests[0]?.reply ?? "");
  enter(field);
  await joiner.findByRole("img", { name: "Joined Team" });
  return view;
}

it("lands on joined status when returning from the own vault remounts the session", async () => {
  const view = await joinedDevice();
  act(() => view.container.querySelector<HTMLElement>("main")?.focus());
  view.rerender(scene("returning-to-session"));
  await landsOn(view.container.querySelector("#live-status"));
});

it("keeps a chosen control when an already joined session remounts", async () => {
  const view = await joinedDevice();
  const chosen = within(view.container).getByRole("button", {
    name: "Keep my focus",
  });
  act(() => chosen.focus());
  view.rerender(scene("returning-to-session"));
  await landsOn(chosen);
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
