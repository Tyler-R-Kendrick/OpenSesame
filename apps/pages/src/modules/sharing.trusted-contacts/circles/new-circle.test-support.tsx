/**
 * Opening the new-circle sheet and getting it to the step a test is about.
 */

import {
  Clock,
  type Device,
  device,
} from "@opensesame/app-core/lib/quorum/desk/harness.test-support.js";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { deskOf } from "../trusted-contacts.test-support.js";
import { NewCircleSheet } from "./NewCircleSheet.js";
import {
  addContact,
  contacts,
  sheetKey,
  startCircle,
} from "./circles.test-support.js";

export async function openNewCircle(
  clock = new Clock(),
  wrap: (owner: Device) => Device = (owner) => owner,
) {
  const owner = wrap(device(clock));
  const user = userEvent.setup();
  const onClose = vi.fn();
  const desk = await deskOf(owner);
  const view = render(<NewCircleSheet desk={desk} onClose={onClose} />);
  await screen.findByLabelText("Name");
  return { clock, owner, user, onClose, desk, view };
}

/** A circle named and invited, with these people already added. */
export async function withPeople(
  copies: readonly string[],
  names: readonly string[],
  protects?: string,
  wrap?: (owner: Device) => Device,
) {
  const opened = await openNewCircle(new Clock(), wrap);
  const invite = await startCircle(opened.user, copies, "Family", protects);
  const devices = contacts(opened.clock, names);
  for (const [name, who] of devices) {
    await addContact(opened.user, invite, name, who);
  }
  return { ...opened, invite, devices };
}

/** A circle made by the sheet, all the way to the packets it hands out. */
export async function makeCircle(
  copies: readonly string[],
  names: readonly string[],
  protects?: string,
  wrap?: (owner: Device) => Device,
) {
  const made = await withPeople(copies, names, protects, wrap);
  await made.user.click(sheetKey("Set the rule"));
  await made.user.click(
    await screen.findByRole("button", { name: "Set the clocks" }),
  );
  await made.user.click(
    await screen.findByRole("button", { name: "Make the circle" }),
  );
  await screen.findByRole("button", { name: "Copy Ada's packet" });
  return made;
}
