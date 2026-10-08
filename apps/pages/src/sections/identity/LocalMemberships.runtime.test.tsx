// @vitest-environment jsdom
import {
  type LocalDirectory,
  type LocalDirectoryChange,
  readLocalDirectory,
} from "@opensesame/app-core/lib/local-directory.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  type ConsentOwner,
  consentOwner,
} from "../../screens/local-consent-owner.test-support.js";
import { LocalMemberships } from "./LocalMemberships.js";

let fixture: ConsentOwner;
let directory: LocalDirectory;
const changed = vi.fn<(command: LocalDirectoryChange) => void>();
beforeEach(async () => {
  fixture = await consentOwner();
  directory = await readLocalDirectory(fixture.tomb);
  changed.mockClear();
});
afterEach(async () => {
  await fixture.release();
});
function Memberships({
  disabled = false,
  organizationId = fixture.organization,
}: { disabled?: boolean; organizationId?: string }) {
  const [value, setValue] = useState(directory);
  return (
    <LocalMemberships
      directory={value}
      organizationId={organizationId}
      disabled={disabled}
      onChange={async (command) => {
        changed(command);
        setValue(await fixture.change(command));
      }}
    />
  );
}
async function membership(
  principalId: string,
  organizationId = fixture.organization,
) {
  return (await readLocalDirectory(fixture.tomb)).memberships.find(
    (row) =>
      row.principalId === principalId && row.organizationId === organizationId,
  );
}
it("updates an existing member role through actual encrypted directory persistence", async () => {
  render(<Memberships />);
  fireEvent.change(screen.getByLabelText("Person or agent"), {
    target: { value: fixture.member },
  });
  fireEvent.change(screen.getByLabelText("Organization role"), {
    target: { value: "admin" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save role" }));
  await waitFor(async () =>
    expect(await membership(fixture.member)).toMatchObject({ role: "admin" }),
  );
  expect(changed).toHaveBeenCalledWith({
    action: "membership",
    organizationId: fixture.organization,
    principalId: fixture.member,
    role: "admin",
  });
});
it("requires confirmation before removal and keeps membership intact when cancellation restores focus", async () => {
  render(<Memberships />);
  const remove = screen.getAllByRole("button", { name: "Remove member" })[1];
  if (!remove) throw new Error("Missing current member control");
  fireEvent.click(remove);
  expect(changed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Keep member" }));
  expect(document.activeElement).toBe(remove);
  expect(await membership(fixture.member)).toBeDefined();
  fireEvent.click(remove);
  fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
  await waitFor(async () =>
    expect(await membership(fixture.member)).toBeUndefined(),
  );
  expect(await membership(fixture.person)).toMatchObject({ role: "owner" });
});
it("keeps an unclaimed guest and an agent at member role", async () => {
  const guest = await fixture.create("person", "Guest 7");
  const agent = await fixture.create("agent", "Automation agent");
  directory = await readLocalDirectory(fixture.tomb);
  render(<Memberships />);
  fireEvent.change(screen.getByLabelText("Person or agent"), {
    target: { value: guest },
  });
  expect(screen.getByLabelText("Organization role")).toHaveProperty(
    "disabled",
    true,
  );
  expect(screen.queryByRole("option", { name: "Owner (operator)" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add member" }));
  await waitFor(async () =>
    expect(await membership(guest)).toMatchObject({ role: "member" }),
  );
  fireEvent.change(screen.getByLabelText("Person or agent"), {
    target: { value: agent },
  });
  expect(screen.getByLabelText("Organization role")).toHaveProperty(
    "disabled",
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add member" }));
  await waitFor(async () =>
    expect(await membership(agent)).toMatchObject({ role: "member" }),
  );
});
it("does not dispatch disabled form submissions or removals", async () => {
  render(<Memberships disabled />);
  const person = screen.getByLabelText("Person or agent");
  fireEvent.change(person, { target: { value: fixture.outsider } });
  const form = person.closest("form");
  if (!form) throw new Error("Missing actual membership form");
  fireEvent.submit(form);
  expect(changed).not.toHaveBeenCalled();
  expect(await membership(fixture.outsider)).toBeUndefined();
  for (const button of screen.getAllByRole("button", { name: "Remove member" }))
    expect(button).toHaveProperty("disabled", true);
});
