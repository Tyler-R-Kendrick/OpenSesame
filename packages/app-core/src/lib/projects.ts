import {
  assertNotDecoySession,
  currentSyntheticTransition,
  isRealAuthorityBlocked,
} from "./decoy-session.js";
import { projectKey } from "./project-key.js";
import {
  persistProjectsView,
  seedCarriedProjectsView,
} from "./projects-carry.js";
import {
  hydrateSealedProjects,
  legacyVaultsAmong,
  migrateSealedProjects,
  syntheticProjectsView,
} from "./projects-hydration.js";
/**
 * Local project registry — the top level of the client hierarchy.
 *
 * Everything this app stores per-user (the vault, site consents, broker
 * policy) belongs to exactly one project. Every device starts with a
 * "Personal" project; further projects can be created and swapped between.
 *
 * Tomb framing (ADR 0063): every project vault IS a tomb, named after its
 * project id; the personal vault is the `personal` tomb (ADR 0038). The full
 * projects list (display names, kinds) lives sealed in the active tomb at
 * `tomb/<name>/config/projects` — a per-tomb view hydrated on unlock. What
 * stays plaintext is names only, the documented boundary: the `tombs.v1`
 * registry holds the tomb names, and `projects.v1` shrank to a boot record
 * holding just the active tomb pointer, so pre-unlock boot can still find
 * the right tomb's header.
 *
 * Sharing is a server-side concern: the Identity API's `/v1/projects`
 * membership endpoints share a project between principals. Local projects
 * are private to this device until they are linked to a server project.
 */

import { kvDeleteDurable } from "./kv.js";
import {
  LEGACY_VAULT_KEYS,
  PERSONAL_PROJECT_ID,
  PROJECT_SCOPED_KEYS,
  type PagesProject,
  type ProjectsState,
  personalProject,
  readBootActiveId,
} from "./projects-state.js";
import {
  BODY_PATH,
  GUEST_TOMB,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  VfsError,
  deleteFile,
  deletePlaintextFile,
  listTombs,
  pinTombAuthority,
  registerTomb,
  tombUnlocked,
  unregisterTomb,
} from "./vfs.js";

export { PROJECTS_CONFIG_PATH } from "./projects-carry.js";
export {
  PERSONAL_PROJECT_ID,
  PROJECTS_KEY,
  PROJECT_SCOPED_KEYS,
  type PagesProject,
  type PagesProjectKind,
  type ProjectsState,
} from "./projects-state.js";

/**
 * The pre-unlock view: tomb names from the plaintext registry (display names
 * are sealed — ids stand in until unlock), active pointer from the boot
 * record. The personal tomb always exists and comes first; a project
 * registers its tomb when it is created, sealed or not.
 */
function bootView(extra: readonly string[] = []): ProjectsState {
  const activeId = readBootActiveId();
  const ids = new Set<string>([
    PERSONAL_PROJECT_ID,
    ...listTombs(),
    activeId,
    ...extra,
  ]);
  const projects: PagesProject[] = [personalProject()];
  for (const id of [...ids].sort()) {
    if (id === PERSONAL_PROJECT_ID || id === GUEST_TOMB) continue;
    const known = unsealedNames.get(id);
    projects.push({
      id,
      name: known?.name ?? id,
      kind: "standard",
      createdAt: known?.createdAt ?? new Date(0).toISOString(),
    });
  }
  return { v: 1, projects, activeId };
}

export { legacyVaultsAmong } from "./projects-hydration.js";

type Listener = () => void;
const listeners = new Set<Listener>();
let cached: ProjectsState | null = null;
let cachedAuthority: (() => void) | null = null;
let projectTransition = currentSyntheticTransition();
/**
 * Names given in this tab that no tomb has sealed yet — a project created
 * from the vault switcher before its tomb had a projects view. They ride
 * over every boot-view rebuild (a lock discards the sealed view) until the
 * first sealed write carries them, and are forgotten the moment it does.
 * Never a name read back from a sealed copy: those stay inside the tomb.
 */
const unsealedNames = new Map<
  string,
  Pick<PagesProject, "name" | "createdAt">
>();
/** The tomb this session's sealed view belongs to, when hydrated on unlock. */
let activeTomb: string | null = null;

function synchronizeProjectRealm(): void {
  if (projectTransition !== currentSyntheticTransition()) {
    cached = null;
    cachedAuthority = null;
    activeTomb = null;
    unsealedNames.clear();
    projectTransition = currentSyntheticTransition();
  }
}

function projectsStateDefault(): ProjectsState {
  synchronizeProjectRealm();
  try {
    cachedAuthority?.();
  } catch {
    cached = null;
    cachedAuthority = null;
    activeTomb = null;
  }
  if (isRealAuthorityBlocked()) return syntheticProjectsView;
  if (!cached) cached = bootView();
  return cached;
}

/** Re-read the boot view (pre-unlock, and again on lock). */
export function rehydrateProjects(): void {
  synchronizeProjectRealm();
  cached = bootView();
  cachedAuthority = null;
  activeTomb = null;
  emit();
}

/** Re-read the list after tombs arrived or left underneath it (ADR 0143). */
export async function refreshProjectsView(): Promise<void> {
  if (activeTomb && tombUnlocked(activeTomb)) {
    await hydrateProjectsFromVfs(activeTomb);
  } else {
    rehydrateProjects();
  }
}

/**
 * Fill the projects view from the tomb's sealed config on unlock, after the
 * migration has moved any legacy plaintext record. Without a sealed copy the
 * boot view stands — ids in place of names until the first write.
 */
export async function hydrateProjectsFromVfs(
  tomb: string,
  origin: () => void = () => {},
): Promise<void> {
  synchronizeProjectRealm();
  origin();
  const authority = pinTombAuthority(tomb);
  activeTomb = tomb;
  const assertCurrent = () => {
    origin();
    authority();
    if (activeTomb !== tomb)
      throw new VfsError("locked", "The project session changed.");
  };
  await hydrateSealedProjects({
    tomb,
    assertCurrent,
    bootView,
    legacyVaultsAmong,
    hasUnsealedName: () => unsealedNames.has(tomb),
    install: (state) => {
      assertCurrent();
      cached = state;
      cachedAuthority = pinTombAuthority(tomb);
    },
    write: (state) => writeState(state, assertCurrent),
    emit,
  });
}

/** Move a legacy project view only within its originally admitted tomb session. */
export async function migrateProjectsToVfs(
  tomb: string,
  origin: () => void = () => {},
): Promise<void> {
  synchronizeProjectRealm();
  origin();
  const authority = pinTombAuthority(tomb);
  const previous = activeTomb;
  const assertCurrent = () => {
    origin();
    authority();
    if (activeTomb !== previous)
      throw new VfsError("locked", "The project session changed.");
  };
  await migrateSealedProjects(tomb, assertCurrent, (state) => {
    cached = state;
    cachedAuthority = pinTombAuthority(tomb);
    activeTomb = tomb;
  });
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribeProjectsDefault(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function writeState(
  next: ProjectsState,
  assertCurrent: () => void = () => {},
): Promise<void> {
  await persistProjectsView(
    next,
    activeTomb,
    assertCurrent,
    () => {
      cached = next;
      cachedAuthority =
        activeTomb && tombUnlocked(activeTomb)
          ? pinTombAuthority(activeTomb)
          : null;
    },
    (tomb) => unsealedNames.delete(tomb),
  );
  emit();
}

/**
 * Give a tomb its own sealed projects view when it has none yet — the
 * moment a shared-key project is opened or forked with the key in hand.
 * Names come from the view that was open a moment ago (`previous`) and from
 * anything typed in this tab; sealed here now, none of it has to ride in
 * memory or fall back to an id after a lock. No-op once a view exists.
 */
export async function carryProjectsViewInto(
  tomb: string,
  previous: ProjectsState,
  assertCurrent: () => void,
): Promise<void> {
  await seedCarriedProjectsView(
    tomb,
    previous,
    assertCurrent,
    bootView,
    (next) => {
      activeTomb = tomb;
      return writeState(next, assertCurrent);
    },
  );
}

export function listProjects(): PagesProject[] {
  return projectsState().projects;
}

function activeProjectDefault(): PagesProject {
  const state = projectsState();
  return (
    state.projects.find((project) => project.id === state.activeId) ??
    state.projects[0] ??
    personalProject()
  );
}

/** Plaintext-by-design project keys; encrypted vault data uses tomb paths. */
export function scopedKey(
  base: string,
  projectId = activeProject().id,
): string {
  return projectKey(base, projectId);
}

/**
 * Every hydratable KV key for a project (used before first paint and on
 * delete): the plaintext scoped keys plus the legacy vault keys, which stay
 * hydratable until the tomb migration has moved them.
 */
export function projectScopedKeys(
  projectId: string = activeProject().id,
): string[] {
  return [...PROJECT_SCOPED_KEYS, ...LEGACY_VAULT_KEYS].map((base) =>
    scopedKey(base, projectId),
  );
}

async function createProjectDefault(name: string): Promise<PagesProject> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Give the project a name.");
  if (trimmed.toLowerCase() === GUEST_TOMB) {
    throw new Error("guest is the continue-as-guest road, not a vault name.");
  }
  const state = projectsState();
  if (
    state.projects.some(
      (project) => project.name.toLowerCase() === trimmed.toLowerCase(),
    )
  ) {
    throw new Error("A project with that name already exists.");
  }
  const project: PagesProject = {
    id: `prj_${crypto.randomUUID()}`,
    name: trimmed,
    kind: "standard",
    createdAt: new Date().toISOString(),
  };
  unsealedNames.set(project.id, {
    name: project.name,
    createdAt: project.createdAt,
  });
  await registerTomb(project.id); // on the device from now, sealed or not
  await writeState({
    ...state,
    projects: [...state.projects, project],
  });
  return project;
}

export async function renameProject(id: string, name: string): Promise<void> {
  assertNotDecoySession();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Give the project a name.");
  const state = projectsState();
  if (id === PERSONAL_PROJECT_ID) {
    throw new Error("The personal project cannot be renamed.");
  }
  await writeState({
    ...state,
    projects: state.projects.map((project) =>
      project.id === id ? { ...project, name: trimmed } : project,
    ),
  });
}

/**
 * Swap the active project. The caller is expected to reload the app right
 * after: a swap changes which sealed vault and consent set every module
 * reads, and a reload is the one way to guarantee no unlocked key or cached
 * plaintext from the previous project survives the transition.
 */
async function setActiveProjectDefault(id: string): Promise<void> {
  const state = projectsState();
  if (!state.projects.some((project) => project.id === id)) {
    throw new Error("That project no longer exists on this device.");
  }
  if (state.activeId === id) return;
  await writeState({ ...state, activeId: id });
}

/** Every tomb file path a project's vault material lives at. */
function tombFilePaths(): string[] {
  return [HEADER_PATH, BODY_PATH, INDEX_PATH, MIGRATION_MARKER_PATH];
}

/**
 * Remove a project and every sealed blob stored under it — the tomb's files
 * and its name in the registry included. The personal project is the
 * always-present default and can never be deleted.
 */
async function deleteProjectDefault(id: string): Promise<void> {
  if (id === PERSONAL_PROJECT_ID) {
    throw new Error("The personal project cannot be deleted.");
  }
  const state = projectsState();
  if (!state.projects.some((project) => project.id === id)) return;
  await Promise.all([
    ...projectScopedKeys(id).map((key) => kvDeleteDurable(key)),
    ...tombFilePaths().map((path) => deletePlaintextFile(id, path)),
    deleteFile(id, "config/prefs"),
    deleteFile(id, "config/idp-registry"),
    deleteFile(id, "config/projects"),
    deleteFile(id, "config/org-profile"),
    unregisterTomb(id),
  ]);
  unsealedNames.delete(id);
  await writeState({
    v: 1,
    projects: state.projects.filter((project) => project.id !== id),
    activeId: state.activeId === id ? PERSONAL_PROJECT_ID : state.activeId,
  });
}

/**
 * Forget vaults that just left this device for travel (ADR 0143): their
 * tombs are already gone, so only the list and the active pointer change.
 * The open tomb's sealed view is rewritten without them; any other tomb's
 * view is scrubbed the next time it is unlocked (`hydrateProjectsFromVfs`).
 */
export async function forgetDepartedProjects(
  ids: readonly string[],
): Promise<void> {
  const departed = new Set(ids);
  for (const id of departed) unsealedNames.delete(id);
  const state = projectsState();
  await writeState({
    v: 1,
    projects: state.projects.filter(
      (project) =>
        project.id === PERSONAL_PROJECT_ID || !departed.has(project.id),
    ),
    activeId: departed.has(state.activeId)
      ? PERSONAL_PROJECT_ID
      : state.activeId,
  });
}

export const projectSeams = {
  projectsState: projectsStateDefault,
  subscribeProjects: subscribeProjectsDefault,
  activeProject: activeProjectDefault,
  createProject: createProjectDefault,
  setActiveProject: setActiveProjectDefault,
  deleteProject: deleteProjectDefault,
};

export function projectsState(): ProjectsState {
  if (isRealAuthorityBlocked()) return syntheticProjectsView;
  return projectSeams.projectsState();
}

export function subscribeProjects(listener: Listener): () => void {
  return projectSeams.subscribeProjects(listener);
}

export function activeProject(): PagesProject {
  if (isRealAuthorityBlocked()) return personalProject();
  return projectSeams.activeProject();
}

export async function createProject(name: string): Promise<PagesProject> {
  assertNotDecoySession();
  return projectSeams.createProject(name);
}

export async function setActiveProject(id: string): Promise<void> {
  assertNotDecoySession();
  return projectSeams.setActiveProject(id);
}

export async function deleteProject(id: string): Promise<void> {
  assertNotDecoySession();
  return projectSeams.deleteProject(id);
}
