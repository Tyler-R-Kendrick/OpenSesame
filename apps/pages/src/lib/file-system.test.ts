/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pickDirectory,
  saveBlob,
  saveTextFile,
  saveTextToDirectory,
} from "./file-system.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function anchorClick() {
  return vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => undefined);
}

describe("File System Access save", () => {
  it("uses the browser picker when it is present", async () => {
    const write = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const showSaveFilePicker = vi.fn(async () => ({
      createWritable: async () => ({ write, close, abort: vi.fn() }),
    }));
    vi.stubGlobal("showSaveFilePicker", showSaveFilePicker);
    const click = anchorClick();

    await expect(
      saveTextFile("codes.txt", "secret", "text/plain", "Recovery codes"),
    ).resolves.toBe("saved");
    expect(showSaveFilePicker).toHaveBeenCalledWith({
      suggestedName: "codes.txt",
      types: [
        {
          description: "Recovery codes",
          accept: { "application/octet-stream": [".txt"] },
        },
      ],
    });
    expect(write).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(click).not.toHaveBeenCalled();
  });

  it("treats dismissal as cancellation and writes nothing", async () => {
    vi.stubGlobal(
      "showSaveFilePicker",
      vi.fn(async () => {
        throw new DOMException("dismissed", "AbortError");
      }),
    );
    const click = anchorClick();

    await expect(saveBlob(new Blob(["x"]), "x.txt")).resolves.toBe("cancelled");
    expect(click).not.toHaveBeenCalled();
  });

  it("falls back to a download and keeps the object URL alive", async () => {
    vi.useFakeTimers();
    const create = vi.fn(() => "blob:file");
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = anchorClick();

    await expect(saveTextFile("codes.txt", "secret")).resolves.toBe(
      "downloaded",
    );
    expect(click).toHaveBeenCalledOnce();
    expect(revoke).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith("blob:file");
  });
});

describe("File System Access open", () => {
  it("returns files from the open picker", async () => {
    const file = new File(["hello"], "hello.txt", { type: "text/plain" });
    vi.stubGlobal(
      "showOpenFilePicker",
      vi.fn(async () => [{ getFile: async () => file }]),
    );
    const { pickFiles } = await import("./file-system.js");
    await expect(pickFiles()).resolves.toEqual([file]);
  });

  it("reports an unavailable open picker as null", async () => {
    const { pickFiles } = await import("./file-system.js");
    await expect(pickFiles()).resolves.toBeNull();
  });
});

describe("File System Access directory", () => {
  it("writes a reviewed export into the chosen directory", async () => {
    const write = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const getFileHandle = vi.fn(async () => ({
      createWritable: async () => ({ write, close, abort: vi.fn() }),
    }));
    const directory = {
      name: "backups",
      getFileHandle,
    } as unknown as FileSystemDirectoryHandle;
    vi.stubGlobal(
      "showDirectoryPicker",
      vi.fn(async () => directory),
    );
    await expect(pickDirectory()).resolves.toBe(directory);
    await saveTextToDirectory(
      directory,
      "vault.json",
      "{}",
      "application/json",
    );
    expect(getFileHandle).toHaveBeenCalledWith("vault.json", { create: true });
    expect(write).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("reports an unavailable directory picker as null", async () => {
    await expect(pickDirectory()).resolves.toBeNull();
  });
});
