/**
 * Files opened through the installed app's File Handling declaration.
 *
 * The browser hands the app a FileSystemFileHandle, never a path. The file is
 * read here only to get a `File`; it is held in the existing pending-import
 * slot and the Import review still has to be confirmed. A launch with no file
 * (a shortcut or link) is left to normal routing.
 */

import { setStatusNotice } from "@opensesame/app-core/lib/notices.js";
import { holdPendingImport } from "@opensesame/app-core/lib/vault/pending-import.js";

type LaunchParams = {
  readonly files?: readonly FileSystemFileHandle[];
  readonly targetURL?: string;
};

type LaunchQueue = {
  setConsumer: (consumer: (params: LaunchParams) => void) => void;
};

type LaunchHost = {
  readonly launchQueue?: LaunchQueue;
};

let installed = false;

function launchHost(): LaunchHost {
  // SAFETY: launchQueue is optional on LaunchHost, so the global matches it in a browser without File Handling; the caller checks it before use.
  return globalThis as LaunchHost;
}

/** Install once, early enough to catch a cold-start file launch. */
export function installLaunchQueue(host: LaunchHost = launchHost()): void {
  if (installed) return;
  const queue = host.launchQueue;
  if (queue === undefined) return;
  installed = true;
  queue.setConsumer((params) => {
    const handle = params.files?.[0];
    if (handle === undefined) return;
    void handle
      .getFile()
      .then((file) => {
        if ((params.files?.length ?? 0) > 1) {
          setStatusNotice({
            id: "launch-intake",
            tone: "warn",
            title: "Open files",
            body: "Open one file at a time. Only the first file was kept.",
          });
        }
        holdPendingImport(file, "launch");
      })
      .catch(() => {
        // A handle withdrawn or revoked by the OS is a cancelled launch.
      });
  });
}

/** Tests only: a later test gets a fresh consumer. */
export function resetLaunchQueueForTest(): void {
  installed = false;
}
