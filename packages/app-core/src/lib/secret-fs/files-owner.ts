/** Owner withdrawal is a final refusal, so resilience never retries it. */
import { Effect } from "effect";
import { SecretFsRejected } from "./errors.js";

export function checkWriteOwner(path: string, check?: () => void) {
  return Effect.try({
    try: () => check?.(),
    catch: () =>
      new SecretFsRejected({
        path,
        kind: "permission",
        reason: "the original file owner ended",
      }),
  });
}
