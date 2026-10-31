/** Sealed project-view lifetime: a retired hydration never republishes decrypted names. */
import { type BoundaryValue, isJsonObject } from "@opensesame/os-domain";
import { kvGet, kvRefresh, kvSetDurable } from "./kv.js";
import {
  type BootRecord,
  PERSONAL_PROJECT_ID,
  PROJECTS_KEY,
  type PagesProject,
  type ProjectsState,
  onDeviceView,
  personalProject,
  readBootActiveId,
  sanitize,
  withKnownNames,
} from "./projects-state.js";
import {
  GUEST_TOMB,
  TOMBS_REGISTRY_KEY,
  VfsError,
  listTombs,
  readFile,
  tombUnlocked,
  writeFile,
} from "./vfs.js";

export const PROJECTS_CONFIG_PATH = "config/projects";

export class ProjectSession {
  readonly unsealedNames = new Map<
    string,
    Pick<PagesProject, "name" | "createdAt">
  >();
  #cached: ProjectsState | null = null;
  #activeTomb: string | null = null;
  #generation = 0;
  #changed: () => void;
  #legacy: (ids: readonly string[]) => Promise<string[]>;

  constructor(
    changed: () => void,
    legacy: (ids: readonly string[]) => Promise<string[]>,
  ) {
    this.#changed = changed;
    this.#legacy = legacy;
  }

  get activeTomb(): string | null {
    return this.#activeTomb;
  }

  boot(extra: readonly string[] = []): ProjectsState {
    const activeId = readBootActiveId();
    const ids = new Set([
      PERSONAL_PROJECT_ID,
      ...listTombs(),
      activeId,
      ...extra,
    ]);
    const projects: PagesProject[] = [personalProject()];
    for (const id of [...ids].sort()) {
      if (id === PERSONAL_PROJECT_ID || id === GUEST_TOMB) continue;
      const known = this.unsealedNames.get(id);
      projects.push({
        id,
        name: known?.name ?? id,
        kind: "standard",
        createdAt: known?.createdAt ?? new Date(0).toISOString(),
      });
    }
    return { v: 1, projects, activeId };
  }

  state(): ProjectsState {
    if (!this.#cached) this.#cached = this.boot();
    return this.#cached;
  }

  reset(): void {
    this.#generation++;
    this.#cached = this.boot();
    this.#activeTomb = null;
    this.#changed();
  }

  #start(tomb: string, original: () => void): () => void {
    original();
    const generation = ++this.#generation;
    this.#activeTomb = tomb;
    return () => {
      original();
      if (this.#generation !== generation || this.#activeTomb !== tomb)
        throw new VfsError(
          "locked",
          "The original project-view session ended.",
        );
    };
  }

  async hydrate(tomb: string, original: () => void): Promise<void> {
    const check = this.#start(tomb, original);
    let sealed: ProjectsState;
    try {
      const bytes = await readFile(tomb, PROJECTS_CONFIG_PATH);
      check();
      sealed = sanitize(JSON.parse(new TextDecoder().decode(bytes)));
    } catch (error) {
      check();
      if (error instanceof VfsError && error.code === "locked") throw error;
      this.#cached = this.boot();
      if (this.unsealedNames.has(tomb) && tombUnlocked(tomb))
        return this.write(this.#cached);
      return this.#changed();
    }
    const ids = sealed.projects.map((project) => project.id);
    const legacy = await kvRefresh(TOMBS_REGISTRY_KEY, 1 << 20).then(
      () => this.#legacy(ids),
      () => null,
    );
    check();
    const next = legacy ? onDeviceView(this.boot(legacy), sealed) : sealed;
    this.#cached = next;
    const present = new Set(next.projects.map((project) => project.id));
    if (ids.some((id) => !present.has(id))) {
      const bytes = new TextEncoder().encode(JSON.stringify(next));
      await writeFile(tomb, PROJECTS_CONFIG_PATH, bytes).catch((error) => {
        if (error instanceof VfsError && error.code === "locked") throw error;
      });
      check();
    }
    this.#changed();
  }

  async migrate(tomb: string, original: () => void): Promise<void> {
    const raw = kvGet(PROJECTS_KEY);
    if (!raw) return;
    let parsed: BoundaryValue;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isJsonObject(parsed) || !Array.isArray(parsed.projects)) return;
    const check = this.#start(tomb, original);
    const state = sanitize(parsed);
    await writeFile(
      tomb,
      PROJECTS_CONFIG_PATH,
      new TextEncoder().encode(JSON.stringify(state)),
    );
    check();
    const boot: BootRecord = { v: 1, activeId: state.activeId };
    await kvSetDurable(PROJECTS_KEY, JSON.stringify(boot));
    check();
    this.#cached = state;
  }

  async write(next: ProjectsState): Promise<void> {
    const generation = ++this.#generation;
    const tomb = this.#activeTomb;
    const boot: BootRecord = { v: 1, activeId: next.activeId };
    await kvSetDurable(PROJECTS_KEY, JSON.stringify(boot));
    if (generation !== this.#generation) return;
    this.#cached = next;
    if (tomb && tombUnlocked(tomb)) {
      await writeFile(
        tomb,
        PROJECTS_CONFIG_PATH,
        new TextEncoder().encode(JSON.stringify(next)),
      );
      if (generation !== this.#generation) return;
      this.unsealedNames.delete(tomb);
    }
    this.#changed();
  }

  async carry(tomb: string, previous: ProjectsState): Promise<void> {
    if (!tombUnlocked(tomb)) return;
    const generation = this.#generation;
    try {
      await readFile(tomb, PROJECTS_CONFIG_PATH);
      return;
    } catch (error) {
      if (error instanceof VfsError && error.code === "locked") throw error;
    }
    if (generation !== this.#generation) return;
    this.#activeTomb = tomb;
    const merged = withKnownNames(this.boot(), previous);
    await this.write({ ...merged, activeId: readBootActiveId() });
  }
}
