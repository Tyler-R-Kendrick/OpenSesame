/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  configureLocalApplication,
  readLocalApplications,
} from "../../lib/local-applications.js";
import {
  type LocalDirectoryChange,
  changeLocalDirectory,
  readLocalDirectory,
} from "../../lib/local-directory.js";
import { mintVaultKey } from "../../lib/vault/crypto.js";
import { lockAllTombs, unlockTomb } from "../../lib/vfs.js";
import { LocalPolicyEditor } from "./LocalPoliciesPanel.js";

let tomb: string;
beforeEach(async () => {
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  tomb = `policies-ui-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  let queue = Promise.resolve();
  vi.stubGlobal("navigator", {
    locks: {
      request: <T,>(_name: string, action: () => Promise<T>) => {
        const next = queue.then(action);
        queue = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      },
    },
  });
});
afterEach(() => {
  cleanup();
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function change(command: LocalDirectoryChange) {
  return changeLocalDirectory(
    tomb,
    (await readLocalDirectory(tomb)).revision,
    command,
  );
}

async function seed() {
  for (const kind of ["person", "organization", "application"] as const)
    await change({ action: "create", kind, name: `Test ${kind}` });
  const directory = await readLocalDirectory(tomb);
  const person = directory.entries.find((entry) => entry.kind === "person");
  const org = directory.entries.find((entry) => entry.kind === "organization");
  const app = directory.entries.find((entry) => entry.kind === "application");
  if (!person || !org || !app) throw new Error("Missing policy fixture");
  await change({
    action: "membership",
    principalId: person.id,
    organizationId: org.id,
    role: "owner",
  });
  await configureLocalApplication(tomb, 0, app.id, {
    applicationId: app.id,
    organizationId: org.id,
    redirectUris: ["https://rp.example.test/callback"],
    scopes: ["openid", "records:read"],
  });
  return app;
}

it("edits the same encrypted role policy as Identity without a backend", async () => {
  const app = await seed();
  render(<LocalPolicyEditor tomb={tomb} />);
  await screen.findByRole("heading", { name: "Test application" });
  await userEvent.click(
    screen.getByText("Application registration", { exact: true }),
  );
  const owner = await screen.findByRole("checkbox", {
    name: "records:read: owner",
  });
  expect(owner).toHaveProperty("checked", false);
  owner.focus();
  await userEvent.keyboard(" ");
  await userEvent.click(
    screen.getByRole("button", { name: "Save registration" }),
  );
  await waitFor(async () =>
    expect(
      (await readLocalApplications(tomb)).applications.find(
        (row) => row.applicationId === app.id,
      )?.scopeRoles,
    ).toContainEqual({ scope: "records:read", roles: ["owner"] }),
  );
  expect(
    screen.getByRole("checkbox", { name: "records:read: member" }),
  ).toHaveProperty("checked", false);
});

it("distinguishes applications with the same name using public references", async () => {
  await seed();
  await change({
    action: "create",
    kind: "application",
    name: "Test application",
  });
  const applications = (await readLocalDirectory(tomb)).entries.filter(
    (entry) => entry.kind === "application",
  );
  render(<LocalPolicyEditor tomb={tomb} />);
  await waitFor(() =>
    expect(
      screen.getAllByRole("heading", { name: "Test application" }),
    ).toHaveLength(2),
  );
  for (const application of applications)
    expect(screen.getByText(application.id, { exact: true })).toBeTruthy();
});

it("shows a true empty state and a dash count", async () => {
  render(<LocalPolicyEditor tomb={tomb} />);
  await screen.findByText("Applications: -");
  expect(screen.getByText(/No local applications\./)).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("does not report unread locked storage as an empty policy set", async () => {
  await seed();
  lockAllTombs();
  render(<LocalPolicyEditor tomb={tomb} />);
  await screen.findByRole("alert");
  expect(screen.queryByText(/No local applications\./)).toBeNull();
});
