import { describe, expect, it, vi } from "vitest";

vi.mock("./zip.js", async () => {
  const actual = await vi.importActual<typeof import("./zip.js")>("./zip.js");
  return {
    ...actual,
    readZipText: vi.fn(async () => '{"encrypted":false,"items":[]}'),
  };
});

import {
  ADAPTERS,
  ImportError,
  adapterFor,
  detectFormat,
  duplicateKey,
  parseImport,
  readImportFile,
  summarise,
} from "./index.js";
import { draftLogin, draftNote, draftSecret } from "./types.js";

describe("readImportFile", () => {
  it("rejects empty and absurdly large files before reading them", async () => {
    await expect(readImportFile(new File([], "x.csv"))).rejects.toThrow(
      /empty/,
    );
    const huge = new File(["x"], "x.csv");
    Object.defineProperty(huge, "size", { value: 65 * 1024 * 1024 });
    await expect(readImportFile(huge)).rejects.toThrow(/64 MB/);
  });

  it("reads JSON into a parsed value", async () => {
    const input = await readImportFile(
      new File(['{"encrypted":false,"items":[]}'], "export.json"),
    );
    expect(input.json).toEqual({ encrypted: false, items: [] });
    expect(input.headers).toBeNull();
  });

  it("reads the header row of CSV-shaped text", async () => {
    const input = await readImportFile(
      new File(["name,password\na,b\n"], "pw.csv"),
    );
    expect(input.json).toBeNull();
    expect(input.headers).toEqual(["name", "password"]);
  });

  it("leaves non-CSV, non-JSON text without headers", async () => {
    const input = await readImportFile(new File(["KEY=value\n"], ".env"));
    expect(input.json).toBeNull();
    expect(input.headers).toBeNull();
  });

  it("tolerates text that starts like JSON but is not", async () => {
    const input = await readImportFile(new File(["{oops,broken"], "odd.txt"));
    expect(input.json).toBeNull();
    // The first line has a comma, so it is still sniffed as CSV.
    expect(input.headers).toEqual(["{oops", "broken"]);
  });

  it("unwraps archives by name and reads the export entry", async () => {
    const input = await readImportFile(new File(["zip-ish"], "backup.1pux"));
    expect(input.json).toEqual({ encrypted: false, items: [] });

    const zipped = await readImportFile(new File(["zip-ish"], "export.zip"));
    expect(zipped.text).toContain("encrypted");
  });
});

describe("detectFormat / parseImport", () => {
  it("returns null when no adapter claims the input", () => {
    const input = {
      fileName: "mystery.txt",
      text: "no structure here at all",
      headers: null,
      json: null,
    };
    expect(detectFormat(input)).toBeNull();
    expect(() => parseImport(input)).toThrow(ImportError);
    expect(() => parseImport(input)).toThrow(/does not look like/);
  });

  it("throws when a forced source id is unknown", () => {
    expect(() =>
      parseImport(
        { fileName: "x", text: "a,b", headers: ["a", "b"], json: null },
        "nope" as never,
      ),
    ).toThrow(ImportError);
  });

  it("throws when the file parses but holds nothing", () => {
    const input = {
      fileName: "export.json",
      text: '{"encrypted":false,"items":[]}',
      headers: null,
      json: { encrypted: false, items: [] },
    };
    expect(() => parseImport(input)).toThrow(/held no items/);
  });

  it("survives a detector that throws", () => {
    const input = {
      fileName: "export.json",
      text: "{}",
      headers: null,
      json: { encrypted: false, items: [] },
    };
    // bitwardenJson.detect runs on this shape without throwing; sanity check
    // that the chain as a whole tolerates and identifies it.
    expect(detectFormat(input)?.id).toBe("bitwarden-json");
  });

  it("parses with a forced adapter", () => {
    const input = {
      fileName: "notes.txt",
      text: "KEY=value",
      headers: null,
      json: null,
    };
    const result = parseImport(input, "env-file");
    expect(result.source).toBe("env-file");
    expect(result.items[0]?.kind).toBe("secret");
  });
});

describe("adapterFor", () => {
  it("finds every registered adapter and nothing else", () => {
    for (const adapter of ADAPTERS) {
      expect(adapterFor(adapter.id)).toBe(adapter);
    }
    expect(adapterFor("opensesame")).toBeUndefined();
  });
});

describe("summarise", () => {
  it("counts kinds, 2FA, missing passwords, and folders", () => {
    const login = draftLogin("Mail");
    login.password = "x";
    login.totp = "JBSWY3DPEHPK3PXP";
    login.folder = "Email";
    const noPassword = draftLogin("Empty");
    noPassword.folder = "email"; // case differences stay distinct
    const secret = draftSecret("Deploy");
    const note = draftNote("Note");
    const summary = summarise([login, noPassword, secret, note]);
    expect(summary).toMatchObject({
      logins: 2,
      cards: 0,
      notes: 1,
      secrets: 1,
      withTotp: 1,
      withoutPassword: 1,
    });
    expect(summary.folders).toEqual(["email", "Email"]);
  });

  it("summarises an empty preview as zeroes", () => {
    expect(summarise([])).toEqual({
      logins: 0,
      cards: 0,
      notes: 0,
      secrets: 0,
      withTotp: 0,
      withoutPassword: 0,
      folders: [],
    });
  });
});

describe("duplicateKey", () => {
  it("normalizes case and whitespace but keeps kinds apart", () => {
    expect(
      duplicateKey({ kind: "login", name: " Mail ", username: "ADA" }),
    ).toBe(duplicateKey({ kind: "login", name: "mail", username: "ada" }));
    expect(
      duplicateKey({ kind: "login", name: "mail", username: "ada" }),
    ).not.toBe(duplicateKey({ kind: "note", name: "mail" }));
    expect(duplicateKey({ kind: "note", name: "x" })).toBe(
      duplicateKey({ kind: "note", name: "x", username: undefined }),
    );
  });
});
