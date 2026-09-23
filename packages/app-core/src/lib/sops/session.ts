/**
 * Session binding for the browser SOPS engine (B11, RUNTIME-03).
 *
 * The vault store already bumps its `ProtectionSessionGuard` on lock,
 * logout, guest entry, and vault switch. This module rides that same
 * signal: every bump invalidates the SOPS session generation, aborts
 * pending work, and disposes every verified document (zeroing its data
 * key). Permits minted here carry the generation and the active tomb, so a
 * late completion from a previous session or another vault is refused.
 */

import { SopsEngine, type VerifiedDocument } from "./engine.js";
import { HandleRegistry } from "./handles.js";
import type { ExecutionPermit, OperationScope } from "./plan.js";
import { type SopsRunner, inlineRunner } from "./runner.js";
import { SopsWorkerClient, workerSupported } from "./worker-client.js";

export type SopsLifecycleSource = {
  /** Fires on lock, logout, guest entry, or vault switch. */
  onSessionChange(handler: () => void): () => void;
  /** The tomb the session is scoped to, or null with no session. */
  activeScope(): string | null;
};

export class SopsSession {
  #generation = 0;
  #controller = new AbortController();
  #documentGeneration = 0;
  /** The page-side engine: used directly only when there is no worker. */
  readonly engine: SopsEngine;
  /**
   * Where operations actually run. A real browser gets the dedicated
   * same-origin worker, so parsing, AES-GCM and threshold work stay off
   * the thread that paints and a lock can terminate them outright.
   */
  #runner: SopsRunner | null;

  constructor(options?: { runner?: SopsRunner }) {
    this.engine = new SopsEngine(
      new HandleRegistry<VerifiedDocument>(() => this.#generation),
    );
    this.#runner = options?.runner ?? null;
  }

  /** Chosen on first use, not at import: the host decides whether workers exist. */
  get runner(): SopsRunner {
    this.#runner ??= workerSupported()
      ? new SopsWorkerClient()
      : inlineRunner(this.engine, () => this.signal);
    return this.#runner;
  }

  get generation(): number {
    return this.#generation;
  }

  /** Aborts on the next bump; use for every asynchronous SOPS call. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** Invalidate everything: pending work, handles, and key material. */
  bump(): number {
    this.#generation += 1;
    this.#controller.abort();
    this.#controller = new AbortController();
    this.engine.disposeAll();
    this.#runner?.invalidate(this.#generation);
    return this.#generation;
  }

  /** A fresh document generation for a newly selected file. */
  nextDocument(): number {
    this.#documentGeneration += 1;
    return this.#documentGeneration;
  }

  /** A permit for local work with no provider network access. */
  permit(input: {
    vaultScope: string | null;
    documentGeneration: number;
    approvedPlanDigest?: string;
    network?: ExecutionPermit["network"];
  }): ExecutionPermit {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    const scope: OperationScope = {
      operationId: [...bytes]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
      documentGeneration: input.documentGeneration,
      sessionGeneration: this.#generation,
      vaultScope: input.vaultScope,
    };
    return {
      scope,
      approvedPlanDigest: input.approvedPlanDigest ?? "",
      network: input.network ?? "forbidden",
    };
  }

  /** True while `permit` still names the live session. */
  isLive(permit: ExecutionPermit): boolean {
    return permit.scope.sessionGeneration === this.#generation;
  }
}

/** The one session the application shares; tests build their own. */
export const sopsSession = new SopsSession();

/** Subscribe the session to the vault's lifecycle; returns the unsubscribe. */
export function bindSopsSession(
  session: SopsSession,
  source: SopsLifecycleSource,
): () => void {
  return source.onSessionChange(() => {
    session.bump();
  });
}
