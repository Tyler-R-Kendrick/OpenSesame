import {
  STALE_BUILD,
  isChunkLoadFailure,
} from "@opensesame/app-core/lib/chunk-load.js";
import { checkForAppUpdate } from "./pwa-update.js";

export const loadShellSeams = {
  importAppRootModule: () => import("../app-root.js"),
};

/** The shell failed to load because the host replaced hashed chunks. */
export class StaleBuildError extends Error {
  constructor() {
    super(STALE_BUILD);
    this.name = "StaleBuildError";
  }
}

/** Load the React shell; a stale tab gets a stable message, not the browser's. */
export async function importAppRoot(): Promise<
  typeof import("../app-root.js")
> {
  try {
    return await loadShellSeams.importAppRootModule();
  } catch (caught) {
    if (isChunkLoadFailure(caught)) {
      void checkForAppUpdate();
      throw new StaleBuildError();
    }
    throw caught;
  }
}
