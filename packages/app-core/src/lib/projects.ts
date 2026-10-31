import { PROJECTS_CONFIG_PATH, ProjectSession } from "./projects-session.js";
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

import { kvDeleteDurable, kvGet, kvHydrate } from "./kv.js";
import {
  LEGACY_VAULT_KEYS,
  PERSONAL_PROJECT_ID,
  PROJECT_SCOPED_KEYS,
  type PagesProject,
  type ProjectsState,
  personalProject,
} from "./projects-state.js";
import {
  BODY_PATH,
  GUEST_TOMB,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  deleteFile,
  deletePlaintextFile,
  listTombs,
  registerTomb,
  tombUnlocked,
  unregisterTomb,
} from "./vfs.js";

/** Sealed VFS path (within a tomb) holding this tomb's projects view. */
export { PROJECTS_CONFIG_PATH };
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
/**
 * Which of `ids` still keep their vault under the legacy scoped keys — on
 * this device, but not a registered tomb until phase B moves it on first
 * activation. Travel (ADR 0143) refuses these until opened once.
 */
export async function legacyVaultsAmong(
  ids: readonly string[],
): Promise<string[]> {
  const tombs = new Set(listTombs());
  const candidates = ids.filter((id) => !tombs.has(id));
  const keys = candidates.map((id) => scopedKey(LEGACY_VAULT_KEYS[0], id));
  await kvHydrate(keys);
  return candidates.filter((_, i) => kvGet(keys[i] ?? "") !== null);
}

type Listener = () => void;
const listeners = new Set<Listener>();
const session = new ProjectSession(emit, legacyVaultsAmong);

function projectsStateDefault(): ProjectsState {
  return session.state();
}

/** Lock discards every decrypted name and invalidates pending hydrations. */
export function rehydrateProjects(): void {
  session.reset();
}

export async function refreshProjectsView(): Promise<void> {
  const tomb = session.activeTomb;
  if (tomb && tombUnlocked(tomb)) await hydrateProjectsFromVfs(tomb);
  else rehydrateProjects();
}

export function hydrateProjectsFromVfs(
  tomb: string,
  check: () => void = () => {},
): Promise<void> {
  return session.hydrate(tomb, check);
}

export function migrateProjectsToVfs(
  tomb: string,
  check: () => void = () => {},
): Promise<void> {
  return session.migrate(tomb, check);
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribeProjectsDefault(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function writeState(next: ProjectsState): Promise<void> {
  return session.write(next);
}

/** Preserve known display names when an opened/forked tomb has no sealed view. */
export function carryProjectsViewInto(
  tomb: string,
  previous: ProjectsState,
): Promise<void> {
  return session.carry(tomb, previous);
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

/**
 * Key under which `base` is stored for `projectId`. The personal project owns
 * the legacy un-prefixed keys; every other project gets its own namespace.
 * Only plaintext-by-design keys still use this (lockout counters, site
 * broker); vault material lives at tomb paths now.
 */
export function scopedKey(
  base: string,
  projectId: string = activeProject().id,
): string {
  if (projectId === PERSONAL_PROJECT_ID) return base;
  return `project.${projectId}.${base}`;
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
  session.unsealedNames.set(project.id, {
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
  session.unsealedNames.delete(id);
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
  for (const id of departed) session.unsealedNames.delete(id);
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
  return projectSeams.projectsState();
}

export function subscribeProjects(listener: Listener): () => void {
  return projectSeams.subscribeProjects(listener);
}

export function activeProject(): PagesProject {
  return projectSeams.activeProject();
}

export async function createProject(name: string): Promise<PagesProject> {
  return projectSeams.createProject(name);
}

export async function setActiveProject(id: string): Promise<void> {
  return projectSeams.setActiveProject(id);
}

export async function deleteProject(id: string): Promise<void> {
  return projectSeams.deleteProject(id);
}
