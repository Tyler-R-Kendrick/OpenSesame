// @vitest-environment jsdom
import { listLocalShares } from "@opensesame/app-core/lib/local-share-grants.js";
import { listVaultSessions } from "@opensesame/app-core/lib/local-vault-sessions.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { expectInTray } from "../../components/tray.test-support.js";
import {
  type ConsentOwner,
  consentOwner,
} from "../../screens/local-consent-owner.test-support.js";
import { makeNote } from "../vault/section-items.test-support.js";
import { VaultSessionsPanel } from "./VaultSessionsPanel.js";

let fixture: ConsentOwner;
beforeEach(async () => {
  fixture = await consentOwner();
});
afterEach(async () => {
  await fixture.release();
});
function open() {
  render(<VaultSessionsPanel tomb={fixture.tomb} />);
}
function draft(label: string) {
  fireEvent.click(screen.getByRole("button", { name: "Start vault session" }));
  fireEvent.change(screen.getByLabelText("Session name"), {
    target: { value: label },
  });
}
async function clickAction(name: string) {
  const button = await screen.findByRole("button", { name });
  await waitFor(() => expect(button).toHaveProperty("disabled", false));
  fireEvent.click(button);
}
async function onlySession() {
  const sessions = await listVaultSessions(fixture.tomb);
  if (sessions.length !== 1 || !sessions[0])
    throw new Error("Expected one actual persisted session");
  return sessions[0];
}
it("starts, stops, restarts and starts again with actual share-grant revocation", async () => {
  open();
  draft("Family session");
  fireEvent.change(screen.getByLabelText("Grant to"), {
    target: { value: "member" },
  });
  await clickAction("Start session");
  await screen.findByRole("heading", { name: "Family session" });
  await waitFor(async () =>
    expect((await onlySession()).status).toBe("running"),
  );
  const first = await onlySession();
  expect(first).toMatchObject({ status: "running", boundTomb: fixture.tomb });
  expect(first.code).toMatch(/^[A-Z2-9]{6}$/);
  expect(
    (await listLocalShares(fixture.tomb)).some(
      (share) => share.sessionId === first.id,
    ),
  ).toBe(true);
  await clickAction("Stop session");
  await screen.findByRole("button", { name: "Start session" });
  expect((await onlySession()).status).toBe("stopped");
  expect(
    (await listLocalShares(fixture.tomb)).filter(
      (share) => share.sessionId === first.id,
    ),
  ).toHaveLength(0);
  await clickAction("Restart session");
  await screen.findByRole("button", { name: "Stop session" });
  expect(await onlySession()).toMatchObject({
    status: "running",
    code: first.code,
  });
  expect(
    (await listLocalShares(fixture.tomb)).some(
      (share) => share.sessionId === first.id,
    ),
  ).toBe(true);
  await clickAction("Stop session");
  await screen.findByRole("button", { name: "Start session" });
  await clickAction("Start session");
  await screen.findByRole("button", { name: "Stop session" });
  await waitFor(async () =>
    expect((await onlySession()).status).toBe("running"),
  );
});
it("issues only the selected item grant and excludes a deleted item from the selector", async () => {
  const item = makeNote({
    id: "itm_session_selected",
    name: "Selected confidential row",
  });
  await vaultStore.addItems([
    item,
    makeNote({
      id: "itm_session_deleted",
      name: "Deleted row",
      deletedAt: "2026-10-07T00:00:00Z",
    }),
  ]);
  open();
  draft("Selected row session");
  fireEvent.change(screen.getByLabelText("Scope"), {
    target: { value: "item" },
  });
  expect(screen.queryByRole("option", { name: "Deleted row" })).toBeNull();
  fireEvent.change(screen.getByLabelText("Row"), {
    target: { value: item.id },
  });
  fireEvent.change(screen.getByLabelText("Grant to"), {
    target: { value: "member" },
  });
  await clickAction("Start session");
  await screen.findByRole("heading", { name: "Selected row session" });
  expect((await onlySession()).grants).toEqual([
    {
      subject: { kind: "accessRole", role: "member" },
      resourceKind: "item",
      resourceId: item.id,
      resourceLabel: item.name,
      policy: "read",
    },
  ]);
});
it("does not write a session after a real lock and succeeds only on a fresh owner operation", async () => {
  open();
  draft("Locked attempt");
  await act(async () => {
    vaultStore.lock();
  });
  await clickAction("Start session");
  await expectInTray("locked");
  await act(async () => {
    await vaultStore.unlock(fixture.password);
  });
  expect(await listVaultSessions(fixture.tomb)).toEqual([]);
  expect(await listLocalShares(fixture.tomb)).toEqual([]);
  fireEvent.change(screen.getByLabelText("Session name"), {
    target: { value: "Fresh owner session" },
  });
  await clickAction("Start session");
  await screen.findByRole("heading", { name: "Fresh owner session" });
  await waitFor(async () =>
    expect((await onlySession()).status).toBe("running"),
  );
});
it("cancels a draft without issuing any share authority", async () => {
  open();
  draft("Cancelled session");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByLabelText("Session name")).toBeNull();
  expect(await listVaultSessions(fixture.tomb)).toEqual([]);
  expect(await listLocalShares(fixture.tomb)).toEqual([]);
});
