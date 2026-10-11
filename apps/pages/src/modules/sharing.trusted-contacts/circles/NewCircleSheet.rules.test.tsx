/** @vitest-environment jsdom */
import { listNotices } from "@opensesame/app-core/lib/notices.js";
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fieldValue, isDisabled } from "../trusted-contacts.test-support.js";
import { installSheetHarness, sheetKey } from "./circles.test-support.js";
import { withPeople } from "./new-circle.test-support.js";

const h = installSheetHarness();

describe("the rule", () => {
  it("is judged as it is edited: a number the desk refuses is a mark on its field, not a notice", async () => {
    const { user } = await withPeople(h.copies, ["Ada", "Ben", "Cy"]);
    await user.click(sheetKey("Set the rule"));
    const needed = await screen.findByLabelText("Needed");
    expect(fieldValue(needed)).toBe("2");
    expect(isDisabled(sheetKey("Set the clocks"))).toBe(false);

    await user.clear(needed);
    await user.type(needed, "4");
    expect(
      await screen.findByRole("img", {
        name: "Group All needs more guardians than it has.",
      }),
    ).toBeTruthy();
    expect(isDisabled(sheetKey("Set the clocks"))).toBe(true);

    await user.clear(needed);
    await user.type(needed, "1");
    expect(
      await screen.findByRole("img", {
        name: "A 1-of-N group adds no security: use one guardian.",
      }),
    ).toBeTruthy();

    await user.clear(needed);
    await user.type(needed, "two");
    expect(
      await screen.findByRole("img", {
        name: "Needed is a whole number, 1 to 16.",
      }),
    ).toBeTruthy();

    await user.clear(needed);
    await user.type(needed, "3");
    // Everyone is needed: the circle is legal, and the desk says what that costs.
    expect(
      await screen.findByRole("img", {
        name: "Group All needs everyone: one refusal or one lost key blocks recovery.",
      }),
    ).toBeTruthy();
    expect(isDisabled(sheetKey("Set the clocks"))).toBe(false);
    expect(listNotices()).toEqual([]);
  });

  it("can be two groups, each with its own number, and both needed", async () => {
    const { user } = await withPeople(h.copies, ["Ada", "Ben", "Cy", "Dee"]);
    await user.click(sheetKey("Set the rule"));
    await user.click(
      await screen.findByRole("button", { name: "Add a second group" }),
    );
    expect(fieldValue(screen.getByLabelText("Needed in group A"))).toBe("2");
    expect(fieldValue(screen.getByLabelText("Needed in group B"))).toBe("2");
    expect(
      screen.getByRole("button", { name: "2", pressed: true }),
    ).toBeTruthy();
    const ada = screen.getByRole("radiogroup", { name: "Group for Ada" });
    expect(
      within(ada).getByRole("button", { name: "A", pressed: true }),
    ).toBeTruthy();
    const dee = screen.getByRole("radiogroup", { name: "Group for Dee" });
    expect(
      within(dee).getByRole("button", { name: "B", pressed: true }),
    ).toBeTruthy();
    expect(isDisabled(sheetKey("Set the clocks"))).toBe(false);

    // Everyone in one group leaves the other with no one.
    for (const name of ["Cy", "Dee"]) {
      await user.click(
        within(
          screen.getByRole("radiogroup", { name: `Group for ${name}` }),
        ).getByRole("button", { name: "A" }),
      );
    }
    expect(
      await screen.findByRole("img", { name: "Put someone in each group." }),
    ).toBeTruthy();
    expect(isDisabled(sheetKey("Set the clocks"))).toBe(true);

    // One group again.
    await user.click(screen.getByRole("button", { name: "One group" }));
    expect(screen.queryByLabelText("Needed in group B")).toBeNull();
    expect(fieldValue(screen.getByLabelText("Needed"))).toBe("2");
    expect(isDisabled(sheetKey("Set the clocks"))).toBe(false);
  });
});

describe("a circle of approvals only", () => {
  it("is made with no payload, no recovery file and no receipts, and is armed at once", async () => {
    const { user, owner } = await withPeople(
      h.copies,
      ["Ada", "Ben"],
      "Approvals only",
    );
    await user.click(sheetKey("Set the rule"));
    expect(fieldValue(await screen.findByLabelText("Needed"))).toBe("2");
    await user.click(sheetKey("Set the clocks"));
    expect(
      await screen.findByLabelText("Hours before it takes effect"),
    ).toBeTruthy();
    await user.click(sheetKey("Make the circle"));
    await screen.findByRole("button", { name: "Copy Ada's packet" });
    expect(
      screen.queryByRole("button", { name: "Save the recovery file" }),
    ).toBeNull();
    expect(screen.queryByLabelText("A contact's receipt")).toBeNull();
    expect(screen.getByText("Armed")).toBeTruthy();
    const [circle] = await owner.records.owned();
    expect(circle?.state).toBe("armed");
    expect(circle?.signedPolicy.policy.collection).toBe("Approvals only");
    expect(circle?.signedPolicy.policy.operations).toEqual(["grant-access"]);
    // A packet is dealt, so nothing is lost by waiting; there is just no one to wait for.
    expect(
      screen.getAllByRole("button", { name: /^Copy .*'s packet$/ }),
    ).toHaveLength(2);
  });
});
