import { overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MergePlan } from "../../../lib/vault/import/merge.js";
import type {
  DetectInput,
  ParseResult,
} from "../../../lib/vault/import/types.js";
import {
  type ImportStage,
  type ImportStorePort,
  confirmManifestStage,
  confirmStage,
  importModelSeams,
  messageFrom,
  readStage,
  reparseStage,
  restoreStage,
  stageFor,
  unlockStage,
} from "./model.js";

const original = { ...importModelSeams };
afterEach(() => Object.assign(importModelSeams, original));

function file(name: string, contents: string): File {
  const picked = new File([contents], name, { type: "text/plain" });
  Object.defineProperty(picked, "text", {
    value: () => Promise.resolve(contents),
  });
  return picked;
}

const INPUT: DetectInput = {
  fileName: "db.kdbx",
  text: "",
  headers: null,
  json: null,
  bytes: new Uint8Array([1, 2, 3]),
};

const PLAN: MergePlan = { items: [], newFolders: [], duplicates: [] };

function store(overrides: Partial<ImportStorePort> = {}): ImportStorePort {
  return {
    applyImport: vi.fn(async () => 0),
    importSealed: vi.fn(async () => 0),
    applyManifestMerge: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("import model", () => {
  it("reads a .env straight to a preview", async () => {
    const outcome = await readStage(file("app.env", "API_KEY=sk-1\n"));
    expect(outcome.error).toBeNull();
    expect(outcome.stage.step).toBe("preview");
    if (outcome.stage.step !== "preview") return;
    expect(outcome.stage.result.source).toBe("env-file");
    expect(outcome.stage.result.items).toHaveLength(1);
  });

  it("stops at an unreadable file with the reader's reason", async () => {
    const empty = file("empty.env", " ");
    Object.defineProperty(empty, "size", { value: 0 });
    const outcome = await readStage(empty);
    expect(outcome.stage).toEqual({
      step: "unreadable",
      fileName: "empty.env",
    });
    expect(outcome.error).toMatch(/empty/i);
  });

  it("keeps the bytes of a file no adapter claimed", async () => {
    const outcome = await readStage(file("mystery.txt", "@@nope@@\n"));
    expect(outcome.stage.step).toBe("failed");
    expect(outcome.error).toMatch(/does not look like/i);
    const again = await reparseStage(outcome.stage, "env-file");
    expect(again.stage).toBe(outcome.stage);
    expect(again.error).not.toBeNull();
  });

  it("routes an OpenSesame vault file to its password, not the adapters", async () => {
    const parse = vi.fn();
    importModelSeams.parseImportAsync = parse;
    const text = JSON.stringify({
      format: "opensesame-vault-export",
      v: 1,
      tomb: "personal",
      header: { v: 1, createdAt: "2026-09-01T00:00:00Z" },
      body: { ivB64: "aXY=", ctB64: "Y3Q=" },
    });
    const outcome = await readStage(file("vault.json", text));
    expect(parse).not.toHaveBeenCalled();
    expect(outcome.stage.step).toBe("sealed");
  });

  it("routes a store path manifest to a by-path merge, not the adapters", async () => {
    const parse = vi.fn();
    importModelSeams.parseImportAsync = parse;
    const text = JSON.stringify([
      { path: "Dev/GitHub", secret: "pw", trailer: '{"kind":"login"}\n' },
    ]);
    const outcome = await readStage(file("manifest.json", text));
    expect(parse).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      stage: {
        step: "manifest",
        fileName: "manifest.json",
        entries: [
          { path: "Dev/GitHub", secret: "pw", trailer: '{"kind":"login"}\n' },
        ],
      },
      error: null,
    });
  });

  it("merges a manifest in one write and counts what it did", async () => {
    const stage: ImportStage = {
      step: "manifest",
      fileName: "manifest.json",
      entries: [],
    };
    const plan = { adds: [], updates: [], unchanged: 3, newFolders: [] };
    const port = store();
    const outcome = await confirmManifestStage(stage, plan, port);
    expect(port.applyManifestMerge).toHaveBeenCalledWith(plan);
    expect(outcome.stage).toMatchObject({
      step: "done",
      added: 0,
      skipped: 3,
      updated: 0,
      restored: false,
    });
    const failing = store({
      applyManifestMerge: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });
    expect(await confirmManifestStage(stage, plan, failing)).toEqual({
      stage,
      error: "disk full",
    });
    const other: ImportStage = { step: "reading", fileName: "x" };
    expect((await confirmManifestStage(other, plan, port)).stage).toBe(other);
  });

  it("marks a damaged vault file as not recognised", async () => {
    const outcome = await readStage(
      file("vault.json", JSON.stringify({ format: "opensesame-vault-export" })),
    );
    expect(outcome.stage.step).toBe("failed");
    expect(outcome.error).not.toBeNull();
  });

  it("asks for a database's password, and uses it for one parse only", async () => {
    const locked: ParseResult = {
      source: "keepass-kdbx",
      items: [],
      skipped: [],
      warnings: ["KeePass 4"],
      needsPassword: true,
    };
    const stage = stageFor("db.kdbx", INPUT, locked);
    expect(stage).toMatchObject({ step: "locked", note: "KeePass 4" });
    const parse = vi.fn(async () => ({
      source: "keepass-kdbx" as const,
      items: [],
      skipped: [],
      warnings: [],
    }));
    importModelSeams.parseImportAsync = parse;
    const opened = await unlockStage(stage, "hunter2");
    expect(parse).toHaveBeenCalledWith(
      { ...INPUT, password: "hunter2" },
      "keepass-kdbx",
    );
    expect(opened.stage.step).toBe("preview");
    // The password is in no stage.
    expect(JSON.stringify(opened.stage)).not.toContain("hunter2");
    // An empty password is not a transition.
    expect((await unlockStage(stage, "")).stage).toBe(stage);
  });

  it("keeps the locked stage and says why when the password is wrong", async () => {
    importModelSeams.parseImportAsync = vi.fn(async () => {
      throw new Error("Wrong master password");
    });
    const stage: ImportStage = {
      step: "locked",
      fileName: "db.kdbx",
      file: INPUT,
      source: "keepass-kdbx",
      note: "",
    };
    const outcome = await unlockStage(stage, "nope");
    expect(outcome).toEqual({ stage, error: "Wrong master password" });
  });

  it("commits a preview once, and reports a failed write in place", async () => {
    const preview = (await readStage(file("app.env", "A=1\nB=2\n"))).stage;
    const plan: MergePlan = {
      ...PLAN,
      items: [overlapCast({ id: "a" }), overlapCast({ id: "b" })],
    };
    const ok = store({ applyImport: vi.fn(async () => 2) });
    const done = await confirmStage(preview, plan, ok);
    expect(done.stage).toMatchObject({
      step: "done",
      added: 2,
      restored: false,
    });
    const broken = store({
      applyImport: vi.fn(async () => {
        throw new Error("vault is locked");
      }),
    });
    const failed = await confirmStage(preview, plan, broken);
    expect(failed).toEqual({ stage: preview, error: "vault is locked" });
    // Nothing to write is not a commit.
    expect((await confirmStage(preview, PLAN, ok)).stage).toBe(preview);
  });

  it("restores a sealed file through the store's own import", async () => {
    const sealed: ImportStage = {
      step: "sealed",
      fileName: "backup.json",
      sealed: "{}",
    };
    const port = store({ importSealed: vi.fn(async () => 4) });
    const outcome = await restoreStage(sealed, "pw", port);
    expect(port.importSealed).toHaveBeenCalledWith("{}", "pw");
    expect(outcome.stage).toMatchObject({
      step: "done",
      added: 4,
      restored: true,
    });
    expect((await restoreStage(sealed, "", port)).stage).toBe(sealed);
  });

  it("words an empty or foreign failure", () => {
    expect(messageFrom(new Error(""))).toBe("That file could not be read.");
    expect(messageFrom("nope")).toBe("That file could not be read.");
    expect(messageFrom(new Error("Too big"))).toBe("Too big");
  });
});
