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

it("validates the typed identity and opens the requested item", async () => {
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
  expect((screen.getByLabelText("Resource") as HTMLSelectElement).value).toBe(
    "item",
  );
  expect((screen.getByLabelText("Item") as HTMLSelectElement).value).toBe(
    "item-1",
  );
  const identity = screen.getByLabelText("Identity");
  const grant = screen.getByRole("button", { name: "Grant" });
  await userEvent.clear(identity);
  await userEvent.type(identity, "Nobody");
  expect((grant as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("Choose an identity from the list.")).toBeTruthy();
  await userEvent.clear(identity);
  await userEvent.type(identity, "Alice");
  expect((grant as HTMLButtonElement).disabled).toBe(false);
  await userEvent.click(grant);
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
  const identity = screen.getByLabelText("Identity");
  await userEvent.clear(identity);
  await userEvent.type(identity, "Payroll");
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

  await userEvent.clear(identity);
  await userEvent.type(identity, "Helper");
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
