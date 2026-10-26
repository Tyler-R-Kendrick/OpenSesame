import { createHash, randomUUID } from "node:crypto";
import { refuse } from "./daemon-admission.mjs";

/** Independent test operator seam, never exposed by an HTTP route. */
export function createOperatorApproval(required) {
  const pending = new Map();
  const approved = new Map();
  return {
    authorized(who, res, operation) {
      if (!required()) return true;
      const tokenDigest = createHash("sha256").update(who.token).digest("hex");
      const key = JSON.stringify([who.origin, tokenDigest, operation]);
      const until = approved.get(key);
      if (until > Date.now()) {
        if (operation.field) approved.delete(key);
        return true;
      }
      if (![...pending.values()].some((row) => row.key === key)) {
        const id = randomUUID();
        pending.set(id, { id, extension: who.origin, ...operation, key });
      }
      refuse(res, 403, "approval_required");
      return false;
    },
    requests: () => [...pending.values()].map(({ key: _key, ...row }) => row),
    authorize(id) {
      const request = pending.get(id);
      if (!request) throw new Error("no such approval request");
      pending.delete(id);
      approved.set(request.key, Date.now() + 90_000);
    },
  };
}
