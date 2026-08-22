import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
/**
 * Local project registry — the top level of the client hierarchy.
 *
 * Everything this app stores per-user (the vault, site consents, broker
 * policy) belongs to exactly one project. Every device starts with a
 * "Personal" project; further projects can be created and swapped between.
 * The personal project keeps the legacy un-prefixed KV keys so vaults that
 * predate projects stay readable; other projects prefix every key.
 *
 * Sharing is a server-side concern: the Identity API's `/v1/projects`
 * membership endpoints share a project between principals. Local projects
 * are private to this device until they are linked to a server project.
 */

import { kvDeleteDurable, kvGet, kvSetDurable } from "./kv.js";

export const PROJECTS_KEY = "projects.v1";
export const PERSONAL_PROJECT_ID = "personal";

export type PagesProjectKind = "personal" | "standard";

export type PagesProject = {
  id: string;
  name: string;
  kind: PagesProjectKind;
  createdAt: string;
};

export type ProjectsState = {
  v: 1;
  projects: PagesProject[];
  activeId: string;
};

/** Base KV keys that are stored once per project rather than per device. */
export const PROJECT_SCOPED_KEYS = [
  "vault.header.v1",
  "vault.body.v1",
  "vault.attempts.v1",
  "vault.prefs.v1",
  "site-broker.consents.v1",
  "site-broker.policy.v1",
] as const;

function personalProject(): PagesProject {
  return {
    id: PERSONAL_PROJECT_ID,
    name: "Personal",
    kind: "personal",
    createdAt: new Date(0).toISOString(),
  };
}

function defaultState(): ProjectsState {
  return { v: 1, projects: [personalProject()], activeId: PERSONAL_PROJECT_ID };
}

function sanitize(raw: BoundaryValue): ProjectsState {
  if (!isJsonObject(raw)) return defaultState();
  const candidate = raw;
  const projects: PagesProject[] = [];
  if (Array.isArray(candidate.projects)) {
    for (const entry of candidate.projects) {
      if (isJsonObject(entry) && isString(entry.id) && isString(entry.name)) {
        const id = entry.id;
        const name = entry.name;
        projects.push({
          id,
          name,
          kind: id === PERSONAL_PROJECT_ID ? "personal" : "standard",
          createdAt: isString(entry.createdAt)
            ? entry.createdAt
            : new Date(0).toISOString(),
        });
      }
    }
  }
  // The personal project always exists and always comes first.
  const withoutPersonal = projects.filter(
    (project) => project.id !== PERSONAL_PROJECT_ID,
  );
  const state: ProjectsState = {
    v: 1,
    projects: [personalProject(), ...withoutPersonal],
    activeId: isString(candidate.activeId)
      ? candidate.activeId
      : PERSONAL_PROJECT_ID,
  };
  if (!state.projects.some((project) => project.id === state.activeId)) {
    state.activeId = PERSONAL_PROJECT_ID;
  }
  return state;
}

type Listener = () => void;
const listeners = new Set<Listener>();
let cached: ProjectsState | null = null;

function readState(): ProjectsState {
  const raw = kvGet(PROJECTS_KEY);
  if (!raw) return defaultState();
  try {
    return sanitize(JSON.parse(raw));
  } catch {
    return defaultState();
  }
}

function projectsStateDefault(): ProjectsState {
  if (!cached) cached = readState();
  return cached;
}

/** Re-read after OPFS hydration so pre-hydration reads don't stick. */
export function rehydrateProjects(): void {
  cached = readState();
  emit();
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribeProjectsDefault(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function writeState(next: ProjectsState): Promise<void> {
  await kvSetDurable(PROJECTS_KEY, JSON.stringify(next));
  cached = next;
  emit();
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
 */
export function scopedKey(
  base: string,
  projectId: string = activeProject().id,
): string {
  if (projectId === PERSONAL_PROJECT_ID) return base;
  return `project.${projectId}.${base}`;
}

/** Every hydratable key for a project (used before first paint and on delete). */
export function projectScopedKeys(
  projectId: string = activeProject().id,
): string[] {
  return PROJECT_SCOPED_KEYS.map((base) => scopedKey(base, projectId));
}

async function createProjectDefault(name: string): Promise<PagesProject> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Give the project a name.");
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

/**
 * Remove a project and every sealed blob stored under it. The personal
 * project is the always-present default and can never be deleted.
 */
async function deleteProjectDefault(id: string): Promise<void> {
  if (id === PERSONAL_PROJECT_ID) {
    throw new Error("The personal project cannot be deleted.");
  }
  const state = projectsState();
  if (!state.projects.some((project) => project.id === id)) return;
  await Promise.all(projectScopedKeys(id).map((key) => kvDeleteDurable(key)));
  await writeState({
    v: 1,
    projects: state.projects.filter((project) => project.id !== id),
    activeId: state.activeId === id ? PERSONAL_PROJECT_ID : state.activeId,
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
