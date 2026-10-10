/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { who } from "@opensesame/app-core/lib/quorum/desk/harness.test-support.js";
import { DeskError } from "@opensesame/app-core/lib/quorum/desk/index.js";
import {
  approvalsPacket,
  approveRequest,
  ingest,
  listRecoveries,
  releaseShare,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { RecoveryPanel } from "./RecoveryPanel.js";
import {
  AFTER_THE_DELAY,
  CXF,
  PASSWORD,
  type Recovering,
  readBlob,
  recovering,
  released,
} from "./recovery/recovery.test-support.js";
import {
  declareTargets,
  deskOf,
  serveDesk,
} from "./trusted-contacts.test-support.js";

/**
 * Opening a recovery does not end it. The document it opened is held in the
 * panel until it is in a file or in the vault; only then is the recovery
 * over, and until then a reload finds it again, complete, ready to open.
 */

const original = { ...vaultHooksSeams };
const applyImport = vi.fn(async () => 1);
let undeclare: () => void;
let unserve: () => void = () => undefined;
let saved: Blob[];

beforeEach(() => {
  undeclare = declareTargets();
  saved = [];
  applyImport.mockClear();
  URL.createObjectURL = vi.fn((blob: Blob) => {
    saved.push(blob);
    return "blob:recovered";
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
    () => undefined,
  );
  Object.defineProperty(File.prototype, "text", {
    configurable: true,
    value(this: Blob) {
      return readBlob(this);
    },
  });
  Object.assign(vaultHooksSeams, {
    useVault: () => ({ items: [], folders: [] }),
    useVaultStore: () => ({ applyImport, importSealed: async () => 0 }),
  });
});

afterEach(() => {
  cleanup();
  unserve();
  undeclare();
  clearNotices();
  vi.restoreAllMocks();
  Object.assign(vaultHooksSeams, original);
});

async function serve(env: Recovering) {
  unserve();
  unserve = serveDesk(await deskOf(env.recipient));
}

const key = (name: string) => screen.getByRole("button", { name });
const pending = (env: Recovering) => env.recipient.pending.list("recovery:");

/** A recovery with everything in, opened from its row in the panel. */
async function opened() {
  const env = await recovering({ payload: CXF });
  await released(env);
  await serve(env);
  const view = render(<RecoveryPanel />);
  await openFromRow();
  return { env, view };
}

/** Press the row's key and then the sheet's, and wait for the items to come back. */
async function openFromRow() {
  await userEvent.click(
    await screen.findByRole("button", { name: "Open Family recovery" }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Open the recovery" }),
  );
  await screen.findByRole("button", { name: "Save the recovered items" });
}

describe("what a recovery handed back", () => {
  it("is kept as a row with two ways out, the keyboard on the first, and nothing of it drawn", async () => {
    const { env } = await opened();
    const save = key("Save the recovered items");
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(save));
    const row = save.closest("li");
    if (!row) throw new Error("no row");
    expect(within(row).getByRole("heading", { level: 3 }).textContent).toBe(
      "Family",
    );
    expect(
      within(row).getByRole("img", { name: "Not saved yet" }),
    ).toBeTruthy();
    expect(
      within(row).getByRole("button", { name: "Put them in this vault" }),
    ).toBeTruthy();
    // The recovery is shown once, as its items, and it is not over: its key is still here.
    expect(
      screen.queryByRole("button", { name: "Open Family recovery" }),
    ).toBeNull();
    expect(await pending(env)).toHaveLength(1);
    expect(document.body.innerHTML).not.toContain(PASSWORD);
    expect(document.body.textContent).not.toContain("Recovered bank");
  });

  it("lands the keyboard on the items even when the recovery was started in the same sitting", async () => {
    const env = await recovering({ payload: CXF });
    await env.recipient.pending.remove(`recovery:${env.started.requestId}`);
    await serve(env);
    render(<RecoveryPanel />);
    await screen.findByRole("img", { name: "No recoveries in progress." });
    await userEvent.click(key("Start a recovery"));
    const dialog = await screen.findByRole("dialog", {
      name: "Start a recovery",
    });
    const input = dialog.querySelector("input[type=file]");
    if (!(input instanceof HTMLInputElement)) throw new Error("no file input");
    await userEvent.upload(
      input,
      new File([env.bundleText], "family.json", { type: "application/json" }),
    );
    await within(dialog).findByText("Family");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Send the request" }),
    );
    await screen.findByRole("dialog", { name: "Family recovery" });
    // While the sheet is open the contacts answer, and the delay passes.
    const [fresh] = await listRecoveries(env.recipient);
    if (!fresh) throw new Error("no recovery");
    for (const name of ["Ada", "Cy"]) {
      await ingest(
        env.recipient,
        fresh.requestId,
        await approveRequest(who(env.armed, name), fresh.request),
      );
    }
    env.clock.at(AFTER_THE_DELAY);
    const approvals = await approvalsPacket(env.recipient, fresh.requestId);
    for (const name of ["Ada", "Cy"]) {
      await ingest(
        env.recipient,
        fresh.requestId,
        await releaseShare(who(env.armed, name), {
          request: fresh.request,
          approvals,
        }),
      );
    }
    await userEvent.click(key("Check the status"));
    await userEvent.click(
      await screen.findByRole("button", { name: "Open the recovery" }),
    );
    // The sheet gave the keyboard back to the key that opened it, which is still
    // there; what is left to do is on the items' row.
    const save = await screen.findByRole("button", {
      name: "Save the recovered items",
    });
    await waitFor(() => expect(document.activeElement).toBe(save));
  });

  it("is found again after a reload, complete, and opens to the same document", async () => {
    const { env, view } = await opened();
    view.unmount();
    // A new page over the same stores.
    await serve(env);
    render(<RecoveryPanel />);
    const row = (
      await screen.findByRole("heading", { level: 3, name: "Family" })
    ).closest("li");
    if (!row) throw new Error("no row");
    expect(within(row).getByRole("img", { name: "Complete" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Save the recovered items" }),
    ).toBeNull();
    await openFromRow();
    await userEvent.click(key("Save the recovered items"));
    expect(JSON.parse(await readBlob(saved[0] ?? new Blob([])))).toEqual(CXF);
  });

  it("is saved as a file, and only then is the recovery ended: a reload after finds nothing", async () => {
    const { env, view } = await opened();
    expect(saved).toHaveLength(0);
    await userEvent.click(key("Save the recovered items"));
    expect(saved).toHaveLength(1);
    expect(JSON.parse(await readBlob(saved[0] ?? new Blob([])))).toEqual(CXF);
    expect(
      await screen.findByRole("img", { name: "Saved to a file" }),
    ).toBeTruthy();
    await waitFor(async () => expect(await pending(env)).toEqual([]));
    // The row stays for the sitting, so a cancelled save dialog is not the end.
    await userEvent.click(key("Save the recovered items"));
    expect(saved).toHaveLength(2);
    expect(document.body.innerHTML).not.toContain(PASSWORD);

    view.unmount();
    await serve(env);
    render(<RecoveryPanel />);
    await screen.findByRole("img", { name: "No recoveries in progress." });
  });

  it("is put in the vault through the Import sheet, and the recovery ends only once it is imported", async () => {
    const { env, view } = await opened();
    const put = key("Put them in this vault");
    await userEvent.click(put);
    const sheet = await screen.findByRole("dialog", { name: "Import items" });
    expect(
      await screen.findByRole("combobox", { name: "Read it as" }),
    ).toBeTruthy();
    expect(within(sheet).getByText("recovered-Family.json")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(PASSWORD);
    // Reading it is not importing it: the recovery is still here.
    expect(await pending(env)).toHaveLength(1);

    await userEvent.click(
      within(sheet).getByRole("button", { name: /^Import 1 item/i }),
    );
    await screen.findByText("Imported");
    expect(applyImport).toHaveBeenCalledTimes(1);
    await waitFor(async () => expect(await pending(env)).toEqual([]));
    await userEvent.click(within(sheet).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      await screen.findByRole("img", { name: "Put in this vault" }),
    ).toBeTruthy();
    expect(document.activeElement).toBe(put);

    view.unmount();
    await serve(env);
    render(<RecoveryPanel />);
    await screen.findByRole("img", { name: "No recoveries in progress." });
  });

  it("is not ended by closing the Import sheet without importing", async () => {
    const { env } = await opened();
    await userEvent.click(key("Put them in this vault"));
    await screen.findByRole("combobox", { name: "Read it as" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(applyImport).not.toHaveBeenCalled();
    expect(await pending(env)).toHaveLength(1);
    expect(screen.getByRole("img", { name: "Not saved yet" })).toBeTruthy();
  });

  it("says so, on the row and in the tray, when the recovery could not be ended, and keeps the items", async () => {
    const env = await recovering({ payload: CXF });
    await released(env);
    const ports = {
      ...env.recipient,
      pending: {
        ...env.recipient.pending,
        remove: async () => {
          throw new DeskError("sealed", "the recovery could not be ended");
        },
      },
    };
    unserve();
    unserve = serveDesk({ ...(await deskOf(env.recipient)), ports });
    render(<RecoveryPanel />);
    await openFromRow();
    await userEvent.click(key("Save the recovered items"));
    await screen.findByRole("img", {
      name: "The recovery could not be ended.",
    });
    expect(
      listNotices().some((n) => n.id === "trusted-contacts:recovery-finish"),
    ).toBe(true);
    expect(document.body.textContent).not.toContain("could not be ended");
    expect(await pending(env)).toHaveLength(1);
    expect(key("Save the recovered items")).toBeTruthy();
  });

  it("is forgotten by the page when the vault locks, and the recovery is still there to open", async () => {
    const { env, view } = await opened();
    unserve();
    unserve = serveDesk(null);
    view.rerender(<RecoveryPanel />);
    expect(view.container.textContent).toBe("");
    // Unlocked again: nothing held in memory, but the recovery itself is on the device.
    unserve();
    unserve = serveDesk(await deskOf(env.recipient));
    view.rerender(<RecoveryPanel />);
    expect(
      await screen.findByRole("button", { name: "Open Family recovery" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Save the recovered items" }),
    ).toBeNull();
    expect(document.body.innerHTML).not.toContain(PASSWORD);
  });
});
