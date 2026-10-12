/** @vitest-environment jsdom */
import { changeLocalDirectory } from "@opensesame/app-core/lib/local-directory-admin.js";
import { readLocalDirectory } from "@opensesame/app-core/lib/local-directory.js";
import { localRequestFixture } from "@opensesame/app-core/lib/local-request.fixture.js";
import { lockAllTombs } from "@opensesame/app-core/lib/vfs.js";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { LocalDirectoryWorkspace } from "./LocalDirectoryWorkspace.js";

const originalVault = { ...vaultHooksSeams };
let fixture: Awaited<ReturnType<typeof localRequestFixture>>;
beforeEach(async () => {
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
  fixture = await localRequestFixture();
  Object.assign(vaultHooksSeams, {
    useVault: () => ({ ...originalVault.useVault(), tomb: fixture.tomb }),
    useVaultStore: () => ({ activeTomb: () => fixture.tomb }),
  });
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("No network permitted"),
  );
});
afterEach(() => {
  cleanup();
  lockAllTombs();
  Object.assign(vaultHooksSeams, originalVault);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function Location() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.search}
      {location.hash}
    </output>
  );
}
function open(url = "/identity?view=agents") {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <LocalDirectoryWorkspace kind="agent" />
      <Location />
    </MemoryRouter>,
  );
}

it("creates, selects, edits and deletes one agent through the vault list and buffer", async () => {
  const { container } = open();
  await waitFor(
    () =>
      expect(screen.getByRole("button", { name: "New agent" })).toHaveProperty(
        "disabled",
        false,
      ),
    { timeout: 5000 },
  );
  expect(container.querySelector(".panel")).toBeNull();
  expect(screen.queryByRole("tablist")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "New agent" }));
  await userEvent.type(await screen.findByLabelText("Name"), "Build bot");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(
    await screen.findByRole(
      "heading",
      { name: "Build bot" },
      { timeout: 5000 },
    ),
  ).toBeTruthy();
  const stored = await readLocalDirectory(fixture.tomb);
  const agent = stored.entries.find((entry) => entry.name === "Build bot");
  if (!agent) throw new Error("Expected saved agent");
  expect(screen.getByTestId("location").textContent).toContain(
    `#${encodeURIComponent(agent.id)}`,
  );
  await userEvent.click(screen.getByRole("button", { name: "Edit Build bot" }));
  const name = await screen.findByLabelText("Name");
  await userEvent.clear(name);
  await userEvent.type(name, "Release bot");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(
    await screen.findByRole(
      "heading",
      { name: "Release bot" },
      { timeout: 5000 },
    ),
  ).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(
    (await readLocalDirectory(fixture.tomb)).entries.some(
      (entry) => entry.id === agent.id,
    ),
  ).toBe(true);
  await userEvent.click(
    screen.getByRole("button", { name: "Confirm deletion" }),
  );
  await waitFor(
    () =>
      expect(screen.queryByRole("heading", { name: "Release bot" })).toBeNull(),
    { timeout: 5000 },
  );
  expect(
    (await readLocalDirectory(fixture.tomb)).entries.some(
      (entry) => entry.id === agent.id,
    ),
  ).toBe(false);
  await waitFor(() =>
    expect(screen.getByTestId("location").textContent).toBe("?view=agents"),
  );
});

it("opens an existing subtree hash as detail and keeps a malformed hash safe", async () => {
  const current = await readLocalDirectory(fixture.tomb);
  const next = await changeLocalDirectory(fixture.tomb, current.revision, {
    action: "create",
    kind: "agent",
    name: "Support bot",
  });
  const agent = next.entries.find((entry) => entry.name === "Support bot");
  if (!agent) throw new Error("Expected saved agent");
  open(`/identity?view=agents#${encodeURIComponent(agent.id)}`);
  expect(
    await screen.findByRole(
      "heading",
      { name: "Support bot" },
      { timeout: 5000 },
    ),
  ).toBeTruthy();
  cleanup();
  const { container } = open("/identity?view=agents#%E0%A4%A");
  expect(
    await screen.findByRole(
      "treeitem",
      { name: /Support bot/ },
      { timeout: 5000 },
    ),
  ).toBeTruthy();
  expect(container.querySelector(".record-workspace")).toBeTruthy();
});

it("keeps the text entered as soon as the editor receives focus", async () => {
  const current = await readLocalDirectory(fixture.tomb);
  const next = await changeLocalDirectory(fixture.tomb, current.revision, {
    action: "create",
    kind: "agent",
    name: "Fast typist",
  });
  const agent = next.entries.find((entry) => entry.name === "Fast typist");
  if (!agent) throw new Error("Expected saved agent");
  open(`/identity?view=agents#${encodeURIComponent(agent.id)}`);
  const edit = await screen.findByRole("button", { name: "Edit Fast typist" });
  await waitFor(() => expect(edit).toHaveProperty("disabled", false));
  let typed = false;
  const onFocus = (event: FocusEvent) => {
    if (
      typed ||
      !(event.target instanceof HTMLInputElement) ||
      event.target.id !== "local-identity-name"
    )
      return;
    typed = true;
    fireEvent.change(event.target, { target: { value: "Immediate rename" } });
  };
  document.addEventListener("focusin", onFocus);
  try {
    await userEvent.click(edit);
    const name = await screen.findByLabelText("Name");
    await waitFor(() =>
      expect(name).toHaveProperty("value", "Immediate rename"),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(
      await screen.findByRole("heading", { name: "Immediate rename" }),
    ).toBeTruthy();
  } finally {
    document.removeEventListener("focusin", onFocus);
  }
});
