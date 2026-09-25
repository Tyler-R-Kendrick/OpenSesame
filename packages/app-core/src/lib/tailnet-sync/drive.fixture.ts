/** An in-memory drive with the daemon's compare-and-set rule, for tests. */
import type { DriveRead, DriveWrite } from "./client.js";
import type { DriveTransport } from "./engine.js";
import type { DrivePairing } from "./pairing.js";
import type { DriveSnapshot } from "./snapshot.js";

export type MemoryDrive = DriveTransport & {
  generation: number;
  snapshot: DriveSnapshot | null;
  writes: number;
  /** Runs before the next write is judged — another device racing this one. */
  beforeWrite: (() => void) | null;
};

export function memoryDrive(): MemoryDrive {
  const drive: MemoryDrive = {
    generation: 0,
    snapshot: null,
    writes: 0,
    beforeWrite: null,
    async read(): Promise<DriveRead> {
      return {
        generation: drive.generation,
        snapshot: drive.snapshot ? structuredClone(drive.snapshot) : null,
      };
    },
    async write(_pairing, expected, snapshot): Promise<DriveWrite> {
      const race = drive.beforeWrite;
      drive.beforeWrite = null;
      race?.();
      if (expected !== drive.generation) {
        return { ok: false, generation: drive.generation };
      }
      drive.generation += 1;
      drive.writes += 1;
      drive.snapshot = structuredClone(snapshot);
      return { ok: true, generation: drive.generation };
    },
  };
  return drive;
}

export const PAIRING: DrivePairing = {
  url: "https://desk.tail1234.ts.net",
  slot: "slot-0000aaaa",
  key: "k".repeat(43),
  label: "Desk",
};
