/** @vitest-environment jsdom */
import * as local from "@opensesame/app-core/lib/secret-backends/local.js";
import type { SecretBackend } from "@opensesame/app-core/lib/secret-backends/types.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OnePasswordSaveButton } from "./OnePasswordSaveButton.js";

const locks = new Set<() => void>();
let origin = "";
function backend(): SecretBackend {
  return {
    id: "local",
    name: "Local vault",
    capabilities: {
      list: true,
      get: true,
      create: true,
      update: true,
      delete: true,
      import: false,
    },
    authenticate: vi.fn(async () => ({
      id: "local-session",
      backendId: "local",
      authenticatedAt: "",
    })),
    listItems: vi.fn<SecretBackend["listItems"]>(async () => [
      { id: "login-one", name: "Local login", kind: "login" },
    ]),
    getItem: vi.fn<SecretBackend["getItem"]>(async () => ({
      id: "login-one",
      name: "Local login",
      kind: "login",
      username: "person",
      secret: "selected-password",
      notes: "selected-notes",
      url: origin,
    })),
    getNotes: vi.fn(async () => "selected-notes"),
    disconnect: vi.fn(async () => undefined),
  };
}
beforeEach(() => {
  locks.clear();
  origin = window.location.origin;
  vi.spyOn(local, "createLocalVaultBackend").mockReturnValue(backend());
  vi.spyOn(vaultStore, "onLock").mockImplementation((handler) => {
    locks.add(handler);
    return () => locks.delete(handler);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function selectLogin() {
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: "List local logins for 1Password" }),
  );
  await screen.findByRole("option", { name: "Local login" });
  await user.selectOptions(screen.getByLabelText("Local login"), "login-one");
  return user;
}

it("loads the real official component only after explicit selection and preparation, and clears secret attributes on close", async () => {
  const activate = vi.fn();
  document.addEventListener("OPButtonAdded", activate);
  const view = render(<OnePasswordSaveButton onFlash={vi.fn()} />);
  expect(document.querySelector("onepassword-save-button")).toBeNull();
  const user = await selectLogin();
  expect(document.querySelector("onepassword-save-button")).toBeNull();
  await user.click(
    screen.getByRole("button", {
      name: "Prepare official 1Password save button",
    }),
  );
  await screen.findByRole("img", { name: "1Password save button prepared" });
  const element = document.querySelector("onepassword-save-button");
  if (!element) throw new Error("Official custom element missing");
  expect(element.getAttribute("data-onepassword-type")).toBe("login");
  const encoded = element.getAttribute("value");
  if (!encoded) throw new Error("Official save request missing");
  expect(JSON.parse(atob(encoded))).toEqual({
    title: "Local login",
    fields: [
      { autocomplete: "username", value: "person" },
      { autocomplete: "current-password", value: "selected-password" },
    ],
    notes: "selected-notes",
  });
  expect(activate).toHaveBeenCalledOnce();
  expect(screen.queryByRole("img", { name: "Saved in 1Password" })).toBeNull();
  view.unmount();
  expect(element.getAttribute("value")).toBeNull();
  expect(element.shadowRoot?.querySelector("[value]")).toBeNull();
  document.removeEventListener("OPButtonAdded", activate);
});

it("removes the prepared secret request on vault lock", async () => {
  render(<OnePasswordSaveButton onFlash={vi.fn()} />);
  const user = await selectLogin();
  await user.click(
    screen.getByRole("button", {
      name: "Prepare official 1Password save button",
    }),
  );
  await screen.findByRole("img", { name: "1Password save button prepared" });
  const element = document.querySelector("onepassword-save-button");
  if (!element) throw new Error("Official custom element missing");
  act(() => {
    for (const handler of locks) handler();
  });
  expect(document.querySelector("onepassword-save-button")).toBeNull();
  expect(element.getAttribute("value")).toBeNull();
  expect(screen.queryByRole("option", { name: "Local login" })).toBeNull();
});

it("rejects a different-site login instead of silently changing its saved origin", async () => {
  origin = "https://another-site.example";
  render(<OnePasswordSaveButton onFlash={vi.fn()} />);
  const user = await selectLogin();
  await user.click(
    screen.getByRole("button", {
      name: "Prepare official 1Password save button",
    }),
  );
  await screen.findByRole("img", {
    name: "The 1Password save button saves logins for this browser origin. Choose a login for this origin.",
  });
  expect(document.querySelector("onepassword-save-button")).toBeNull();
});
