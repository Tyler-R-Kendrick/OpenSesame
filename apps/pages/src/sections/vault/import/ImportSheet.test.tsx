import { overlapCast } from "@opensesame/os-domain";
import type { Folder, VaultItem } from "@opensesame/vault-core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type VaultFixture = { current: { items: VaultItem[]; folders: Folder[] } };
const vault: VaultFixture = { current: { items: [], folders: [] } };
const applyImport = vi.hoisted(() => vi.fn());
const importSealed = vi.hoisted(() => vi.fn());

import { vaultHooksSeams } from "../../../lib/vault/hooks.js";
Object.assign(vaultHooksSeams, {
  useVault: () => vault.current,
  useVaultStore: () => ({ applyImport, importSealed }),
});

import { ImportKey } from "./ImportKey.js";

function makeFile(name: string, contents: string): File {
  const file = new File([contents], name, { type: "text/plain" });
  // jsdom's File does not implement Blob#text; the pipeline awaits it.
  Object.defineProperty(file, "text", {
    value: () => Promise.resolve(contents),
  });
  return file;
}

const BITWARDEN_JSON = JSON.stringify({
  encrypted: false,
  folders: [{ id: "fld1", name: "Work" }],
  items: [
    {
      type: 1,
      name: "Mail",
      folderId: "fld1",
      login: {
        username: "me@example.com",
        password: "s3cret",
        uris: [{ uri: "https://mail.example.com" }],
      },
    },
    {
      type: 1,
      name: "Bank",
      folderId: "fld1",
      login: { username: "me", password: "pw", uris: [] },
    },
    { type: 99, name: "Weird" },
  ],
});

const CHROME_ONE = [
  "name,url,username,password",
  "Mail,https://mail.example.com,me@example.com,s3cret",
  "",
].join("\n");

/** Press Import, then pick `file` in the OS picker the key opened. */
function pickFile(file: File) {
  const input = screen.getByLabelText("Choose a file to import");
  fireEvent.change(input, { target: { files: [file] } });
}

function renderKey() {
  return render(<ImportKey />);
}

async function preview() {
  return screen.findByRole("combobox", { name: "Read it as" });
}

function planOf(call = 0) {
  return applyImport.mock.calls[call]?.[0];
}

describe("Import key", () => {
  beforeEach(() => {
    vault.current = { items: [], folders: [] };
    applyImport.mockResolvedValue(2);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("is an icon key that opens the file picker directly", async () => {
    renderKey();
    const key = screen.getByRole("button", { name: "Import items" });
    expect(key.textContent).toBe("");
    expect(key.getAttribute("title")).toBe("Import items");
    const input = screen.getByLabelText<HTMLInputElement>(
      "Choose a file to import",
    );
    const click = vi.spyOn(input, "click");
    await userEvent.click(key);
    expect(click).toHaveBeenCalledTimes(1);
    // Nothing is read, and no sheet opens, until a file is chosen.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(input.accept).toContain(".kdbx");
  });

  it("previews a .env file and imports it into one folder", async () => {
    renderKey();
    pickFile(makeFile("app.env", "API_KEY=sk-123\nOTHER_TOKEN=abc\n"));
    expect(
      await screen.findByRole("dialog", { name: "Import items" }),
    ).toBeTruthy();
    await preview();
    expect(screen.getByText("Format").nextElementSibling?.textContent).toBe(
      ".env file",
    );
    expect(screen.getByText("Secrets")).toBeTruthy();
    expect(
      screen.getByLabelText(/Recreate the 1 folder from the export/),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: /Import 2 items/i }),
    );
    expect(applyImport).toHaveBeenCalledTimes(1);
    expect(planOf().items).toHaveLength(2);
    expect(planOf().newFolders.map((f: { name: string }) => f.name)).toEqual([
      "Imported .env",
    ]);
    expect(await screen.findByText("Imported")).toBeTruthy();
    expect(screen.getByText("2 items")).toBeTruthy();
    // The export itself is plain text, and the done card says so.
    expect(screen.getByText("plain text — delete it")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("rejects an empty file with a mark and keeps the sheet open", async () => {
    renderKey();
    const file = makeFile("empty.env", " ");
    Object.defineProperty(file, "size", { value: 0 });
    pickFile(file);
    expect(await screen.findByRole("img", { name: /empty/i })).toBeTruthy();
    expect(screen.getByText("Not read")).toBeTruthy();
    // Another file is one key away, without closing the sheet.
    expect(
      screen.getByRole("button", { name: "Choose another file" }),
    ).toBeTruthy();
  });

  it("offers a manual format choice when detection fails", async () => {
    renderKey();
    pickFile(makeFile("mystery.txt", "@@nothing recognizable@@\n"));
    expect(await screen.findByText("Not recognised")).toBeTruthy();
    expect(
      screen.getByRole("img", { name: /does not look like a \.env file/i }),
    ).toBeTruthy();
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Read it as" }),
      "env-file",
    );
    // The chosen format still cannot parse it; the file and the choice stay.
    expect(await screen.findByText("Not recognised")).toBeTruthy();
    expect(applyImport).not.toHaveBeenCalled();
  });

  it("imports a Bitwarden export and keeps its folder", async () => {
    renderKey();
    pickFile(makeFile("bitwarden.json", BITWARDEN_JSON));
    await preview();
    expect(screen.getByText("Logins")).toBeTruthy();
    expect(screen.getByText("Mail")).toBeTruthy();
    expect(screen.getByText("Bank")).toBeTruthy();
    expect(screen.getAllByText("Work").length).toBeGreaterThan(0);
    // The record the file asked to leave out is listed with its reason.
    expect(screen.getByText("1 record left out")).toBeTruthy();
    expect(screen.getByText(/Unsupported Bitwarden item type 99/)).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: /Import 2 items/i }),
    );
    expect(planOf().newFolders.map((f: { name: string }) => f.name)).toEqual([
      "Work",
    ]);
  });

  it("blocks import when everything is a duplicate, until copies are allowed", async () => {
    vault.current = {
      items: [
        overlapCast({
          id: "itm_1",
          kind: "login",
          name: "Mail",
          username: "me@example.com",
          deletedAt: null,
        }),
      ],
      folders: [],
    };
    renderKey();
    pickFile(makeFile("chrome.csv", CHROME_ONE));
    await preview();
    expect(
      screen.getByRole("img", { name: "Every item is already in this vault" }),
    ).toBeTruthy();
    expect(screen.getByText("1 by name and username")).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Nothing to import",
      }).disabled,
    ).toBe(true);
    await userEvent.click(
      screen.getByLabelText("Skip items this vault already has"),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /Import 1 item/i }),
    );
    expect(applyImport).toHaveBeenCalled();
  });

  it("marks a failed write and keeps the preview", async () => {
    applyImport.mockRejectedValue(new Error("vault is locked"));
    renderKey();
    pickFile(makeFile("app.env", "API_KEY=sk-123\n"));
    await userEvent.click(
      await screen.findByRole("button", { name: /Import 1 item/i }),
    );
    expect(
      await screen.findByRole("img", { name: "vault is locked" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Import 1 item/i })).toBeTruthy();
  });

  it("closes without writing anything", async () => {
    renderKey();
    pickFile(makeFile("app.env", "API_KEY=sk-123\n"));
    await preview();
    const sheet = screen.getByRole("dialog", { name: "Import items" });
    await userEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(applyImport).not.toHaveBeenCalled();
  });

  it("switches to unfiled items when No folders is chosen", async () => {
    renderKey();
    pickFile(makeFile("bitwarden.json", BITWARDEN_JSON));
    await preview();
    await userEvent.click(screen.getByLabelText("No folders"));
    await userEvent.click(
      screen.getByRole("button", { name: /Import 2 items/i }),
    );
    expect(planOf().newFolders).toHaveLength(0);
    expect(planOf().items[0]?.folderId).toBeNull();
  });

  it("gathers folderless exports into one named folder", async () => {
    renderKey();
    pickFile(makeFile("chrome.csv", CHROME_ONE));
    await preview();
    expect(screen.getByLabelText("Leave them unfiled")).toBeTruthy();
    const input = screen.getByLabelText<HTMLInputElement>("Folder name");
    expect(input.value).toBe("Imported from your browser");
    await userEvent.clear(input);
    await userEvent.type(input, "From Chrome");
    await userEvent.click(
      screen.getByRole("button", { name: /Import 1 item/i }),
    );
    expect(planOf().newFolders.map((f: { name: string }) => f.name)).toEqual([
      "From Chrome",
    ]);
  });
});

describe("Import sheet edge branches", () => {
  beforeEach(() => {
    vault.current = { items: [], folders: [] };
    applyImport.mockResolvedValue(2);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("caps the preview at 60 rows", async () => {
    renderKey();
    const lines = ["name,url,username,password"];
    for (let i = 0; i < 65; i += 1) {
      lines.push(`Site ${i},https://s${i}.example.com,u${i},pw${i}`);
    }
    pickFile(makeFile("chrome.csv", `${lines.join("\n")}\n`));
    await preview();
    expect(screen.getByText("first 60 of 65")).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(61);
  });

  it("collapses the folder name when folders are kept", async () => {
    renderKey();
    pickFile(makeFile("bitwarden.json", BITWARDEN_JSON));
    await preview();
    await userEvent.click(
      screen.getByLabelText("Put everything in one new folder"),
    );
    expect(screen.getByLabelText("Folder name")).toBeTruthy();
    await userEvent.click(screen.getByLabelText(/Recreate the 1 folder/));
    expect(screen.queryByLabelText("Folder name")).toBeNull();
  });

  it("counts logins without a password", async () => {
    renderKey();
    const csv =
      "name,url,username,password\nMail,https://m.example.com,me,\nBank,https://b.example.com,me,pw\n";
    pickFile(makeFile("chrome.csv", csv));
    await preview();
    expect(screen.getByText("Logins without a password")).toBeTruthy();
  });

  it("re-reading as another format marks the failure", async () => {
    renderKey();
    pickFile(makeFile("app.env", "API_KEY=sk-123\n"));
    await preview();
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Read it as" }),
      "chromium-csv",
    );
    expect(await screen.findAllByRole("img")).not.toHaveLength(0);
    expect(applyImport).not.toHaveBeenCalled();
  });

  it("restores an OpenSesame backup with its master password", async () => {
    importSealed.mockResolvedValue(3);
    renderKey();
    const backup = JSON.stringify({
      format: "opensesame-offline-backup",
      v: 1,
      projectId: null,
      exportedAt: "2026-09-27T00:00:00.000Z",
      vault: {
        header: { v: 1, createdAt: "2026-09-01T00:00:00.000Z" },
        body: { ivB64: "aXY=", ctB64: "Y3Q=" },
      },
      syncBlobs: [],
      deploymentSealUsed: false,
    });
    pickFile(makeFile("opensesame-offline-backup.json", backup));
    const field =
      await screen.findByLabelText<HTMLInputElement>("Master password");
    expect(screen.getByText("OpenSesame encrypted backup")).toBeTruthy();
    await userEvent.type(field, "correct horse");
    await userEvent.click(
      screen.getByRole("button", { name: "Restore items" }),
    );
    expect(importSealed).toHaveBeenCalledTimes(1);
    const [text, password] = importSealed.mock.calls[0] ?? [];
    expect(JSON.parse(String(text)).format).toBe("opensesame-vault-export");
    expect(JSON.parse(String(text)).tomb).toBe("personal");
    expect(password).toBe("correct horse");
    expect(await screen.findByText("Restored")).toBeTruthy();
    expect(screen.getByText("3 items")).toBeTruthy();
  });

  it("marks a wrong backup password and empties the field", async () => {
    importSealed.mockRejectedValue(new Error("Wrong password."));
    renderKey();
    const backup = JSON.stringify({
      format: "opensesame-vault-export",
      v: 1,
      tomb: "personal",
      header: { v: 1, createdAt: "2026-09-01T00:00:00.000Z" },
      body: { ivB64: "aXY=", ctB64: "Y3Q=" },
    });
    pickFile(makeFile("vault.json", backup));
    const field =
      await screen.findByLabelText<HTMLInputElement>("Master password");
    await userEvent.type(field, "nope");
    await userEvent.click(
      screen.getByRole("button", { name: "Restore items" }),
    );
    expect(
      await screen.findByRole("img", { name: "Wrong password." }),
    ).toBeTruthy();
    expect(field.value).toBe("");
  });
});
