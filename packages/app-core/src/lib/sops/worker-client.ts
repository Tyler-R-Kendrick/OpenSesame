/**
 * The page-side client for `sops.worker.ts` (B11, RUNTIME-02).
 *
 * One worker per session. Every reply is validated before it reaches the
 * UI, replies for operations that are no longer live are dropped, and
 * `invalidate` both tells the worker to zero its handles and terminates it
 * when the session ends, so no unabortable call can deliver later.
 */

import type { BoundaryValue } from "@opensesame/os-domain";
import type { SopsFormat } from "./document.js";
import { SopsError } from "./errors.js";
import type { Inspection } from "./inspect.js";
import type { EncryptionPlan, ExecutionPermit } from "./plan.js";
import {
  type SopsRequestBody,
  type SopsResponse,
  parseResponse,
} from "./protocol.js";
import type { OpenOutcome, SopsRunner } from "./runner.js";

type Pending = {
  resolve: (value: SopsResponse) => void;
  reject: (reason: SopsError) => void;
};

/** True when this runtime can host a same-origin module worker. */
export function workerSupported(): boolean {
  return "Worker" in globalThis && "URL" in globalThis;
}

export class SopsWorkerClient implements SopsRunner {
  #worker: Worker | null = null;
  #pending = new Map<string, Pending>();
  #counter = 0;

  #ensure(): Worker {
    if (this.#worker) return this.#worker;
    const worker = new Worker(new URL("./sops.worker.ts", import.meta.url), {
      type: "module",
      name: "opensesame-sops",
    });
    worker.addEventListener("message", (event: MessageEvent<BoundaryValue>) => {
      let response: SopsResponse;
      try {
        response = parseResponse(event.data);
      } catch {
        return;
      }
      const pending = this.#pending.get(response.id);
      if (!pending) return;
      this.#pending.delete(response.id);
      if (response.ok) pending.resolve(response);
      else pending.reject(new SopsError(response.code, response.message));
    });
    worker.addEventListener("error", () => {
      for (const pending of this.#pending.values()) {
        pending.reject(new SopsError("canceled", "The SOPS worker stopped."));
      }
      this.#pending.clear();
      this.#worker = null;
    });
    this.#worker = worker;
    return worker;
  }

  #send(request: SopsRequestBody): Promise<SopsResponse> {
    this.#counter += 1;
    const id = `op${this.#counter}`;
    const worker = this.#ensure();
    return new Promise<SopsResponse>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      worker.postMessage({ ...request, id });
    });
  }

  async inspect(text: string, format: SopsFormat): Promise<Inspection> {
    const response = await this.#send({ kind: "inspect", text, format });
    if (response.ok && response.kind === "inspect") return response.inspection;
    throw new SopsError(
      "invalid_document",
      "The worker returned an unexpected result.",
    );
  }

  async open(
    text: string,
    format: SopsFormat,
    identities: readonly string[],
    permit: ExecutionPermit,
  ): Promise<OpenOutcome> {
    const response = await this.#send({
      kind: "open",
      text,
      format,
      identities: [...identities],
      permit,
    });
    if (response.ok && response.kind === "open") {
      return {
        handle: response.handle,
        plaintext: response.plaintext,
        inspection: response.inspection,
        report: response.report,
      };
    }
    throw new SopsError(
      "invalid_document",
      "The worker returned an unexpected result.",
    );
  }

  async #output(request: SopsRequestBody): Promise<string> {
    const response = await this.#send(request);
    if (response.ok && response.kind === "output") return response.output;
    throw new SopsError(
      "invalid_document",
      "The worker returned an unexpected result.",
    );
  }

  saveEdited(
    handle: string,
    edited: string,
    permit: ExecutionPermit,
  ): Promise<string> {
    return this.#output({ kind: "saveEdited", handle, edited, permit });
  }

  encryptNew(
    text: string,
    plan: EncryptionPlan,
    permit: ExecutionPermit,
  ): Promise<string> {
    return this.#output({ kind: "encryptNew", text, plan, permit });
  }

  rotate(
    handle: string,
    edited: string | null,
    plan: EncryptionPlan,
    permit: ExecutionPermit,
  ): Promise<string> {
    return this.#output({ kind: "rotate", handle, edited, plan, permit });
  }

  dispose(handle: string): void {
    if (this.#worker)
      void this.#send({ kind: "dispose", handle }).catch(() => undefined);
  }

  /** Zero the worker's handles, fail every pending call, and end the worker. */
  invalidate(generation: number): void {
    for (const pending of this.#pending.values()) {
      pending.reject(
        new SopsError(
          "stale_session",
          "The session changed while the operation was pending.",
        ),
      );
    }
    this.#pending.clear();
    const worker = this.#worker;
    if (!worker) return;
    worker.postMessage({ id: "invalidate", kind: "invalidate", generation });
    worker.terminate();
    this.#worker = null;
  }
}
