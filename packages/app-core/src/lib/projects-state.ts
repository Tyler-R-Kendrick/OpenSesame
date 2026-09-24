import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
/**
 * The projects list as data: its shape and the one parser every stored copy
 * (a tomb's sealed view, a legacy plaintext record) goes through. Split from
 * `projects.ts` for the module budget (ADR 0093).
 */

import { GUEST_TOMB } from "./vfs.js";

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

export function personalProject(): PagesProject {
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

export function sanitize(raw: BoundaryValue): ProjectsState {
  if (!isJsonObject(raw)) return defaultState();
  const candidate = raw;
  const projects: PagesProject[] = [];
  if (Array.isArray(candidate.projects)) {
    for (const entry of candidate.projects) {
      if (isJsonObject(entry) && isString(entry.id) && isString(entry.name)) {
        const id = entry.id;
        const name = entry.name;
        // Guest is a session road (GUEST_TOMB), never a project in the list.
        if (id === GUEST_TOMB) continue;
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

/** `next`, with names and dates from `previous` where `next` only has ids. */
export function withKnownNames(
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

/**
 * The list after unlock: the vaults on this device (`boot`), in the order
 * the sealed view recorded them, then any it never knew, named where it can.
 */
export function onDeviceView(
  boot: ProjectsState,
  sealed: ProjectsState,
): ProjectsState {
  const present = new Set(boot.projects.map((project) => project.id));
  const kept = sealed.projects.filter((project) => present.has(project.id));
  const known = new Set(kept.map((project) => project.id));
  const rest = withKnownNames(
    { ...boot, projects: boot.projects.filter((p) => !known.has(p.id)) },
    sealed,
  );
  return { ...boot, projects: [...kept, ...rest.projects] };
}
