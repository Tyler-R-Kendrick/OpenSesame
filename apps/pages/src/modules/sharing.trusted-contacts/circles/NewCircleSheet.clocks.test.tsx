/** @vitest-environment jsdom */
import { listNotices } from "@opensesame/app-core/lib/notices.js";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { isDisabled } from "../trusted-contacts.test-support.js";
import {
  installSheetHarness,
  openVaultWith,
  sheetKey,
  someItems,
} from "./circles.test-support.js";
import { withPeople } from "./new-circle.test-support.js";

const h = installSheetHarness();

const marks = () =>
  within(screen.getByRole("dialog"))
    .queryAllByRole("img")
    .map((m) => m.getAttribute("aria-label"));

describe("the clocks", () => {
  async function toClocks(items = someItems()) {
    h.restores.push(openVaultWith(items, []));
    const made = await withPeople(h.copies, ["Ada", "Ben", "Cy"]);
    await made.user.click(sheetKey("Set the rule"));
    await made.user.click(
      await screen.findByRole("button", { name: "Set the clocks" }),
    );
    await screen.findByLabelText("Minutes to approve");
    return made;
  }

  it("mark a number a policy cannot hold on its own field", async () => {
    const { user } = await toClocks();
    const minutes = screen.getByLabelText("Minutes to approve");
    await user.clear(minutes);
    await user.type(minutes, "0");
    expect(
      await screen.findByRole("img", { name: "Minutes is 1 to 10,080." }),
    ).toBeTruthy();
    expect(isDisabled(sheetKey("Make the circle"))).toBe(true);
    await user.clear(minutes);
    await user.type(minutes, "10");
    const days = screen.getByLabelText("Days a request lasts");
    await user.clear(days);
    await user.type(days, "200");
    expect(
      await screen.findByRole("img", { name: "Days is 1 to 120." }),
    ).toBeTruthy();
    expect(listNotices()).toEqual([]);
  });

  it("put the desk's refusal of a window longer than the request on the field it is about", async () => {
    const { user } = await toClocks();
    const days = screen.getByLabelText("Days a request lasts");
    const minutes = screen.getByLabelText("Minutes to approve");
    await user.clear(minutes);
    await user.type(minutes, "10000");
    await user.clear(days);
    await user.type(days, "1");
    expect(
      await screen.findByRole("img", {
        name: "The approval window outlasts the request.",
      }),
    ).toBeTruthy();
    expect(isDisabled(sheetKey("Make the circle"))).toBe(true);
  });

  it("warn when a key may approve by touch alone, and when there is no delay", async () => {
    const { user } = await toClocks();
    const verify = screen.getByRole("switch", {
      name: "Require a PIN or biometric",
    });
    expect(marks().some((m) => m?.includes("without a PIN"))).toBe(false);
    await user.click(verify);
    expect(verify.getAttribute("aria-checked")).toBe("false");
    expect(
      await screen.findByRole("img", {
        name: "A key can approve by touch alone, without a PIN or biometric.",
      }),
    ).toBeTruthy();
    const hours = screen.getByLabelText("Hours before a share is released");
    await user.clear(hours);
    await user.type(hours, "0");
    expect(
      await screen.findByRole("img", {
        name: "With no delay you have no time to notice and cancel a request.",
      }),
    ).toBeTruthy();
    expect(isDisabled(sheetKey("Make the circle"))).toBe(false);
  });

  it("show a circle that could not be made as a mark on the key and a notice, with nothing drawn in the page", async () => {
    // A vault with nothing in it has nothing to protect.
    const { user, owner } = await toClocks([]);
    await user.click(sheetKey("Make the circle"));
    expect(
      await screen.findByRole("img", {
        name: "There is nothing here to protect.",
      }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        listNotices().find((n) => n.id === "trusted-contacts:circle-make")
          ?.title,
      ).toBe("Start a circle"),
    );
    expect(await owner.records.owned()).toEqual([]);
    expect(
      within(screen.getByRole("dialog")).queryByText(/nothing here to protect/),
    ).toBeNull();
  });
});
