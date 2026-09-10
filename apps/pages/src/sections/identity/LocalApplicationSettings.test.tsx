/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  configureLocalApplication,
  readLocalApplications,
} from "../../lib/local-applications.js";
import {
  type LocalDirectory,
  changeLocalDirectory,
} from "../../lib/local-directory.js";
import { mintVaultKey } from "../../lib/vault/crypto.js";
import { lockAllTombs, unlockTomb, vfsSeams } from "../../lib/vfs.js";
import { LocalApplicationSettings } from "./LocalApplicationSettings.js";

let tomb: string;
let app: string;
let directory: LocalDirectory;
beforeEach(async () => {
  tomb = `registration-ui-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  let queue = Promise.resolve();
  vi.stubGlobal("navigator", {
    locks: {
      request: <T,>(_name: string, run: () => Promise<T>) => {
        const next = queue.then(run);
        queue = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      },
    },
  });
  directory = { version: 2, revision: 0, entries: [], memberships: [] };
  for (const kind of ["person", "organization", "application"] as const)
    directory = await changeLocalDirectory(tomb, directory.revision, {
      action: "create",
      kind,
      name: kind,
    });
  const person = directory.entries.find((entry) => entry.kind === "person");
  const org = directory.entries.find((entry) => entry.kind === "organization");
  const application = directory.entries.find(
    (entry) => entry.kind === "application",
  );
  if (!person || !org || !application)
    throw new Error("Missing test directory");
  app = application.id;
  directory = await changeLocalDirectory(tomb, directory.revision, {
    action: "membership",
    organizationId: org.id,
    principalId: person.id,
    role: "owner",
  });
  await configureLocalApplication(tomb, 0, app, {
    applicationId: app,
    organizationId: org.id,
    redirectUris: ["https://rp.example.test/callback"],
    scopes: ["openid"],
  });
});
afterEach(() => {
  cleanup();
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function open() {
  render(
    <>
      <LocalApplicationSettings
        tomb={tomb}
        applicationId={app}
        directory={directory}
        disabled={false}
      />
      <button type="button">Another control</button>
    </>,
  );
  await userEvent.click(
    screen.getByText("Application registration", { exact: true }),
  );
}

it("never presents unread or failed registration data as absence", async () => {
  let rejectRead: ((error: Error) => void) | undefined;
  vi.spyOn(vfsSeams, "open").mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectRead = reject;
      }),
  );
  await open();
  await screen.findByText("Loading registration…");
  expect(
    screen.queryByText("Not registered for local application access."),
  ).toBeNull();
  if (!rejectRead) throw new Error("Missing pending read");
  const reject = rejectRead;
  await act(async () => reject(new Error("Storage failed")));
  await screen.findByRole("alert");
  expect(
    screen.queryByText("Not registered for local application access."),
  ).toBeNull();
});

it("preserves focus moved elsewhere while registration removal is pending", async () => {
  await open();
  await screen.findByRole("button", { name: "Remove registration" });
  const write = vfsSeams.writeRaw;
  let finishWrite: (() => void) | undefined;
  vi.spyOn(vfsSeams, "writeRaw").mockImplementationOnce(
    (key, value) =>
      new Promise<void>((resolve, reject) => {
        finishWrite = () => {
          void write(key, value).then(resolve, reject);
        };
      }),
  );
  await userEvent.click(
    await screen.findByRole("button", {
      name: "Remove registration",
    }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Confirm removal" }),
  );
  const elsewhere = screen.getByRole("button", { name: "Another control" });
  await userEvent.click(elsewhere);
  if (!finishWrite) throw new Error("Missing pending write");
  const finish = finishWrite;
  await act(async () => finish());
  await screen.findByText("Not registered for local application access.");
  await waitFor(() => expect(document.activeElement).toBe(elsewhere));
});

it("persists explicit scope roles without silently granting a new scope", async () => {
  await open();
  const scopes = await screen.findByLabelText(
    "Allowed scopes (space separated)",
  );
  await userEvent.clear(scopes);
  await userEvent.type(scopes, "openid records:read");
  const owner = screen.getByRole("checkbox", { name: "records:read: owner" });
  expect(owner).toHaveProperty("checked", false);
  await userEvent.click(owner);
  await userEvent.click(
    screen.getByRole("button", { name: "Save registration" }),
  );
  await waitFor(async () => {
    const saved = (await readLocalApplications(tomb)).applications[0];
    expect(saved?.scopeRoles).toContainEqual({
      scope: "records:read",
      roles: ["owner"],
    });
  });
  expect(
    screen.getByRole("checkbox", { name: "records:read: member" }),
  ).toHaveProperty("checked", false);
});
