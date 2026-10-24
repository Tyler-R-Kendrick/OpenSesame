/** @vitest-environment jsdom */
import { NativeWorkerRequest } from "@opensesame/app-core/lib/secret-backends/bitwarden-native-worker-protocol.js";
import type { SecretBackendItem } from "@opensesame/app-core/lib/secret-backends/types.js";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { SecretBackendItemForm } from "./SecretBackendItemForm.js";

afterEach(cleanup);

it.each(["note", "login", "secret"] as const)(
  "submits a strict native %s update without retrieved identity or transport metadata",
  async (kind) => {
    const item = {
      id: "7453f73e-2067-45ce-8c68-7d04931687ca",
      name: "Retrieved item",
      notes: "Original notes",
      secret: "Original secret",
      kind,
      username: "Original user",
      url: "https://original.example.test",
      fields: { project: "Owned project", empty: "", unicode: "🔐" },
      transportMetadata: { revision: "retrieved-only" },
    } satisfies SecretBackendItem & {
      transportMetadata: { revision: string };
    };
    const onSave = vi.fn();
    render(
      <SecretBackendItemForm
        item={item}
        editing
        busy={false}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    for (const [label, value] of [
      ["Item name", "Edited item"],
      ["Notes", "Edited notes"],
      ...(kind === "login"
        ? [
            ["Username", "Edited user"],
            ["Website", "https://edited.example.test"],
          ]
        : []),
      ...(kind !== "note"
        ? [[kind === "login" ? "Password" : "Secret value", "Edited secret"]]
        : []),
    ]) {
      await user.clear(screen.getByLabelText(label));
      await user.type(screen.getByLabelText(label), value);
    }
    await user.click(
      screen.getByRole("button", { name: "Update backend item" }),
    );
    expect(onSave).toHaveBeenCalledTimes(1);
    const input = onSave.mock.calls[0][0];
    const request = { id: 1, type: "update", itemId: item.id, item: input };
    expect(NativeWorkerRequest.safeParse(request).success).toBe(true);
    const expected = {
      name: "Edited item",
      notes: "Edited notes",
      secret: kind === "note" ? item.secret : "Edited secret",
      kind,
      username: kind === "login" ? "Edited user" : item.username,
      url: kind === "login" ? "https://edited.example.test" : item.url,
      fields: item.fields,
    };
    expect(input).toEqual(expected);
    expect(input.fields).not.toBe(item.fields);
    expect(item.notes).toBe("Original notes");
    expect(NativeWorkerRequest.parse(request)).toEqual(request);
    for (const extra of [
      { id: item.id },
      { transportMetadata: item.transportMetadata },
    ]) {
      expect(
        NativeWorkerRequest.safeParse({
          ...request,
          item: { ...input, ...extra },
        }).success,
      ).toBe(false);
    }
    expect(
      NativeWorkerRequest.safeParse({ ...request, forged: true }).success,
    ).toBe(false);
  },
);

it("keeps new-item creation compatible with the strict native request", async () => {
  const onSave = vi.fn();
  render(
    <SecretBackendItemForm
      item={null}
      editing
      busy={false}
      onSave={onSave}
      onClose={vi.fn()}
      itemKinds={["secret"]}
    />,
  );
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Item name"), "Created secret");
  await user.type(screen.getByLabelText("Secret value"), "Created value");
  await user.click(screen.getByRole("button", { name: "Create backend item" }));
  expect(onSave).toHaveBeenCalledTimes(1);
  const item = onSave.mock.calls[0][0];
  expect(item).toEqual({
    name: "Created secret",
    notes: "",
    secret: "Created value",
    kind: "secret",
    username: "",
    url: "",
  });
  const request = { id: 1, type: "create", item };
  expect(NativeWorkerRequest.parse(request)).toEqual(request);
});
