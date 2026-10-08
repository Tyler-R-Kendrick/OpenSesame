/** Decrypted project names never outlive the session that admitted them. */
import { type BoundaryValue, isJsonObject } from "@opensesame/os-domain";
import { kvGet, kvHydrate, kvRefresh, kvSetDurable } from "./kv.js";
import { projectKey } from "./project-key.js";
import { PROJECTS_CONFIG_PATH } from "./projects-carry.js";
import {
  LEGACY_VAULT_KEYS,
  PERSONAL_PROJECT_ID,
  PROJECTS_KEY,
  type ProjectsState,
  onDeviceView,
  personalProject,
  sanitize,
} from "./projects-state.js";
import {
  TOMBS_REGISTRY_KEY,
  VfsError,
  listTombs,
  readFile,
  writeFile,
} from "./vfs.js";
type HydrationHost = {
  tomb: string;
  assertCurrent(): void;
  bootView(extra?: readonly string[]): ProjectsState;
  legacyVaultsAmong(ids: readonly string[]): Promise<string[]>;
  hasUnsealedName(): boolean;
  install(state: ProjectsState): void;
  write(state: ProjectsState): Promise<void>;
  emit(): void;
};
export async function hydrateSealedProjects(
  host: HydrationHost,
): Promise<void> {
  let sealed: ProjectsState;
  host.assertCurrent();
  try {
    const bytes = await readFile(host.tomb, PROJECTS_CONFIG_PATH);
    host.assertCurrent();
    sealed = sanitize(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (error) {
    host.assertCurrent();
    if (error instanceof VfsError && error.code === "locked") throw error;
    const boot = host.bootView();
    host.install(boot);
    if (host.hasUnsealedName()) {
      await host.write(boot);
      host.assertCurrent();
    }
    host.emit();
    return;
  }
  const ids = sealed.projects.map((project) => project.id);
  const legacy = await kvRefresh(TOMBS_REGISTRY_KEY, 1 << 20).then(
    async () => {
      host.assertCurrent();
      const result = await host.legacyVaultsAmong(ids);
      host.assertCurrent();
      return result;
    },
    () => {
      host.assertCurrent();
      return null;
    },
  );
  host.assertCurrent();
  const next = legacy ? onDeviceView(host.bootView(legacy), sealed) : sealed;
  host.install(next);
  const present = new Set(next.projects.map((project) => project.id));
  if (ids.some((id) => !present.has(id))) {
    await writeFile(
      host.tomb,
      PROJECTS_CONFIG_PATH,
      new TextEncoder().encode(JSON.stringify(next)),
    ).catch((error) => {
      host.assertCurrent();
      if (error instanceof VfsError && error.code === "locked") throw error;
    });
    host.assertCurrent();
  }
  host.emit();
}
export async function migrateSealedProjects(
  tomb: string,
  assertCurrent: () => void,
  install: (state: ProjectsState) => void,
): Promise<void> {
  assertCurrent();
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
  assertCurrent();
  await kvSetDurable(
    PROJECTS_KEY,
    JSON.stringify({ v: 1, activeId: state.activeId }),
  );
  assertCurrent();
  install(state);
}

/** Legacy header presence is pre-unlock metadata, never decrypted project names. */
export async function legacyVaultsAmong(
  ids: readonly string[],
): Promise<string[]> {
  const tombs = new Set(listTombs());
  const candidates = ids.filter((id) => !tombs.has(id));
  const keys = candidates.map((id) => projectKey(LEGACY_VAULT_KEYS[0], id));
  await kvHydrate(keys);
  return candidates.filter((_, i) => kvGet(keys[i] ?? "") !== null);
}
export const syntheticProjectsView: ProjectsState = {
  v: 1,
  projects: [personalProject()],
  activeId: PERSONAL_PROJECT_ID,
};
