/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ShareGrantForm } from "./ShareGrantForm.js";

afterEach(() => {
  cleanup();
});

const scopes = {
  folders: [{ id: "fold-1", label: "Work" }],
  items: [{ id: "item-1", label: "Work / API key" }],
};

it("grants a folder to an application and requests approval for an item to an agent", async () => {
  const onSave = vi.fn();
  render(
    <ShareGrantForm
      identities={[
        { id: "app-1", name: "Payroll", kind: "application" },
        { id: "agent-1", name: "Helper", kind: "agent" },
      ]}
      scopes={scopes}
      busy={false}
      onCancel={() => undefined}
      onSave={onSave}
    />,
  );
  await userEvent.selectOptions(screen.getByLabelText("Identity"), "Payroll");
  await userEvent.selectOptions(screen.getByLabelText("Resource"), "Folder");
  await userEvent.selectOptions(screen.getByLabelText("Folder"), "Work");
  await userEvent.selectOptions(screen.getByLabelText("Policy"), "Read");
  await userEvent.click(screen.getByRole("button", { name: "Grant" }));
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({
      principalId: "app-1",
      resourceKind: "folder",
      resourceId: "fold-1",
      resourceLabel: "Work",
      policy: "read",
    }),
  );

  await userEvent.selectOptions(screen.getByLabelText("Identity"), "Helper");
  await userEvent.selectOptions(screen.getByLabelText("Resource"), "Item");
  await userEvent.selectOptions(
    screen.getByLabelText("Item"),
    "Work / API key",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Request approval" }),
  );
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({
      principalId: "agent-1",
      resourceKind: "item",
      resourceId: "item-1",
      resourceLabel: "Work / API key",
    }),
  );
});
