/** Existing preference persistence and idle scheduling; no owner authority issuer. */
import { overlapCast } from "@opensesame/os-domain";
import { VfsError } from "../vfs.js";
import { readPrefsJson, writePrefsJson } from "./prefs-io.js";
import {
  VAULT_PREFS_REVISION,
  type VaultPrefs,
  defaultPrefs,
  normalizeVaultPrefs,
} from "./prefs.js";

export class StorePreferences {
  prefs: VaultPrefs = defaultPrefs;
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  #lastActivity = Date.now();

  persist(
    tomb: string,
    chain: Promise<void>,
    currentTomb: () => string,
    changed: () => void,
  ): Promise<void> {
    const prefs = this.prefs;
    return chain.then(() =>
      writePrefsJson(tomb, prefs).catch(async () => {
        if (this.prefs !== prefs) return;
        const durable: Partial<VaultPrefs> = overlapCast(
          await readPrefsJson(currentTomb()).catch(() => ({})),
        );
        this.prefs = normalizeVaultPrefs(durable);
        changed();
      }),
    );
  }

  async load(currentTomb: () => string): Promise<void> {
    try {
      const stored: Partial<VaultPrefs> = overlapCast(
        await readPrefsJson(currentTomb()),
      );
      this.prefs = normalizeVaultPrefs(stored);
      if ((stored.prefsRevision ?? 0) < VAULT_PREFS_REVISION) {
        await writePrefsJson(currentTomb(), this.prefs).catch(() => undefined);
      }
    } catch (error) {
      if (error instanceof VfsError && error.code === "locked") throw error;
    }
  }

  touch(): void {
    this.#lastActivity = Date.now();
  }
  stop(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }
  arm(open: boolean, lock: () => void): void {
    this.stop();
    if (!open || this.prefs.autoLockMinutes <= 0) return;
    const windowMs = this.prefs.autoLockMinutes * 60_000;
    const tick = () => {
      const idleFor = Date.now() - this.#lastActivity;
      if (idleFor >= windowMs) {
        lock();
        return;
      }
      this.#idleTimer = setTimeout(tick, Math.max(1_000, windowMs - idleFor));
    };
    this.#idleTimer = setTimeout(tick, windowMs);
  }
}
