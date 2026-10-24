import { offlineBackupFileSeams } from "@opensesame/app-core/lib/vault/offline-backup-file.js";
import { isString } from "@opensesame/os-domain";
import {
  type VaultHeader,
  createVault,
  emptyBody,
  openVaultFile,
  sealJson,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextMenuLayer } from "../../components/context-menu/ContextMenuLayer.js";
import { closeContextMenu } from "../../components/context-menu/menu-model.js";

type VaultView = {
  status: string;
  guest: boolean;
  tomb: string;
  header: VaultHeader | null;
  items: { deletedAt: string | null }[];
};
type VaultFixture = { current: VaultView };
const vault: VaultFixture = {
  current: {
    status: "unlocked",
    guest: false,
    tomb: "personal",
    header: null,
    items: [],
  },
};

import { vaultHooksSeams } from "../../lib/vault/hooks.js";
Object.assign(vaultHooksSeams, { useVault: () => vault.current });

import { downloadSeams } from "../../screens/capabilities/download.js";
import { ExportKey } from "./ExportKey.js";

const PASSWORD = "correct horse battery staple";
const saved: { name: string; text: string; type: string }[] = [];
const originalSave = downloadSeams.save;
const originalSeams = { ...offlineBackupFileSeams };

async function passwordVault() {
  const { header, vaultKey } = await createVault(PASSWORD);
  const body = await sealJson(
    vaultKey,
    emptyBody(),
    vaultSealBinding("personal", "body"),
  );
  offlineBackupFileSeams.readBody = () => body;
  vault.current = {
    status: "unlocked",
    guest: false,
    tomb: "personal",
    header,
    items: [{ deletedAt: null }, { deletedAt: "2026-09-01T00:00:00Z" }],
  };
}

describe("Export key", () => {
  beforeEach(() => {
    saved.length = 0;
    downloadSeams.save = async (name, text, type = "") => {
      saved.push({ name, text, type });
      return "downloaded" as const;
    };
  });

  afterEach(() => {
    cleanup();
    closeContextMenu();
    vi.unstubAllGlobals();
    downloadSeams.save = originalSave;
    Object.assign(offlineBackupFileSeams, originalSeams);
    vi.clearAllMocks();
  });

  it("names the open vault through openVaultLabel, not a raw tomb id", async () => {
    const vaults = await import("@opensesame/app-core/lib/vaults.js");
    vi.spyOn(vaults, "openVaultLabel").mockReturnValue("project · work");
    await passwordVault();
    vault.current.tomb = "prj_0000-work";
    render(<ExportKey />);
    await userEvent.click(screen.getByRole("button", { name: "Export items" }));
    expect(screen.getByText("project · work")).toBeTruthy();
    vi.restoreAllMocks();
  });

  it("is an icon key that opens the encrypted-backup sheet", async () => {
    await passwordVault();
    render(<ExportKey />);
    const key = screen.getByRole("button", { name: "Export items" });
    expect(key.textContent).toBe("");
    expect(key.getAttribute("title")).toBe("Export encrypted vault");
    await userEvent.click(key);
    expect(
      screen.getByRole("dialog", { name: "Export encrypted vault" }),
    ).toBeTruthy();
    expect(screen.getByText("ciphertext only")).toBeTruthy();
    expect(screen.getByText("the master password")).toBeTruthy();
    // Only live items are counted; the trashed one still rides in the body.
    expect(screen.getByText("Items").nextElementSibling?.textContent).toBe("1");
    // Opening the sheet writes nothing.
    expect(saved).toHaveLength(0);
  });

  it("saves a backup `opensesame-id vault verify` opens with the password", async () => {
    await passwordVault();
    render(<ExportKey />);
    await userEvent.click(screen.getByRole("button", { name: "Export items" }));
    await userEvent.click(screen.getByRole("button", { name: "Save backup" }));
    expect(saved).toHaveLength(1);
    const [file] = saved;
    expect(file?.name).toMatch(
      /^opensesame-offline-backup-\d{4}-\d{2}-\d{2}\.json$/,
    );
    expect(file?.type).toBe("application/json");
    const opened = await openVaultFile(file?.text ?? "", PASSWORD);
    expect(opened.format).toBe("opensesame-offline-backup");
    expect(opened.tomb).toBe("personal");
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(screen.getByText(file?.name ?? "")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save again" })).toBeTruthy();
  });

  it("refuses a vault no password opens, with a mark and no commit", async () => {
    vault.current = {
      status: "unlocked",
      guest: false,
      tomb: "personal",
      header: { v: 1, createdAt: "2026-09-01T00:00:00Z" },
      items: [],
    };
    render(<ExportKey />);
    await userEvent.click(screen.getByRole("button", { name: "Export items" }));
    expect(
      screen.getByRole("img", { name: "Export needs a master password" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save backup" })).toBeNull();
  });

  it("refuses a guest vault", async () => {
    vault.current = { ...vault.current, guest: true, tomb: "guest" };
    render(<ExportKey />);
    await userEvent.click(screen.getByRole("button", { name: "Export items" }));
    expect(
      screen.getByRole("img", { name: "A guest vault is not exported" }),
    ).toBeTruthy();
  });

  it("marks a failed read instead of writing a file", async () => {
    await passwordVault();
    offlineBackupFileSeams.readBody = () => null;
    render(<ExportKey />);
    await userEvent.click(screen.getByRole("button", { name: "Export items" }));
    await userEvent.click(screen.getByRole("button", { name: "Save backup" }));
    expect(saved).toHaveLength(0);
    expect(
      screen.getByRole("img", { name: "Nothing sealed to export yet" }),
    ).toBeTruthy();
  });

  it("offers a backup when the vault opens with a passkey or a PIN", async () => {
    const wrap = { ivB64: "YQ==", ctB64: "YQ==" };
    const passkey = {
      v: 1 as const,
      createdAt: "2026-09-01T00:00:00Z",
      unlocks: {
        passkey: {
          credentialIdB64: "YQ==",
          userIdB64: "YQ==",
          prfSaltB64: "YQ==",
          wrap,
        },
      },
    };
    const pin = {
      v: 1 as const,
      createdAt: "2026-09-01T00:00:00Z",
      unlocks: {
        pin: {
          kdf: {
            alg: "PBKDF2-SHA256" as const,
            saltB64: "YQ==",
            iterations: 600000,
          },
          wrap,
        },
      },
    };
    for (const [header, opener] of [
      [passkey, "the passkey"],
      [pin, "the PIN"],
    ] as const) {
      cleanup();
      vault.current = {
        status: "unlocked",
        guest: false,
        tomb: "personal",
        header,
        items: [{ deletedAt: null }],
      };
      render(<ExportKey />);
      await userEvent.click(
        screen.getByRole("button", { name: "Export items" }),
      );
      expect(screen.getByText(opener)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Save backup" })).toBeTruthy();
    }
  });

  it("closes and hands focus back to the key", async () => {
    await passwordVault();
    render(<ExportKey />);
    const key = screen.getByRole("button", { name: "Export items" });
    await userEvent.click(key);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(key);
  });
  it("delivers an explicit encrypted download through the ordinary menu without opening the save picker", async () => {
    await passwordVault();
    const choose = vi.fn(() => {
      throw new Error("Native save picker must not open");
    });
    vi.stubGlobal("showSaveFilePicker", choose);
    const originalCreate = Object.getOwnPropertyDescriptor(
      URL,
      "createObjectURL",
    );
    const originalRevoke = Object.getOwnPropertyDescriptor(
      URL,
      "revokeObjectURL",
    );
    let captured: Blob | null = null;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: (blob: Blob) => {
        captured = blob;
        return "blob:encrypted-backup";
      },
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    let deliver: (file: { name: string; blob: Blob }) => void = () => {};
    const delivered = new Promise<{ name: string; blob: Blob }>((resolve) => {
      deliver = resolve;
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        if (!captured) throw new Error("The real backup Blob was not created");
        expect(this.href).toBe("blob:encrypted-backup");
        deliver({ name: this.download, blob: captured });
      });
    try {
      render(
        <MemoryRouter>
          <ExportKey />
          <ContextMenuLayer />
        </MemoryRouter>,
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Export items" }),
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Backup actions" }),
      );
      expect(click).not.toHaveBeenCalled();
      expect(screen.queryByText("Saved")).toBeNull();
      await userEvent.click(
        screen.getByRole("menuitem", { name: "Download backup" }),
      );
      const file = await delivered;
      expect(file.name).toMatch(/^opensesame-offline-backup-.*\.json$/);
      expect(file.blob.type).toBe("application/json");
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () =>
          isString(reader.result)
            ? resolve(reader.result)
            : reject(new Error("Expected backup text"));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(file.blob);
      });
      expect((await openVaultFile(text, PASSWORD)).tomb).toBe("personal");
      expect(text).not.toContain(PASSWORD);
      await expect(
        openVaultFile(text, "a different password"),
      ).rejects.toThrow();
      expect(choose).not.toHaveBeenCalled();
      expect(saved).toHaveLength(0);
      expect(click).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Saved")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Save again" })).toBeTruthy();
    } finally {
      click.mockRestore();
      if (originalCreate)
        Object.defineProperty(URL, "createObjectURL", originalCreate);
      else Reflect.deleteProperty(URL, "createObjectURL");
      if (originalRevoke)
        Object.defineProperty(URL, "revokeObjectURL", originalRevoke);
      else Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  });

  it.each(["saved", "cancelled"] as const)(
    "keeps Save pending until its genuine write promise settles as %s without an anchor fallback",
    async (outcome) => {
      await passwordVault();
      let finish: (outcome: "saved" | "cancelled") => void = () => {};
      const write = new Promise<"saved" | "cancelled">((resolve) => {
        finish = resolve;
      });
      downloadSeams.save = (name, text, type = "") => {
        saved.push({ name, text, type });
        return write;
      };
      const click = vi
        .spyOn(HTMLAnchorElement.prototype, "click")
        .mockImplementation(() => undefined);
      render(<ExportKey />);
      await userEvent.click(
        screen.getByRole("button", { name: "Export items" }),
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Save backup" }),
      );
      await waitFor(() => expect(saved).toHaveLength(1));
      expect((await openVaultFile(saved[0]?.text ?? "", PASSWORD)).tomb).toBe(
        "personal",
      );
      expect(screen.queryByText("Saved")).toBeNull();
      await act(async () => {
        finish(outcome);
        await write;
      });
      await waitFor(() =>
        expect(
          screen.getByRole("button", {
            name: outcome === "saved" ? "Save again" : "Save backup",
          }),
        ).toBeTruthy(),
      );
      if (outcome === "saved") expect(screen.getByText("Saved")).toBeTruthy();
      else expect(screen.queryByText("Saved")).toBeNull();
      expect(click).not.toHaveBeenCalled();
      click.mockRestore();
    },
  );
});
