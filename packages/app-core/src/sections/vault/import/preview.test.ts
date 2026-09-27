import { overlapCast } from "@opensesame/os-domain";
import type { Folder, VaultItem } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { parseImport } from "../../../lib/vault/import/index.js";
import type { DetectInput } from "../../../lib/vault/import/types.js";
import {
  LISTED_ADAPTERS,
  PREVIEW_LIMIT,
  commitLabel,
  defaultFolderName,
  doneFacts,
  exportFolders,
  landingDefaults,
  mergeOptionsFor,
  planImport,
  previewFacts,
  previewRows,
} from "./preview.js";

function textInput(fileName: string, text: string): DetectInput {
  const lines = text.split("\n");
  return {
    fileName,
    text,
    headers: fileName.endsWith(".csv") ? (lines[0]?.split(",") ?? null) : null,
    json: null,
    bytes: null,
  };
}

function csv(rows: number): string {
  const lines = ["name,url,username,password"];
  for (let i = 0; i < rows; i += 1) {
    lines.push(`Site ${i},https://s${i}.example.com,u${i},pw${i}`);
  }
  return `${lines.join("\n")}\n`;
}

const ENV = parseImport(textInput("app.env", "API_KEY=sk-1\nTOKEN=t\n"));
const CHROME = parseImport(textInput("chrome.csv", csv(3)), "chromium-csv");

describe("import preview", () => {
  it("lists formats by product name, the generic CSV among them", () => {
    const labels = LISTED_ADAPTERS.map((adapter) => adapter.label);
    expect(labels.indexOf("1Password (.1pux)")).toBeLessThan(
      labels.indexOf("1Password (.csv)"),
    );
    expect(labels).toContain("Any other CSV");
    expect(labels.indexOf("Bitwarden (.json)")).toBeLessThan(
      labels.indexOf("Firefox (.csv)"),
    );
  });

  it("keeps an export's folders and gathers a folderless one", () => {
    expect(landingDefaults(ENV).mode).toBe("keep");
    expect(exportFolders(ENV)).toEqual(["Imported .env"]);
    const chrome = landingDefaults(CHROME);
    expect(chrome.mode).toBe("single");
    expect(chrome.folderName).toBe(defaultFolderName("chromium-csv"));
    expect(chrome.skipDuplicates).toBe(true);
  });

  it("falls back to the default folder name when the field is blank", () => {
    expect(
      mergeOptionsFor(
        { mode: "single", folderName: "  ", skipDuplicates: false },
        "chromium-csv",
      ),
    ).toEqual({
      intoFolder: "Imported from your browser",
      keepFolders: false,
      skipDuplicates: false,
    });
    expect(
      mergeOptionsFor(
        { mode: "none", folderName: "x", skipDuplicates: true },
        "env-file",
      ),
    ).toEqual({ intoFolder: null, keepFolders: false, skipDuplicates: true });
  });

  it("states what the file holds and what the merge will skip", () => {
    const existing: VaultItem[] = [
      overlapCast({
        id: "itm_1",
        kind: "login",
        name: "Site 0",
        username: "u0",
        deletedAt: null,
      }),
    ];
    const choice = landingDefaults(CHROME);
    const plan = planImport(CHROME, existing, [], choice);
    expect(plan.items).toHaveLength(2);
    expect(previewFacts(CHROME, plan)).toEqual([
      { key: "Format", value: "Chrome, Edge, Brave, or Opera (.csv)" },
      { key: "Logins", value: "3" },
      { key: "Already here", value: "1 by name and username" },
      {
        key: "Note",
        value:
          "Browser exports carry only site logins — no cards, notes, or 2FA seeds.",
      },
    ]);
    expect(commitLabel(plan)).toBe("Import 2 items");
    const copies = planImport(CHROME, existing, [], {
      ...choice,
      skipDuplicates: false,
    });
    expect(commitLabel(copies)).toBe("Import 3 items");
  });

  it("says when there is nothing to import", () => {
    expect(commitLabel({ items: [], newFolders: [], duplicates: [] })).toBe(
      "Nothing to import",
    );
  });

  it("caps the preview rows and names each item's folder", () => {
    const big = parseImport(textInput("chrome.csv", csv(65)), "chromium-csv");
    const folders: Folder[] = [];
    const plan = planImport(big, [], folders, landingDefaults(big));
    const { rows, hidden } = previewRows(plan, folders);
    expect(rows).toHaveLength(PREVIEW_LIMIT);
    expect(hidden).toBe(5);
    expect(rows[0]).toMatchObject({
      name: "Site 0",
      detail: "u0",
      folder: "Imported from your browser",
    });
    const env = planImport(ENV, [], [], {
      ...landingDefaults(ENV),
      mode: "none",
    });
    expect(previewRows(env, []).rows[0]).toMatchObject({
      detail: "secret",
      folder: "—",
    });
  });

  it("reminds that a plain-text export is still on disk, but not a backup", () => {
    expect(doneFacts({ added: 2, skipped: 1, restored: false })).toEqual([
      { key: "Added", value: "2" },
      { key: "Already here", value: "1" },
      { key: "Sealed under", value: "this vault's key" },
      { key: "Export file", value: "plain text — delete it" },
    ]);
    expect(doneFacts({ added: 0, skipped: 0, restored: true })).toEqual([
      { key: "Added", value: "0" },
      { key: "Sealed under", value: "this vault's key" },
    ]);
  });
});
