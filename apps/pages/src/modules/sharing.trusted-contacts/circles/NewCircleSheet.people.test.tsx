/** @vitest-environment jsdom */
import { listNotices } from "@opensesame/app-core/lib/notices.js";
import { device } from "@opensesame/app-core/lib/quorum/desk/harness.test-support.js";
import {
  beginCircle,
  unfinishedCircle,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  deskOf,
  elementById,
  fieldValue,
  isDisabled,
} from "../trusted-contacts.test-support.js";
import { NewCircleSheet } from "./NewCircleSheet.js";
import {
  addContact,
  answer,
  contacts,
  installSheetHarness,
  sheetKey,
  startCircle,
} from "./circles.test-support.js";
import { openNewCircle, withPeople } from "./new-circle.test-support.js";

const h = installSheetHarness();

describe("the people who answer", () => {
  it("says at once when a paste is not an answer, and takes it back without a word in the tray", async () => {
    const { user } = await openNewCircle();
    const invite = await startCircle(user, h.copies, "Family");
    await user.click(screen.getByLabelText("A contact's answer"));
    await user.paste(invite);
    expect(
      await screen.findByRole("img", {
        name: "This is an invite, not an enrollment.",
      }),
    ).toBeTruthy();
    expect(isDisabled(sheetKey("Add this contact"))).toBe(true);
    expect(listNotices()).toEqual([]);
  });

  it("refuses the same person twice, on the field and in the tray, and keeps the paste", async () => {
    const { user, clock } = await openNewCircle();
    const invite = await startCircle(user, h.copies, "Family");
    const ada = contacts(clock, ["Ada"]).get("Ada");
    if (!ada) throw new Error("no device");
    const enrollment = await answer(ada, invite, "Ada");
    await user.click(screen.getByLabelText("A contact's answer"));
    await user.paste(enrollment);
    await user.click(sheetKey("Add this contact"));
    await screen.findByRole("img", { name: "Ada has answered" });

    await user.click(screen.getByLabelText("A contact's answer"));
    await user.paste(enrollment);
    await user.click(sheetKey("Add this contact"));
    const refused = await screen.findByRole("img", {
      name: "Ada is already in this circle.",
    });
    expect(refused).toBeTruthy();
    expect(fieldValue(screen.getByLabelText("A contact's answer"))).toBe(
      enrollment,
    );
    await waitFor(() =>
      expect(
        listNotices().find((n) => n.id === "trusted-contacts:tcc-enrollment")
          ?.body,
      ).toBe("Ada is already in this circle."),
    );
    // Nothing is drawn as text: the sentence is a mark's label and a notice.
    expect(
      within(screen.getByRole("dialog")).queryByText(/already in this circle/),
    ).toBeNull();
  });

  it("refuses an answer to another circle's invitation", async () => {
    const { user, clock } = await openNewCircle();
    await startCircle(user, h.copies, "Family");
    const stranger = device(clock);
    const strangerInvite = (
      await beginCircle(device(clock), {
        label: "Elsewhere",
        collection: "Everything",
        recovers: true,
      })
    ).invite;
    const enrollment = await answer(stranger, strangerInvite, "Mal");
    await user.click(screen.getByLabelText("A contact's answer"));
    await user.paste(enrollment);
    await user.click(sheetKey("Add this contact"));
    await waitFor(() =>
      expect(
        listNotices().some((n) => n.id === "trusted-contacts:tcc-enrollment"),
      ).toBe(true),
    );
    expect(screen.queryByRole("img", { name: "Mal has answered" })).toBeNull();
    expect(
      within(screen.getByRole("dialog")).queryByRole("list", {
        name: "Contacts",
      }),
    ).toBeNull();
  });

  it("names a household two contacts share, and lets a contact go, with the keyboard landing on the field", async () => {
    const { user, clock, owner, view } = await openNewCircle();
    const invite = await startCircle(user, h.copies, "Family");
    const devices = contacts(clock, ["Ada", "Ben"]);
    await addContact(
      user,
      invite,
      "Ada",
      devices.get("Ada") ?? device(clock),
      "The Smiths",
    );
    await addContact(
      user,
      invite,
      "Ben",
      devices.get("Ben") ?? device(clock),
      "the smiths",
    );
    const draft = await unfinishedCircle(owner);
    expect(new Set(draft?.guardians.map((g) => g.custodyDomain))).toEqual(
      new Set(["home-the-smiths"]),
    );
    await user.click(sheetKey("Remove Ada"));
    await waitFor(() =>
      expect(
        screen.queryByRole("img", { name: "Ada has answered" }),
      ).toBeNull(),
    );
    expect(screen.getByRole("img", { name: "Ben has answered" })).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(elementById("tcc-enrollment")),
    );
    view.unmount();
  });
});

describe("going back", () => {
  it("returns to People from the strip, takes another contact, and starts the rule over for the new people", async () => {
    const { user, invite, clock } = await withPeople(h.copies, [
      "Ada",
      "Ben",
      "Cy",
    ]);
    await user.click(sheetKey("Set the rule"));
    await screen.findByLabelText("Needed");
    const strip = screen.getByRole("list", { name: "Steps" });
    expect(
      within(strip)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["People", "Rule"]);
    await user.click(within(strip).getByRole("button", { name: "People" }));
    await screen.findByLabelText("A contact's answer");
    await addContact(user, invite, "Dee", device(clock));
    await user.click(sheetKey("Set the rule"));
    expect(fieldValue(await screen.findByLabelText("Needed"))).toBe("2");
    await user.click(
      screen.getByRole("button", { name: "Add a second group" }),
    );
    expect(
      screen.getByRole("radiogroup", { name: "Group for Dee" }),
    ).toBeTruthy();
  });
});

describe("a circle that was begun and left", () => {
  it("is picked up where it stopped, with the people who answered, and let go once nobody is in it", async () => {
    const first = await withPeople(h.copies, ["Ada"]);
    first.view.unmount();
    cleanup();
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <NewCircleSheet desk={await deskOf(first.owner)} onClose={onClose} />,
    );
    expect(
      await screen.findByRole("button", { name: "Copy invitation" }),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Name")).toBeNull();
    // It says which circle it is, since the name was typed before.
    expect(screen.getByText("Family")).toBeTruthy();
    expect(screen.getByText("Everything")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Ada has answered" })).toBeTruthy();
    // The same invitation, not a new one.
    await user.click(screen.getByRole("button", { name: "Copy invitation" }));
    await waitFor(() => expect(h.copies.at(-1)).toBe(first.invite));
    // Leaving with a contact in it keeps it.
    await user.click(sheetKey("Close"));
    expect(onClose).toHaveBeenCalled();
    expect(await unfinishedCircle(first.owner)).not.toBeNull();
  });
});
