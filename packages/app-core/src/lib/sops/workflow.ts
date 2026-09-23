/**
 * The document workflow behind the SOPS sheet (B12, B13, UX-01…UX-04).
 *
 * It keeps the five intentions apart, because their disclosure differs:
 * inspect an external file, open it, save an edit under its existing
 * policy, encrypt new content under an approved plan, and rotate to a new
 * data key. Plaintext appears in the snapshot only after `open` has
 * verified every tag and the document MAC.
 *
 * The store shape matches the vault store's (`subscribe` / `getSnapshot`)
 * so a component can bind it with `useSyncExternalStore`.
 */

import type { SopsFormat } from "./document.js";
import { type SopsError, redactError } from "./errors.js";
import type { Inspection } from "./inspect.js";
import type { RecoveryReport } from "./keys/groups.js";
import type { EncryptionPlan } from "./plan.js";
import { planDigest } from "./plan.js";
import type { SopsSession } from "./session.js";

export type WorkflowPhase = "empty" | "inspected" | "open";

export type WorkflowState = {
  phase: WorkflowPhase;
  fileName: string;
  format: SopsFormat;
  /** Untrusted metadata, shown before anything is opened. */
  inspection: Inspection | null;
  /** Verified plaintext; null until `open` succeeds. */
  plaintext: string | null;
  edited: string;
  dirty: boolean;
  busy: boolean;
  /** How many groups opened, for the key-group summary. */
  report: RecoveryReport | null;
  /** A redacted, typed failure for the status line. */
  failure: { code: SopsError["code"]; message: string } | null;
};

const EMPTY: WorkflowState = {
  phase: "empty",
  fileName: "",
  format: "yaml",
  inspection: null,
  plaintext: null,
  edited: "",
  dirty: false,
  busy: false,
  report: null,
  failure: null,
};

/** A `.json` name or a leading `{` means JSON; everything else is YAML. */
export function detectFormat(fileName: string, text: string): SopsFormat {
  if (/\.json$/iu.test(fileName)) return "json";
  if (/\.ya?ml$/iu.test(fileName)) return "yaml";
  return text.trimStart().startsWith("{") ? "json" : "yaml";
}

export class SopsWorkflow {
  #state: WorkflowState = EMPTY;
  #listeners = new Set<() => void>();
  #session: SopsSession;
  #handle: string | null = null;
  #source = "";
  #documentGeneration = 0;

  constructor(session: SopsSession) {
    this.#session = session;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): WorkflowState => this.#state;

  #set(patch: Partial<WorkflowState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }

  #fail(caught: unknown): void {
    const error = redactError(caught, "invalid_document");
    this.#set({
      busy: false,
      failure: { code: error.code, message: error.message },
    });
  }

  /** Drop every reference to the open document (close, lock, vault switch). */
  close(): void {
    if (this.#handle) this.#session.runner.dispose(this.#handle);
    this.#handle = null;
    this.#source = "";
    this.#state = EMPTY;
    for (const listener of this.#listeners) listener();
  }

  /** Bounded, inert inspection of a file the person selected. */
  async selectDocument(fileName: string, text: string): Promise<void> {
    this.close();
    const format = detectFormat(fileName, text);
    this.#documentGeneration = this.#session.nextDocument();
    this.#source = text;
    this.#set({
      phase: "inspected",
      fileName,
      format,
      inspection: null,
      failure: null,
      busy: true,
    });
    try {
      const inspection = await this.#session.runner.inspect(text, format);
      this.#set({ inspection, busy: false });
    } catch (caught) {
      this.#fail(caught);
    }
  }

  #permit(vaultScope: string | null, digest?: string) {
    const scope = { vaultScope, documentGeneration: this.#documentGeneration };
    if (digest === undefined) return this.#session.permit(scope);
    return this.#session.permit({ ...scope, approvedPlanDigest: digest });
  }

  /** Recover the data key, verify, and release the plaintext to the editor. */
  async open(
    identities: readonly string[],
    vaultScope: string | null,
  ): Promise<void> {
    if (this.#state.phase === "empty") return;
    this.#set({ busy: true, failure: null });
    try {
      const result = await this.#session.runner.open(
        this.#source,
        this.#state.format,
        identities,
        this.#permit(vaultScope),
      );
      this.#handle = result.handle;
      this.#set({
        phase: "open",
        plaintext: result.plaintext,
        edited: result.plaintext,
        dirty: false,
        busy: false,
        report: result.report,
        inspection: result.inspection,
      });
    } catch (caught) {
      this.#fail(caught);
    }
  }

  setEdited(text: string): void {
    if (this.#state.phase !== "open") return;
    this.#set({ edited: text, dirty: text !== this.#state.plaintext });
  }

  /** Re-encrypt under the same data key, recipients, and policy. */
  async saveEncrypted(vaultScope: string | null): Promise<string | null> {
    const handle = this.#handle;
    if (!handle || this.#state.phase !== "open") return null;
    this.#set({ busy: true, failure: null });
    try {
      const output = await this.#session.runner.saveEdited(
        handle,
        this.#state.edited,
        this.#permit(vaultScope),
      );
      this.#set({ busy: false, plaintext: this.#state.edited, dirty: false });
      return output;
    } catch (caught) {
      this.#fail(caught);
      return null;
    }
  }

  /**
   * The bytes a new-document encryption protects: the edited text once a
   * document is open, and otherwise the file exactly as it was selected.
   */
  contentForEncryption(): string {
    return this.#state.phase === "open" ? this.#state.edited : this.#source;
  }

  /** A new document under a fresh data key and an approved plan. */
  async encryptNew(
    text: string,
    plan: EncryptionPlan,
    vaultScope: string | null,
  ): Promise<string | null> {
    this.#set({ busy: true, failure: null });
    try {
      const digest = await planDigest(plan);
      const output = await this.#session.runner.encryptNew(
        text,
        plan,
        this.#permit(vaultScope, digest),
      );
      this.#set({ busy: false });
      return output;
    } catch (caught) {
      this.#fail(caught);
      return null;
    }
  }

  /** Rotate the open document onto a new data key and recipient set. */
  async rotate(
    plan: EncryptionPlan,
    vaultScope: string | null,
  ): Promise<string | null> {
    const handle = this.#handle;
    if (!handle || this.#state.phase !== "open") return null;
    this.#set({ busy: true, failure: null });
    try {
      const digest = await planDigest(plan);
      const output = await this.#session.runner.rotate(
        handle,
        this.#state.edited,
        plan,
        this.#permit(vaultScope, digest),
      );
      this.#set({ busy: false, plaintext: this.#state.edited, dirty: false });
      return output;
    } catch (caught) {
      this.#fail(caught);
      return null;
    }
  }
}
