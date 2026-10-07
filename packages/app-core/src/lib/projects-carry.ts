import { kvSetDurable } from "./kv.js";
/** A shared-key carry seeds only the view authorized by its original session. */
import {
  type ProjectsState,
  readBootActiveId,
  withKnownNames,
} from "./projects-state.js";
import { PROJECTS_KEY } from "./projects-state.js";
import { VfsError, readFile, tombUnlocked, writeFile } from "./vfs.js";
/** Sealed VFS path (within a tomb) holding this tomb's projects view. */
export const PROJECTS_CONFIG_PATH = "config/projects";
export async function seedCarriedProjectsView(
  tomb: string,
  previous: ProjectsState,
  assertCurrent: () => void,
  bootView: () => ProjectsState,
  write: (state: ProjectsState) => Promise<void>,
): Promise<void> {
  assertCurrent();
  if (!tombUnlocked(tomb)) return;
  try {
    await readFile(tomb, PROJECTS_CONFIG_PATH);
    assertCurrent();
    return;
  } catch (error) {
    assertCurrent();
    if (error instanceof VfsError && error.code === "locked") throw error;
  }
  assertCurrent();
  const merged = withKnownNames(bootView(), previous);
  await write({ ...merged, activeId: readBootActiveId() });
  assertCurrent();
}

/** Capture the sealed-view destination before the durable boot-pointer await. */
export async function persistProjectsView(
  next: ProjectsState,
  tomb: string | null,
  assertCurrent: () => void,
  install: () => void,
  forgetUnsealedName: (tomb: string) => void,
): Promise<void> {
  assertCurrent();
  await kvSetDurable(
    PROJECTS_KEY,
    JSON.stringify({ v: 1, activeId: next.activeId }),
  );
  assertCurrent();
  install();
  if (tomb && tombUnlocked(tomb)) {
    await writeFile(
      tomb,
      PROJECTS_CONFIG_PATH,
      new TextEncoder().encode(JSON.stringify(next)),
    );
    assertCurrent();
    forgetUnsealedName(tomb);
  }
}
