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

import { lockManager, maybePage } from "../../../ports.js";
import { kvFlush, kvSetDurable } from "../../kv.js";
import type { BootRecord } from "../../projects-state.js";
import {
  PERSONAL_PROJECT_ID,
  PROJECTS_KEY,
  listProjects,
  rehydrateProjects,
} from "../../projects.js";
import { originTravelStorage } from "../../travel/storage.js";
import { vaultStore } from "../../vault/store.js";
import { lockTomb } from "../../vfs.js";
import {
  type BoundaryValue,
  type JsonValue,
  isJsonObject,
} from "../json-boundary.js";
import { wipeGuard } from "./guard.js";
import { wipeIntentPending } from "./intent.js";
import { type WipeDeps, resumeWipe, wipeDevice } from "./wipe.js";

const deps: WipeDeps = {
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
    // The boot pointer never names a vault that is gone; the personal vault
    // is the one the device always has. Written, not announced.
    const boot: BootRecord = { v: 1, activeId: PERSONAL_PROJECT_ID };
    await kvSetDurable(PROJECTS_KEY, JSON.stringify(boot));
  },
  now: () => new Date(),
};

export const wipeSeams = { deps };

/** A plan body this build understands: `{ v: 1 }` and nothing else. */
export function isWipeBody(body: BoundaryValue): boolean {
  if (!isJsonObject(body)) return false;
  const keys = Object.keys(body);
  return keys.length === 1 && body.v === 1;
}

/** Bring the lists and the store up to what storage now holds. */
function syncView(): void {
  rehydrateProjects();
  vaultStore.rehydrate();
}

/**
 * The refusal is on screen, the unlock form among it. Bringing the store up to
 * date at once would replace that screen with the one a device with no vault
 * gets, and the person would never see the refusal. So the view waits for the
 * next touch of the page: nothing can be submitted before it, and the first
 * thing a submit meets is the vault that is no longer there. A reload gets
 * there on its own.
 */
function syncAtNextTouch(): void {
  const target = maybePage();
  if (!target) {
    syncView();
    return;
  }
  const touches = ["pointerdown", "keydown", "touchstart"] as const;
  const once = (): void => {
    for (const touch of touches) target.removeEventListener(touch, once, true);
    syncView();
  };
  for (const touch of touches) target.addEventListener(touch, once, true);
}

/** The mode's runner. A body it does not understand does nothing at all. */
export async function runWipeEffect(body: JsonValue): Promise<void> {
  if (!isWipeBody(body)) return;
  if (!wipeGuard.permits("runWipeEffect")) return;
  try {
    await wipeDevice(wipeSeams.deps);
  } finally {
    syncAtNextTouch();
  }
}

/** Boot: finish a wipe the page died in. Does nothing when none began. */
export async function resumeWipeAtBoot(): Promise<void> {
  if (!wipeIntentPending()) return;
  if (!wipeGuard.permits("resumeWipeAtBoot")) return;
  try {
    await resumeWipe(wipeSeams.deps);
    // Nothing is on screen yet: boot reads the device as it now is.
    rehydrateProjects();
  } catch {
    // Boot goes on; the intent is still there for the next one.
  }
}
