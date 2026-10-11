/** @vitest-environment jsdom */
import { KEY_PATTERN } from "@opensesame/app-core/lib/model-keys/vocabulary.js";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import {
  fillSheet,
  holdMint,
  mintKeyTestBed,
} from "./mint-key.test-support.js";

const bed = mintKeyTestBed();

it("cannot be dismissed while a key is being made, and shows the key when it is", async () => {
  const h = await bed.ready();
  const release = holdMint(h);
  const { sheet, create } = await fillSheet("my-agent", "gpt-4o");
  await userEvent.click(create());
  expect(create()).toHaveProperty("disabled", true);

  // Escape, the scrim and the close key are all the one way out, and all held.
  await userEvent.keyboard("{Escape}");
  for (const close of screen.getAllByRole("button", { name: "Close" }))
    await userEvent.click(close);
  expect(screen.getByRole("dialog", { name: "Create a key" })).toBeTruthy();

  release();
  const shown = await within(sheet).findByTestId("model-key-token");
  expect(shown.textContent).toMatch(KEY_PATTERN);
  expect(h.broker.list()).toHaveLength(1);
  expect(h.broker.list()[0]?.status).toBe("active");
});

it("revokes a key that finishes after the sheet is gone, so no live key is left that nobody holds", async () => {
  const h = await bed.ready();
  const release = holdMint(h);
  const { create } = await fillSheet("my-agent", "gpt-4o");
  await userEvent.click(create());

  bed.unmount();
  release();

  await waitFor(() => expect(h.broker.list()[0]?.status).toBe("revoked"));
  expect(h.broker.list()).toHaveLength(1);
  expect(document.body.innerHTML).not.toContain("osk_");
});

it("does not close over a key on the activation that made it", async () => {
  const h = await bed.ready();
  const { sheet, create } = await fillSheet("my-agent", "gpt-4o");
  const creating = create();
  await userEvent.dblClick(creating);
  await within(sheet).findByTestId("model-key-token");

  // Create is gone, not relabelled: nothing still pressed can land on Done.
  expect(creating.isConnected).toBe(false);
  const done = within(sheet).getByRole("button", { name: "Done" });
  expect(done).not.toBe(creating);
  // The key it made is the one thing to do next, and the double click made one.
  expect(document.activeElement).toBe(
    within(sheet).getByRole("button", { name: "Copy the key" }),
  );
  expect(h.broker.list()).toHaveLength(1);

  // A second activation straight after the key appears is ignored ...
  await userEvent.click(done);
  expect(screen.getByRole("dialog", { name: "Create a key" })).toBeTruthy();
  expect(within(sheet).getByTestId("model-key-token")).toBeTruthy();

  // ... and Done answers once the person has had the key in front of them.
  bed.afterTheGuard();
  await userEvent.click(done);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("offers the budget and the lifetime as named groups of radios the keyboard moves through", async () => {
  const h = await bed.ready();
  const { sheet, create } = await fillSheet("my-agent", "gpt-4o");
  const budget = within(sheet).getByRole("group", { name: "Budget" });
  const lasts = within(sheet).getByRole("group", { name: "Key lasts" });
  expect(
    within(budget)
      .getAllByRole<HTMLInputElement>("radio")
      .map((radio) => radio.labels?.[0]?.textContent),
  ).toEqual(["Small", "Medium", "Large"]);
  expect(
    within(lasts)
      .getAllByRole<HTMLInputElement>("radio")
      .map((radio) => radio.labels?.[0]?.textContent),
  ).toEqual(["1 hour", "8 hours"]);
  const small = within(budget).getByRole("radio", { name: "Small" });
  const medium = within(budget).getByRole("radio", { name: "Medium" });
  const large = within(budget).getByRole("radio", { name: "Large" });
  expect(small).toHaveProperty("checked", true);

  // Tab enters the group at the chosen radio, not at each of them.
  await userEvent.click(within(sheet).getByLabelText("Models"));
  await userEvent.tab();
  await userEvent.tab();
  expect(document.activeElement).toBe(small);

  // The arrows move the choice and the focus together, and the sheet says so.
  await userEvent.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(medium);
  expect(medium).toHaveProperty("checked", true);
  expect(within(sheet).getByText("200 requests")).toBeTruthy();
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(large);
  await userEvent.keyboard("{ArrowLeft}");
  expect(medium).toHaveProperty("checked", true);
  await userEvent.keyboard("{ArrowRight}");
  expect(large).toHaveProperty("checked", true);
  expect(within(sheet).getByText("1000 requests")).toBeTruthy();
  // The last wraps to the first, and back.
  await userEvent.keyboard("{ArrowRight}");
  expect(small).toHaveProperty("checked", true);
  await userEvent.keyboard("{ArrowLeft}");
  expect(large).toHaveProperty("checked", true);

  // Tab leaves for the next group, and its arrows do the same.
  await userEvent.tab();
  const hour = within(lasts).getByRole("radio", { name: "1 hour" });
  expect(document.activeElement).toBe(hour);
  await userEvent.keyboard("{ArrowRight}");
  expect(within(lasts).getByRole("radio", { name: "8 hours" })).toHaveProperty(
    "checked",
    true,
  );
  await userEvent.tab();
  expect(document.activeElement).toBe(create());

  // What the radios say is what the key is made with.
  await userEvent.click(create());
  expect(
    await within(sheet).findByLabelText("Shown once. Ends in 8 hours."),
  ).toBeTruthy();
  expect(h.broker.list()[0]?.remaining.requests).toBe(1000);
});

it("holds the choices while a key is being made", async () => {
  const h = await bed.ready();
  const release = holdMint(h);
  const { sheet, create } = await fillSheet("my-agent", "gpt-4o");
  await userEvent.click(create());
  for (const radio of within(sheet).getAllByRole("radio"))
    expect(radio.matches(":disabled")).toBe(true);
  release();
  await within(sheet).findByTestId("model-key-token");
});
