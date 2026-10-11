/**
 * A refused key, said in a sentence a person can act on (ADR 0188 §6).
 *
 * The broker's reasons are stable machine words, value-blind by design. The
 * sheet turns the ones a person can cause into the step that fixes them and
 * says nothing more about the rest, because a sentence that explains the
 * broker's internals is a sentence an agent could use to probe it.
 */
import type { BoundaryValue } from "@opensesame/os-domain";
import { isRefusal } from "./errors.js";

const SENTENCE = new Map([
  ["broker.unavailable", "Turn on External connectors to create keys."],
  ["draft.connection", "Verify this provider's key before creating one."],
  ["draft.resource", "This provider cannot be given keys."],
  [
    "draft.identifier",
    "Name the app or agent with letters, digits and . _ : @ -",
  ],
  ["lifetime.ceiling", "A key cannot last that long."],
  ["budget.ceiling", "That budget is larger than keys may carry."],
  ["dpop.required", "Keys here must be bound to the app's own key."],
  ["models.entry", "A model is its id, a namespace/*, or *."],
  ["models.shape", "List between one and thirty-two models."],
]);

const GENERIC = "The key could not be created.";

export function describeMintFailure(error: BoundaryValue): string {
  if (isRefusal(error)) {
    if (error.reason.startsWith("approval."))
      return "The approval was not accepted.";
    return SENTENCE.get(error.reason) ?? GENERIC;
  }
  // The vault's own refusals (who may manage grants, a duress ceiling) are already sentences.
  if (error instanceof Error && error.message !== "") return error.message;
  return GENERIC;
}
