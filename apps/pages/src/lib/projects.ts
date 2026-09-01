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

import { kvDeleteDurable, kvGet, kvSetDurable } from "./kv.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  VfsError,
  deleteFile,
  deletePlaintextFile,
  listTombs,
  readFile,
  tombUnlocked,
  unregisterTomb,
  writeFile,
} from "./vfs.js";

/**
 * Boot record key — plaintext `{ v: 1, activeId }`. The active tomb pointer
 * is a tomb name, and tomb names are not secrets (ADR 0063).
 */
export const PROJECTS_KEY = "projects.v1";
/** Sealed VFS path (within a tomb) holding this tomb's projects view. */
export const PROJECTS_CONFIG_PATH = "config/projects";
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

type BootRecord = { v: 1; activeId: string };

/**
 * Base KV keys that are stored once per project rather than per device.
 * The vault header/body/prefs left this list for tomb paths (ADR 0063);
 * lockout counters stay plaintext at their scoped key by design.
 */
export const PROJECT_SCOPED_KEYS = [
  "vault.attempts.v1",
  "site-broker.consents.v1",
  "site-broker.policy.v1",
] as const;

/** Legacy flat vault keys — hydrated only so the tomb migration can move them. */
const LEGACY_VAULT_KEYS = [
  "vault.header.v1",
  "vault.body.v1",
  "vault.prefs.v1", // gitleaks:allow -- storage key, not a credential
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

/** The plaintext boot pointer — just the active tomb name. */
function readBootActiveId(): string {
  const raw = kvGet(PROJECTS_KEY);
  if (!raw) return PERSONAL_PROJECT_ID;
  try {
    const parsed: BoundaryValue = JSON.parse(raw);
    if (isJsonObject(parsed) && isString(parsed.activeId)) {
      return parsed.activeId;
    }
  } catch {
    /* fall through to personal */
  }
  return PERSONAL_PROJECT_ID;
}

/**
 * The pre-unlock view: tomb names from the plaintext registry (display names
 * are sealed — ids stand in until unlock), active pointer from the boot
 * record. The personal tomb always exists and comes first. The boot pointer
 * is kept even when its tomb has no material yet (a project created moments
 * ago registers only when its first header lands).
 */
function bootView(): ProjectsState {
  const activeId = readBootActiveId();
  const ids = new Set<string>([PERSONAL_PROJECT_ID, ...listTombs(), activeId]);
  const projects: PagesProject[] = [personalProject()];
  for (const id of [...ids].sort()) {
    if (id === PERSONAL_PROJECT_ID) continue;
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

type Listener = () => void;
const listeners = new Set<Listener>();
let cached: ProjectsState | null = null;
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

function projectsStateDefault(): ProjectsState {
  if (!cached) cached = bootView();
  return cached;
}

/** Re-read the boot view (pre-unlock, and again on lock). */
export function rehydrateProjects(): void {
  cached = bootView();
  activeTomb = null;
  emit();
}

/**
 * Fill the projects view from the tomb's sealed config on unlock, after the
 * migration has moved any legacy plaintext record. Without a sealed copy the
 * boot view stands — ids in place of names until the first write.
 */
export async function hydrateProjectsFromVfs(tomb: string): Promise<void> {
  activeTomb = tomb;
  try {
    const bytes = await readFile(tomb, PROJECTS_CONFIG_PATH);
    cached = sanitize(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (error) {
    if (error instanceof VfsError && error.code === "locked") throw error;
    // No sealed copy yet — a tomb sealed moments ago from the vault switcher.
    // The boot view carries any name typed in this tab (`unsealedNames`);
    // seal it here now rather than leaving it to the next mutation.
    cached = bootView();
    if (unsealedNames.has(tomb) && tombUnlocked(tomb)) {
      await writeState(cached);
      return;
    }
  }
  emit();
}

/**
 * Legacy migration (phase C, on unlock): a full plaintext `projects.v1`
 * record seals into this tomb's config and the plaintext key shrinks to the
 * boot pointer. Sealed first, shrunk second — a crash between the two simply
 * re-runs.
 */
export async function migrateProjectsToVfs(tomb: string): Promise<void> {
  const raw = kvGet(PROJECTS_KEY);
  if (!raw) return;
  let parsed: BoundaryValue;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!isJsonObject(parsed) || !Array.isArray(parsed.projects)) return;
  const state = sanitize(parsed);
  await writeFile(
    tomb,
    PROJECTS_CONFIG_PATH,
    new TextEncoder().encode(JSON.stringify(state)),
  );
  const boot: BootRecord = { v: 1, activeId: state.activeId };
  await kvSetDurable(PROJECTS_KEY, JSON.stringify(boot));
  cached = state;
  activeTomb = tomb;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribeProjectsDefault(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function writeState(next: ProjectsState): Promise<void> {
  // The boot pointer is the durable, pre-unload-critical part; the sealed
  // per-tomb copy refreshes on every mutation while a tomb is unlocked.
  const boot: BootRecord = { v: 1, activeId: next.activeId };
  await kvSetDurable(PROJECTS_KEY, JSON.stringify(boot));
  cached = next;
  const tomb = activeTomb;
  if (tomb && tombUnlocked(tomb)) {
    await writeFile(
      tomb,
      PROJECTS_CONFIG_PATH,
      new TextEncoder().encode(JSON.stringify(next)),
    );
    // This tomb's own name is sealed in its own view now; a sibling's name
    // in this view says nothing about the sibling's tomb, so it stays.
    unsealedNames.delete(tomb);
  }
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
): Promise<void> {
  if (!tombUnlocked(tomb)) return;
  try {
    await readFile(tomb, PROJECTS_CONFIG_PATH);
    return;
  } catch (error) {
    if (error instanceof VfsError && error.code === "locked") throw error;
  }
  activeTomb = tomb;
  const merged = withKnownNames(bootView(), previous);
  await writeState({ ...merged, activeId: readBootActiveId() });
}

function withKnownNames(
  next: ProjectsState,
  previous: ProjectsState,
): ProjectsState {
  const known = new Map(
    previous.projects
      .filter((project) => project.name !== project.id)
      .map((project) => [project.id, project] as const),
  );
  return {
    ...next,
    projects: next.projects.map((project) => {
      const seen = known.get(project.id);
      return seen && project.name === project.id
        ? { ...project, name: seen.name, createdAt: seen.createdAt }
        : project;
    }),
  };
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
  unsealedNames.delete(id);
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
