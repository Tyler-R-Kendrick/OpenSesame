/**
 * The SOPS worker (B11, RUNTIME-02/04): a dedicated, same-origin module
 * worker that owns the engine, every data key, and every verified
 * document, so unverified content and key material never sit on the thread
 * that paints.
 *
 * It answers only the fixed operation kinds in `protocol.ts`, validates
 * every inbound message, and reports failures as typed, redacted codes —
 * a parser or provider exception never crosses back with source text in
 * it. `invalidate` drops every handle, zeroing the data keys behind them.
 */

/// <reference lib="webworker" />

import type { BoundaryValue } from "@opensesame/os-domain";
import { SopsEngine, type VerifiedDocument } from "./engine.js";
import { redactError } from "./errors.js";
import { HandleRegistry } from "./handles.js";
import {
  type SopsRequest,
  type SopsResponse,
  parseRequest,
} from "./protocol.js";

let generation = 0;
let controller = new AbortController();
const engine = new SopsEngine(
  new HandleRegistry<VerifiedDocument>(() => generation),
);

async function handle(request: SopsRequest): Promise<SopsResponse> {
  const id = request.id;
  switch (request.kind) {
    case "inspect":
      return {
        id,
        ok: true,
        kind: "inspect",
        inspection: engine.inspect(request.text, request.format),
      };
    case "open": {
      const result = await engine.open(request.text, request.format, {
        identities: request.identities,
        permit: request.permit,
        signal: controller.signal,
      });
      return {
        id,
        ok: true,
        kind: "open",
        handle: result.handle,
        plaintext: result.plaintext,
        inspection: result.inspection,
        report: result.report,
      };
    }
    case "saveEdited":
      return {
        id,
        ok: true,
        kind: "output",
        output: await engine.saveEdited(
          request.handle,
          request.edited,
          request.permit,
          controller.signal,
        ),
      };
    case "encryptNew":
      return {
        id,
        ok: true,
        kind: "output",
        output: await engine.encryptNew(request.text, {
          plan: request.plan,
          permit: request.permit,
          signal: controller.signal,
        }),
      };
    case "rotate":
      return {
        id,
        ok: true,
        kind: "output",
        output: await engine.rotate(request.handle, request.edited, {
          plan: request.plan,
          permit: request.permit,
          signal: controller.signal,
        }),
      };
    case "dispose":
      engine.dispose(request.handle);
      return { id, ok: true, kind: "done" };
    default:
      generation = request.generation;
      controller.abort();
      controller = new AbortController();
      engine.disposeAll();
      return { id, ok: true, kind: "done" };
  }
}

self.addEventListener("message", (event: MessageEvent<BoundaryValue>) => {
  void (async () => {
    let id = "";
    try {
      const request = parseRequest(event.data);
      id = request.id;
      self.postMessage(await handle(request));
    } catch (caught) {
      const error = redactError(caught, "invalid_document");
      self.postMessage({
        id,
        ok: false,
        code: error.code,
        message: error.message,
      } satisfies SopsResponse);
    }
  })();
});
