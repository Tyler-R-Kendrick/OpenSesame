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

it("shares the already-selected item with a chosen identity", async () => {
  const onSave = vi.fn();
  render(
    <ShareGrantForm
      identities={[{ id: "person-1", name: "Alice", kind: "person" }]}
      scopes={scopes}
      initialKind="item"
      initialResourceId="item-1"
      busy={false}
      onCancel={() => undefined}
      onSave={onSave}
    />,
  );
  expect(screen.queryByLabelText("Resource")).toBeNull();
  expect(screen.queryByLabelText("Item")).toBeNull();
  await userEvent.selectOptions(screen.getByLabelText("Identity"), "person-1");
  await userEvent.click(screen.getByRole("button", { name: "Grant" }));
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({
      principalId: "person-1",
      resourceKind: "item",
      resourceId: "item-1",
      resourceLabel: "Work / API key",
    }),
  );
});

it("does not fall back to another item when the requested item is unavailable", () => {
  render(
    <ShareGrantForm
      identities={[{ id: "person-1", name: "Alice", kind: "person" }]}
      scopes={scopes}
      initialKind="item"
      initialResourceId="missing-item"
      busy={false}
      onCancel={() => undefined}
      onSave={() => undefined}
    />,
  );
  expect(
    screen.getByText(
      /That item is no longer available to share\. Choose another item or resource\./,
    ),
  ).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Grant" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

it("disambiguates duplicate identity names with distinct option labels", async () => {
  const onSave = vi.fn();
  render(
    <ShareGrantForm
      identities={[
        { id: "person-1", name: "Alice", kind: "person" },
        { id: "person-2", name: "Alice", kind: "person" },
      ]}
      scopes={scopes}
      busy={false}
      onCancel={() => undefined}
      onSave={onSave}
    />,
  );
  const options = screen.getByLabelText("Identity").querySelectorAll("option");
  expect([...options].map((option) => option.textContent)).toEqual([
    "Choose an identity",
    "Alice (person-1)",
    "Alice (person-2)",
  ]);
  await userEvent.selectOptions(screen.getByLabelText("Identity"), "person-2");
  await userEvent.click(screen.getByRole("button", { name: "Grant" }));
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({ principalId: "person-2" }),
  );
});

it("requests approval for an application folder grant and for an agent item grant", async () => {
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
  await userEvent.selectOptions(screen.getByLabelText("Identity"), "app-1");
  await userEvent.selectOptions(screen.getByLabelText("Resource"), "Folder");
  await userEvent.selectOptions(screen.getByLabelText("Folder"), "Work");
  await userEvent.selectOptions(screen.getByLabelText("Policy"), "Read");
  await userEvent.click(
    screen.getByRole("button", { name: "Request approval" }),
  );
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({
      principalId: "app-1",
      resourceKind: "folder",
      resourceId: "fold-1",
      resourceLabel: "Work",
      policy: "read",
    }),
  );

  await userEvent.selectOptions(screen.getByLabelText("Identity"), "agent-1");
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
