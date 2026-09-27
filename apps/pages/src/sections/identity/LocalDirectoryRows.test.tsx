import * as accessBootstrap from "@opensesame/app-core/lib/local-access-bootstrap.js";
import { changeLocalDirectory } from "@opensesame/app-core/lib/local-directory-admin.js";
import { readLocalDirectory } from "@opensesame/app-core/lib/local-directory.js";
import { notifyLocalIamChange } from "@opensesame/app-core/lib/local-iam-events.js";
import { localRequestFixture } from "@opensesame/app-core/lib/local-request.fixture.js";
import { lockAllTombs } from "@opensesame/app-core/lib/vfs.js";
/** @vitest-environment jsdom */
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { LocalDirectoryPanel } from "./LocalDirectoryPanel.js";

const originalVault = { ...vaultHooksSeams };
// Every change here is a real encrypted write; alongside other suites it can
// take longer than waitFor's one-second default.
const SEALED_WRITE = { timeout: 5_000 };
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

async function addPerson(name: string) {
  const current = await readLocalDirectory(fixture.tomb);
  await changeLocalDirectory(fixture.tomb, current.revision, {
    action: "create",
    kind: "person",
    name,
  });
}

function openPeople() {
  return render(
    <MemoryRouter>
      <LocalDirectoryPanel kind="person" />
    </MemoryRouter>,
  );
}

async function rowOf(name: string) {
  const row = (await screen.findByRole("heading", { level: 3, name })).closest(
    "li",
  );
  if (!row) throw new Error(`expected the ${name} row`);
  return row;
}

it("arms delete, keeps focus on keep, and lands focus on the add key once the row leaves", async () => {
  await addPerson("Temp person");
  openPeople();
  const row = await rowOf("Temp person");

  const remove = within(row).getByRole("button", { name: "Delete" });
  await waitFor(
    () => expect(remove).toHaveProperty("disabled", false),
    SEALED_WRITE,
  );
  await userEvent.click(remove);
  expect(remove.className).toContain("is-armed");
  expect(remove.getAttribute("aria-label")).toBe("Confirm deletion");
  await userEvent.click(
    within(row).getByRole("button", { name: "Keep person" }),
  );
  expect(document.activeElement).toBe(remove);
  expect(remove.className).not.toContain("is-armed");

  await userEvent.click(remove);
  await userEvent.click(
    within(row).getByRole("button", { name: "Confirm deletion" }),
  );
  await waitFor(
    () =>
      expect(
        screen.queryByRole("heading", { level: 3, name: "Temp person" }),
      ).toBeNull(),
    SEALED_WRITE,
  );
  await waitFor(
    () =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "New person" }),
      ),
    SEALED_WRITE,
  );
  const stored = await readLocalDirectory(fixture.tomb);
  expect(stored.entries.some((entry) => entry.name === "Temp person")).toBe(
    false,
  );
});

it("reports a refused delete and keeps the row", async () => {
  openPeople();
  const row = await rowOf("Test person");
  const remove = within(row).getByRole("button", { name: "Delete" });
  // The keys open once the panel's first seed has landed.
  await waitFor(
    () => expect(remove).toHaveProperty("disabled", false),
    SEALED_WRITE,
  );
  await userEvent.click(remove);
  await userEvent.click(
    within(row).getByRole("button", { name: "Confirm deletion" }),
  );
  // Read every alert: a second one (the seed's own) can share the panel
  // for a moment, and a single-match query would throw on it.
  await waitFor(
    () =>
      expect(
        screen
          .getAllByRole("alert")
          .map((alert) => alert.textContent)
          .join(" "),
      ).toMatch(/last owner/),
    SEALED_WRITE,
  );
  expect(
    screen.getByRole("heading", { level: 3, name: "Test person" }),
  ).toBeTruthy();
});

it("keeps a row's keys shut until the panel's first seed has landed", async () => {
  // The seed's write notifies, so the rows are drawn from a snapshot the
  // seed is about to replace; a change on it would be refused as "changed
  // in another tab". Hold the seed there on purpose.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(accessBootstrap, "ensureDefaultAccess").mockImplementation(
    async () => {
      // After the panel has subscribed, as a real seed's write would be.
      await Promise.resolve();
      notifyLocalIamChange();
      await held;
    },
  );
  openPeople();
  const row = await rowOf("Test person");
  const remove = within(row).getByRole("button", { name: "Delete" });
  expect(remove).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "New person" })).toHaveProperty(
    "disabled",
    true,
  );
  release();
  await waitFor(
    () => expect(remove).toHaveProperty("disabled", false),
    SEALED_WRITE,
  );
  expect(screen.queryAllByRole("alert")).toHaveLength(0);
});
