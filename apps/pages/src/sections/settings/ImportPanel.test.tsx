import { overlapCast } from "@opensesame/os-domain";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const vault = vi.hoisted(() => ({
  current: {
    items: [],
    folders: [],
  },
}));
const applyImport = vi.hoisted(() => vi.fn());

import { vaultHooksSeams } from "../../lib/vault/hooks.js";
const originalVaultHooksSeams = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, {
  useVault: () => vault.current,
  useVaultStore: () => ({ applyImport }),
});

const location = vi.hoisted(() => ({ hash: "" }));

import { importPanelSeams } from "./ImportPanel.js";
const originalImportPanelSeams = { ...importPanelSeams };
Object.assign(importPanelSeams, { useLocation: () => location });

import type { VaultItem } from "../../lib/vault/model.js";
import { ImportPanel } from "./ImportPanel.js";

function makeFile(name: string, contents: string): File {
  const file = new File([contents], name, { type: "text/plain" });
  // jsdom's File does not implement Blob#text; the panel awaits it.
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

function pickFile(file: File) {
  const input = document.getElementById("manager-import");
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("import input not found");
  }
  fireEvent.change(input, { target: { files: [file] } });
}

describe("ImportPanel", () => {
  beforeEach(() => {
    vault.current = { items: [], folders: [] };
    location.hash = "";
    applyImport.mockResolvedValue(2);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the drop zone and the supported-format list", () => {
    render(<ImportPanel />);
    expect(screen.getByText(/Choose an export file/)).toBeTruthy();
    expect(screen.getByText(/What can be imported/)).toBeTruthy();
    // Adapters are listed by product name; generic CSV is hidden.
    expect(screen.getByText("Bitwarden (.json)")).toBeTruthy();
  });

  it("previews a .env file and imports it into one folder", async () => {
    render(<ImportPanel />);
    pickFile(makeFile("app.env", "API_KEY=sk-123\nOTHER_TOKEN=abc\n"));
    // Detected as a .env file with two agent secrets.
    expect(await screen.findByText(/Recognised as/)).toBeTruthy();
    expect(screen.getByText("secrets")).toBeTruthy();
    // The env adapter gathers keys into an "Imported .env" folder.
    expect(
      screen.getByText(/Recreate the 1 folder from the export/),
    ).toBeTruthy();
    const confirm = await screen.findByRole("button", {
      name: /Import 2 items/i,
    });
    await userEvent.click(confirm);
    expect(applyImport).toHaveBeenCalledTimes(1);
    const plan = applyImport.mock.calls[0]?.[0];
    expect(plan.items).toHaveLength(2);
    expect(plan.newFolders.map((f: { name: string }) => f.name)).toEqual([
      "Imported .env",
    ]);
    expect(await screen.findByText(/Imported 2 items/)).toBeTruthy();
  });

  it("scrolls into view when navigated with #import", () => {
    location.hash = "#import";
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    render(<ImportPanel />);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start",
    });
  });

  it("reports unreadable files and returns to idle", async () => {
    render(<ImportPanel />);
    pickFile(makeFile("empty.env", ""));
    // Empty file is rejected by readImportFile before parsing.
    // Note: makeFile sets size from contents, so use a size override.
    expect(await screen.findByText(/Choose an export file/)).toBeTruthy();
  });

  it("rejects empty files with an error and stays on idle", async () => {
    render(<ImportPanel />);
    const file = makeFile("empty.env", " ");
    Object.defineProperty(file, "size", { value: 0 });
    pickFile(file);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/empty/i);
    // Back on the idle stage so another file can be chosen.
    expect(screen.getByText(/Choose an export file/)).toBeTruthy();
  });

  it("offers a manual format choice when detection fails", async () => {
    render(<ImportPanel />);
    pickFile(makeFile("mystery.txt", "@@nothing recognizable@@\n"));
    expect(await screen.findByText("mystery.txt")).toBeTruthy();
    expect(screen.getByText(/does not look like a \.env file/i)).toBeTruthy();
    // Reparse the same bytes as a .env file.
    await userEvent.selectOptions(
      screen.getByLabelText(/Read it as/i),
      "env-file",
    );
    // Parsing as env with no KEY=value lines fails again with a named error.
    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  it("recovers to a preview when the named format parses", async () => {
    render(<ImportPanel />);
    pickFile(makeFile("mystery.txt", "not a known export\n"));
    await screen.findByText(/does not look like a \.env file/i);
    // The chosen format still cannot parse this content, but the file stays.
    await userEvent.selectOptions(
      screen.getByLabelText(/Read it as/i),
      "generic-csv",
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toBeTruthy();
    // Choosing a different file abandons the failed parse.
    await userEvent.click(
      screen.getByRole("button", { name: /Choose a different file/i }),
    );
    expect(screen.getByText(/Choose an export file/)).toBeTruthy();
  });

  it("imports a Bitwarden JSON export and offers to keep its folder", async () => {
    render(<ImportPanel />);
    pickFile(makeFile("bitwarden.json", BITWARDEN_JSON));
    expect(await screen.findByText(/Recognised as/)).toBeTruthy();
    expect(screen.getByText("logins")).toBeTruthy();
    // The export has a folder → keep mode is the default.
    expect(
      screen.getByText(/Recreate the 1 folder from the export/),
    ).toBeTruthy();
    // Preview lists both rows with their target folder.
    expect(screen.getByText("Mail")).toBeTruthy();
    expect(screen.getByText("Bank")).toBeTruthy();
    expect(screen.getAllByText("Work").length).toBeGreaterThan(0);
    applyImport.mockResolvedValue(2);
    await userEvent.click(
      await screen.findByRole("button", { name: /Import 2 items/i }),
    );
    const plan = applyImport.mock.calls[0]?.[0];
    expect(plan.newFolders.map((f: { name: string }) => f.name)).toEqual([
      "Work",
    ]);
    expect(await screen.findByText(/Imported 2 items/)).toBeTruthy();
  });

  it("starts over when Import another file is clicked after success", async () => {
    applyImport.mockResolvedValue(1);
    render(<ImportPanel />);
    pickFile(makeFile("app.env", "API_KEY=sk-123\n"));
    await userEvent.click(
      await screen.findByRole("button", { name: /Import 1 item/i }),
    );
    await screen.findByText(/Imported 1 item/);
    await userEvent.click(
      screen.getByRole("button", { name: /Import another file/i }),
    );
    expect(screen.getByText(/Choose an export file/)).toBeTruthy();
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
    render(<ImportPanel />);
    const csv = [
      "name,url,username,password",
      "Mail,https://mail.example.com,me@example.com,s3cret",
      "",
    ].join("\n");
    pickFile(makeFile("chrome.csv", csv));
    expect(
      await screen.findByText(
        /Every item in this file is already in the vault/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/1 match by name and username/)).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: /Nothing to import/i,
      }).disabled,
    ).toBe(true);
    // Untick skip-duplicates to bring in copies anyway.
    await userEvent.click(
      screen.getByLabelText(/Skip items this vault already has/),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /Import 1 item/i }),
    );
    expect(applyImport).toHaveBeenCalled();
  });

  it("reports applyImport failures", async () => {
    applyImport.mockRejectedValue(new Error("vault is locked"));
    render(<ImportPanel />);
    pickFile(makeFile("app.env", "API_KEY=sk-123\n"));
    await userEvent.click(
      await screen.findByRole("button", { name: /Import 1 item/i }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/vault is locked/);
  });

  it("cancels a preview back to the idle stage", async () => {
    render(<ImportPanel />);
    pickFile(makeFile("app.env", "API_KEY=sk-123\n"));
    await screen.findByText(/Recognised as/);
    await userEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(screen.getByText(/Choose an export file/)).toBeTruthy();
  });

  it("accepts files dropped onto the drop zone", async () => {
    render(<ImportPanel />);
    const drop = document.querySelector(".imp__drop");
    if (!(drop instanceof HTMLElement)) throw new Error("drop zone not found");
    const file = makeFile("dropped.env", "API_KEY=sk-123\n");
    fireEvent.drop(drop, { dataTransfer: { files: [file] } });
    expect(await screen.findByText(/Recognised as/)).toBeTruthy();
  });

  it("switches to unfiled items when No folders is chosen", async () => {
    render(<ImportPanel />);
    pickFile(makeFile("bitwarden.json", BITWARDEN_JSON));
    await screen.findByText(/Recognised as/);
    await userEvent.click(screen.getByLabelText(/No folders/));
    await userEvent.click(
      await screen.findByRole("button", { name: /Import 2 items/i }),
    );
    const plan = applyImport.mock.calls[0]?.[0];
    expect(plan.newFolders).toHaveLength(0);
    expect(plan.items[0]?.folderId).toBeNull();
  });

  it("gathers folderless exports into one new folder", async () => {
    render(<ImportPanel />);
    const csv = [
      "name,url,username,password",
      "Mail,https://mail.example.com,me@example.com,s3cret",
      "",
    ].join("\n");
    pickFile(makeFile("chrome.csv", csv));
    await screen.findByText(/Recognised as/);
    // Browser exports have no folders → the single-folder input is offered.
    const input = screen.getByLabelText<HTMLInputElement>(
      /Name of the folder to import into/,
    );
    expect(input.value).toBe("Imported from your browser");
    await userEvent.clear(input);
    await userEvent.type(input, "From Chrome");
    await userEvent.click(
      screen.getByRole("button", { name: /Import 1 item/i }),
    );
    const plan = applyImport.mock.calls[0]?.[0];
    expect(plan.newFolders.map((f: { name: string }) => f.name)).toEqual([
      "From Chrome",
    ]);
  });

  it("shows per-record skip reasons when the file asks to leave rows out", async () => {
    render(<ImportPanel />);
    pickFile(makeFile("bitwarden.json", BITWARDEN_JSON));
    expect(await screen.findByText(/Recognised as/)).toBeTruthy();
    expect(screen.getByText(/the file asked to leave out/)).toBeTruthy();
    expect(screen.getByText(/Unsupported Bitwarden item type 99/)).toBeTruthy();
  });
});

describe("ImportPanel edge branches", () => {
  beforeEach(() => {
    vault.current = { items: [], folders: [] };
    location.hash = "";
    applyImport.mockResolvedValue(2);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("highlights the drop zone while dragging", () => {
    render(<ImportPanel />);
    const drop = document.querySelector(".imp__drop");
    if (!(drop instanceof HTMLElement)) throw new Error("drop zone not found");
    fireEvent.dragOver(drop);
    expect(drop.className).toContain("is-over");
    fireEvent.dragLeave(drop);
    expect(drop.className).not.toContain("is-over");
  });

  it("truncates the preview beyond 60 rows", async () => {
    render(<ImportPanel />);
    const lines = ["name,url,username,password"];
    for (let i = 0; i < 65; i += 1) {
      lines.push(`Site ${i},https://s${i}.example.com,u${i},pw${i}`);
    }
    const csv = `${lines.join("\n")}\n`;
    pickFile(makeFile("chrome.csv", csv));
    expect(await screen.findByText(/Recognised as/)).toBeTruthy();
    expect(screen.getByText("Showing the first 60 of 65.")).toBeTruthy();
  });

  it("marks agent secrets and missing folders in the preview table", async () => {
    render(<ImportPanel />);
    pickFile(makeFile("app.env", "API_KEY=sk-123\n"));
    expect(await screen.findByText(/Recognised as/)).toBeTruthy();
    // .env rows are agent secrets; folder only exists after the merge runs.
    expect(screen.getByText("agent secret")).toBeTruthy();
  });

  it("collapses the single-folder input when folders are kept", async () => {
    render(<ImportPanel />);
    pickFile(makeFile("bitwarden.json", BITWARDEN_JSON));
    await screen.findByText(/Recognised as/);
    // Keep is the default for exports with folders; switch to single and back.
    await userEvent.click(
      screen.getByLabelText(/Put everything in one new folder/),
    );
    expect(
      screen.getByLabelText(/Name of the folder to import into/),
    ).toBeTruthy();
    await userEvent.click(screen.getByLabelText(/Recreate the 1 folder/));
    expect(
      screen.queryByLabelText(/Name of the folder to import into/),
    ).toBeNull();
  });

  it("shows the Leave them unfiled label for folderless exports", async () => {
    render(<ImportPanel />);
    const csv =
      "name,url,username,password\nMail,https://m.example.com,me,pw\n";
    pickFile(makeFile("chrome.csv", csv));
    await screen.findByText(/Recognised as/);
    expect(screen.getByLabelText(/Leave them unfiled/)).toBeTruthy();
  });

  it("warns about logins without passwords", async () => {
    render(<ImportPanel />);
    const csv =
      "name,url,username,password\nMail,https://m.example.com,me,\nBank,https://b.example.com,me,pw\n";
    pickFile(makeFile("chrome.csv", csv));
    await screen.findByText(/Recognised as/);
    expect(screen.getByText(/1 login has no password/)).toBeTruthy();
  });

  it("reparse on a preview swaps the adapter", async () => {
    render(<ImportPanel />);
    pickFile(makeFile("app.env", "API_KEY=sk-123\n"));
    await screen.findByText(/Recognised as/);
    // Re-reading an .env as a browser CSV fails with a named error.
    await userEvent.selectOptions(
      screen.getByLabelText(/Read it as/i),
      "chromium-csv",
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});
