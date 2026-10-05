/**
 * The wipe bound to this browser, and the only two ways in.
 *
 * `runWipeEffect` is the mode's runner, reached from the unlock seam when a
 * matched code's sealed plan names `wipe`. `resumeWipeAtBoot` finishes a wipe
 * the page died in. Nothing else imports this file (`wipe-reach.test.ts`):
 * arming a code, removing it and every Settings screen cannot start a wipe,
 * because there is no road from them to here.
 *
 * Both refuse when the test guard forbids the real removal (`guard.ts`).
 */

import { lockManager } from "../../../ports.js";
import { kvFlush } from "../../kv.js";
import {
  PERSONAL_PROJECT_ID,
  forgetDepartedProjects,
  listProjects,
  rehydrateProjects,
} from "../../projects.js";
import { originTravelStorage } from "../../travel/storage.js";
import { vaultStore } from "../../vault/store.js";
import { lockTomb } from "../../vfs.js";
import { wipeGuard } from "./guard.js";
import { wipeIntentPending } from "./intent.js";
import { type WipeDeps, resumeWipe, wipeDevice } from "./wipe.js";

export const wipeSeams: { deps: WipeDeps } = {
  deps: {
    storage: originTravelStorage,
    knownIds: () => listProjects().map((project) => project.id),
    settle: kvFlush,
    async exclusive(work) {
      const locks = lockManager();
      // The travel lock: a departure, a return and a wipe never interleave.
      return locks ? locks.request("opensesame.travel", work) : work();
    },
    async afterRemoval(gone) {
      // A vault opened earlier in the session keeps its key in memory.
      for (const id of gone) lockTomb(id);
      // The list and the active pointer forget them; the personal vault is
      // the one the device always has, so it stays the default.
      const departed = gone.filter((id) => id !== PERSONAL_PROJECT_ID);
      if (departed.length > 0) await forgetDepartedProjects(departed);
      rehydrateProjects();
      vaultStore.rehydrate();
    },
    now: () => new Date(),
  },
};

/** A plan body this build understands: `{ v: 1 }` and nothing else. */
export function isWipeBody(body: unknown): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return false;
  }
  const keys = Object.keys(body);
  return keys.length === 1 && (body as { v?: unknown }).v === 1;
}

/** The mode's runner. A body it does not understand does nothing at all. */
export async function runWipeEffect(body: unknown): Promise<void> {
  if (!isWipeBody(body)) return;
  if (!wipeGuard.permits("runWipeEffect")) return;
  await wipeDevice(wipeSeams.deps);
}

/** Boot: finish a wipe the page died in. Does nothing when none began. */
export async function resumeWipeAtBoot(): Promise<void> {
  if (!wipeIntentPending()) return;
  if (!wipeGuard.permits("resumeWipeAtBoot")) return;
  try {
    await resumeWipe(wipeSeams.deps);
  } catch {
    // Boot goes on; the intent is still there for the next one.
  }
}
