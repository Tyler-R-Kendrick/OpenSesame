import type { LiveGuest } from "./guest.js";
import type { Catalog } from "./messages.js";
import { currentGuest } from "./session.js";

export type LiveCopySource =
  | Readonly<{ kind: "request"; code: string }>
  | Readonly<{ kind: "catalog"; catalog: Catalog }>;

/** Live guest memory belongs to this original session, not a vault key. */
export function pinLiveGuestCopy(
  guest: LiveGuest,
  source: LiveCopySource,
): () => void {
  guest.assertAuthority();
  const original = guest.status;
  const check = () => {
    guest.assertAuthority();
    const status = guest.status;
    const valid =
      source.kind === "request"
        ? status.at === "request" && status.code === source.code
        : status.at === "joined" &&
          status.catalog === source.catalog &&
          source.catalog.expiresAt > Date.now();
    if (currentGuest() !== guest || status !== original || !valid)
      throw new Error("The original live session no longer permits copying.");
  };
  check();
  return check;
}
