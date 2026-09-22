/**
 * The seam between the workflow and wherever the engine actually runs
 * (B11, RUNTIME-01/02): the same five operations, either on this thread or
 * in a dedicated same-origin worker.
 *
 * The worker is a scheduling and lifetime boundary — it keeps parsing,
 * AES-GCM and threshold work off the thread that paints, and it lets a
 * lock terminate in-flight work outright. It is not a defense against
 * malicious same-origin code, and nothing here pretends otherwise.
 */

import type { SopsFormat } from "./document.js";
import type { SopsEngine } from "./engine.js";
import type { Inspection } from "./inspect.js";
import type { RecoveryReport } from "./keys/groups.js";
import type { EncryptionPlan, ExecutionPermit } from "./plan.js";

export type OpenOutcome = {
  handle: string;
  plaintext: string;
  inspection: Inspection;
  report: RecoveryReport;
};

export type SopsRunner = {
  inspect(text: string, format: SopsFormat): Promise<Inspection>;
  open(
    text: string,
    format: SopsFormat,
    identities: readonly string[],
    permit: ExecutionPermit,
  ): Promise<OpenOutcome>;
  saveEdited(
    handle: string,
    edited: string,
    permit: ExecutionPermit,
  ): Promise<string>;
  encryptNew(
    text: string,
    plan: EncryptionPlan,
    permit: ExecutionPermit,
  ): Promise<string>;
  rotate(
    handle: string,
    edited: string | null,
    plan: EncryptionPlan,
    permit: ExecutionPermit,
  ): Promise<string>;
  dispose(handle: string): void;
  /** Drop every handle and terminate in-flight work. */
  invalidate(generation: number): void;
};

/** Run the engine on the calling thread (tests, and the worker itself). */
export function inlineRunner(
  engine: SopsEngine,
  signal: () => AbortSignal,
): SopsRunner {
  return {
    inspect: async (text, format) => engine.inspect(text, format),
    open: async (text, format, identities, permit) =>
      engine.open(text, format, {
        identities: [...identities],
        permit,
        signal: signal(),
      }),
    saveEdited: (handle, edited, permit) =>
      engine.saveEdited(handle, edited, permit, signal()),
    encryptNew: (text, plan, permit) =>
      engine.encryptNew(text, { plan, permit, signal: signal() }),
    rotate: (handle, edited, plan, permit) =>
      engine.rotate(handle, edited, { plan, permit, signal: signal() }),
    dispose: (handle) => engine.dispose(handle),
    invalidate: () => engine.disposeAll(),
  };
}
