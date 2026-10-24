/** @vitest-environment jsdom */
import { listNotices } from "@opensesame/app-core/lib/notices.js";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { AddKeyProtection } from "./VaultKeyProtectionCeremonies.js";
import { externalCeremonyDependencies } from "./VaultKeyProtectionExternalCeremonies.js";
import { downloadOnce, saveSecret } from "./download-once.js";

const originalHooks = { ...vaultHooksSeams };
const originalDependencies = { ...externalCeremonyDependencies };
const originalUrls = Object.getOwnPropertyDescriptors(URL);

describe("downloadOnce", () => {
  afterEach(() => {
    cleanup();
    document.querySelector('a[download="key.txt"]')?.remove();
    Object.assign(vaultHooksSeams, originalHooks);
    Object.assign(externalCeremonyDependencies, originalDependencies);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const name of ["createObjectURL", "revokeObjectURL"]) {
      const original = originalUrls[name];
      if (original) Object.defineProperty(URL, name, original);
      else Reflect.deleteProperty(URL, name);
    }
  });

  it("keeps the object URL alive past the click so the download is not cancelled", async () => {
    vi.useFakeTimers();
    const blobs: Blob[] = [];
    const create = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return "blob:one";
    });
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const showSaveFilePicker = vi.fn(async () => ({
      createWritable: async () => ({
        write: vi.fn(),
        close: vi.fn(),
        abort: vi.fn(),
      }),
    }));
    vi.stubGlobal("showSaveFilePicker", showSaveFilePicker);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        expect(this.isConnected).toBe(true);
        expect(this.href).toBe("blob:one");
        expect(this.download).toBe("age.txt");
      });

    await expect(downloadOnce("age.txt", "AGE-SECRET-KEY")).resolves.toBe(
      "downloaded",
    );

    expect(showSaveFilePicker).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled();
    expect(document.querySelector('a[download="age.txt"]')).toBeNull();
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith("blob:one");
    vi.useRealTimers();
    expect(blobs).toHaveLength(1);
    const blob = blobs[0];
    if (!blob) throw new Error("The secret was not handed to a Blob.");
    expect(blob.type).toBe("text/plain");
    const text = await new Promise<FileReader["result"]>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
    expect(text).toBe("AGE-SECRET-KEY");
  });

  it("reports a dismissed secret save as cancelled", async () => {
    vi.stubGlobal(
      "showSaveFilePicker",
      vi.fn(async () => {
        throw new DOMException("dismissed", "AbortError");
      }),
    );
    await expect(saveSecret("age.txt", "AGE-SECRET-KEY")).resolves.toBe(
      "cancelled",
    );
  });

  it.each(["Blob", "object URL", "anchor"])(
    "rejects %s failures through the returned Promise",
    async (stage) => {
      const failure = new Error("The secret could not be downloaded.");
      const create = vi.fn(() => "blob:failed");
      Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
      const click = vi.spyOn(HTMLAnchorElement.prototype, "click");
      if (stage === "Blob")
        vi.stubGlobal(
          "Blob",
          class {
            constructor() {
              throw failure;
            }
          },
        );
      else if (stage === "object URL")
        create.mockImplementation(() => {
          throw failure;
        });
      else
        click.mockImplementation(() => {
          throw failure;
        });
      const caught = vi.fn();

      await downloadOnce("key.txt", "secret").catch(caught);

      expect(caught).toHaveBeenCalledExactlyOnceWith(failure);
    },
  );

  it("does not enroll a recovery key when the actual download delivery rejects", async () => {
    const create = vi.fn(() => {
      throw new Error("Secret delivery failed.");
    });
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const protection = {
      enrollCandidate: vi.fn(async () => ({
        operationId: "pending-recovery",
        recoverySecretB64: "c2VjcmV0",
      })),
      commitEnrollment: vi.fn(),
    };
    Object.assign(vaultHooksSeams, {
      useVaultStore: () => ({ protection }),
    });
    Object.assign(externalCeremonyDependencies, { saveSecret: downloadOnce });
    const onDone = vi.fn();
    render(createElement(AddKeyProtection, { onDone }));
    const recovery = screen.getByRole("button", { name: "Recovery key" });

    fireEvent.click(recovery);

    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(listNotices().at(-1)?.body).toBe("Secret delivery failed."),
    );
    await waitFor(() => expect(recovery.hasAttribute("disabled")).toBe(false));
    expect(listNotices().at(-1)?.tone).toBe("err");
    expect(protection.enrollCandidate).toHaveBeenCalledWith("recovery-key");
    expect(protection.commitEnrollment).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });
});
