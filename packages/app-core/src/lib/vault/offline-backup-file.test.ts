import {
  VAULT_EXPORT_FORMAT,
  type VaultHeader,
  createVault,
  emptyBody,
  openVaultFile,
  readVaultFile,
  sealJson,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  type BackupSource,
  backupFileName,
  exportRefusal,
  offlineBackupFile,
  offlineBackupFileSeams,
  sealedVaultText,
  vaultFileFormat,
} from "./offline-backup-file.js";

const original = { ...offlineBackupFileSeams };
afterEach(() => Object.assign(offlineBackupFileSeams, original));

const PASSWORD = "correct horse battery staple";

async function sealedVault(tomb: string) {
  const { header, vaultKey } = await createVault(PASSWORD);
  const body = {
    ...emptyBody(),
    rev: 3,
    items: [
      {
        id: "itm_1",
        kind: "note" as const,
        name: "Router",
        folderId: null,
        favorite: false,
        notes: "the password is not here",
        fields: [],
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
        deletedAt: null,
      },
    ],
  };
  const sealed = await sealJson(vaultKey, body, vaultSealBinding(tomb, "body"));
  offlineBackupFileSeams.readBody = (asked) => (asked === tomb ? sealed : null);
  offlineBackupFileSeams.now = () => new Date("2026-09-27T12:00:00.000Z");
  return { header, sealed };
}

function source(overrides: Partial<BackupSource> = {}): BackupSource {
  return {
    status: "unlocked",
    guest: false,
    tomb: "personal",
    header: null,
    ...overrides,
  };
}

describe("offline backup file", () => {
  it("writes an envelope the master password opens, holding no plaintext", async () => {
    const { header } = await sealedVault("personal");
    const file = offlineBackupFile(source({ header }));
    expect(file.fileName).toBe("opensesame-offline-backup-2026-09-27.json");
    expect(file.text).not.toContain("Router");
    expect(file.text).not.toContain("the password is not here");
    // What `opensesame-id vault verify <file>` runs.
    const opened = await openVaultFile(file.text, PASSWORD);
    expect(opened.format).toBe("opensesame-offline-backup");
    expect(opened.tomb).toBe("personal");
    expect(opened.bound).toBe(true);
    expect(opened.rev).toBe(3);
    expect(opened.items.map((item) => item.path)).toEqual(["Router.note"]);
  });

  it("names a project's tomb in the file and in the envelope", async () => {
    const { header } = await sealedVault("prj_4f2a9c1d77");
    const file = offlineBackupFile(source({ header, tomb: "prj_4f2a9c1d77" }));
    expect(file.fileName).toBe(
      "opensesame-offline-backup-prj_4f2a-2026-09-27.json",
    );
    const opened = await openVaultFile(file.text, PASSWORD);
    expect(opened.tomb).toBe("prj_4f2a9c1d77");
    expect(opened.bound).toBe(true);
  });

  it("refuses what no password could open, and a vault not open", () => {
    const header: VaultHeader = { v: 1, createdAt: "2026-09-01T00:00:00Z" };
    expect(exportRefusal(source({ status: "locked" }))).toBe(
      "Unlock to export",
    );
    expect(exportRefusal(source({ guest: true, header }))).toBe(
      "A guest vault is not exported",
    );
    expect(exportRefusal(source())).toBe("Nothing sealed to export yet");
    expect(exportRefusal(source({ header }))).toBe(
      "Export needs a master password",
    );
    expect(() => offlineBackupFile(source({ header }))).toThrow(
      "Export needs a master password",
    );
  });

  it("refuses when nothing is sealed on disk yet", async () => {
    const { header } = await sealedVault("personal");
    offlineBackupFileSeams.readBody = () => null;
    expect(() => offlineBackupFile(source({ header }))).toThrow(
      "Nothing sealed to export yet",
    );
  });

  it("dates the file name by UTC day", () => {
    expect(
      backupFileName("personal", new Date("2026-01-02T23:59:00.000Z")),
    ).toBe("opensesame-offline-backup-2026-01-02.json");
  });
});

describe("restoring a vault file", () => {
  it("recognises only our two formats", () => {
    expect(vaultFileFormat({ format: "opensesame-offline-backup" })).toBe(
      "opensesame-offline-backup",
    );
    expect(vaultFileFormat({ format: VAULT_EXPORT_FORMAT })).toBe(
      VAULT_EXPORT_FORMAT,
    );
    expect(vaultFileFormat({ format: "bitwarden" })).toBeNull();
    expect(vaultFileFormat([])).toBeNull();
    expect(vaultFileFormat(null)).toBeNull();
  });

  it("rewrites a backup as the sealed export the store restores", async () => {
    const { header, sealed } = await sealedVault("personal");
    const file = offlineBackupFile(source({ header }));
    const text = sealedVaultText(file.text);
    const parsed = readVaultFile(text);
    expect(parsed.format).toBe(VAULT_EXPORT_FORMAT);
    expect(parsed.tomb).toBe("personal");
    expect(parsed.body).toEqual(sealed);
    expect(parsed.header).toEqual(header);
  });

  it("throws on a file that names our format but is damaged", () => {
    expect(() =>
      sealedVaultText(JSON.stringify({ format: "opensesame-offline-backup" })),
    ).toThrow();
  });
});
