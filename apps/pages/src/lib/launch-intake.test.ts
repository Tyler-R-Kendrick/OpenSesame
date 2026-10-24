import { takePendingImport } from "@opensesame/app-core/lib/vault/pending-import.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installLaunchQueue,
  resetLaunchQueueForTest,
} from "./launch-intake.js";

afterEach(() => {
  takePendingImport();
  resetLaunchQueueForTest();
});

describe("launch queue intake", () => {
  it("holds the launched file for the Import review", async () => {
    let consumer: (params: { files: FileSystemFileHandle[] }) => void = () =>
      undefined;
    const file = new File(["API_KEY=sk-test\n"], "app.env", {
      type: "text/plain",
    });
    const handle = {
      getFile: vi.fn(async () => file),
    } as unknown as FileSystemFileHandle;
    installLaunchQueue({
      launchQueue: {
        setConsumer: (next) => {
          consumer = next;
        },
      },
    });
    consumer({ files: [handle] });
    await Promise.resolve();
    await Promise.resolve();
    expect(handle.getFile).toHaveBeenCalledOnce();
    expect(takePendingImport()).toBe(file);
  });

  it("does nothing when the browser has no launch queue", () => {
    installLaunchQueue({});
    expect(takePendingImport()).toBeNull();
  });
});
