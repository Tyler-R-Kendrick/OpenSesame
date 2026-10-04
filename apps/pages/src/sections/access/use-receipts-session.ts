import { useIdentitySession } from "../../bindings/identity.js";
import {
  useIdentityPlane,
  useIdentityServes,
} from "../../lib/use-configured.js";
import { useVault } from "../../lib/vault/hooks.js";

/** Who a trail on screen belongs to: what a different one must not land under. */
export type ReceiptsReader = Readonly<{ key: string }>;

/**
 * Who Access › Receipts reads a trail for, or null when there is nothing to
 * read: an Identity plane that serves no audit trail, or a remote one with no
 * session to ask it with.
 *
 * The device is its own plane (ADR 0160) and its trail is the open vault's
 * (ADR 0162), so there it is the vault that is read for and no session needs
 * to be held first: the panel's read mints the device's own session when it
 * needs one. A remote plane still answers only a session it knows.
 */
export function useReceiptsSession(): ReceiptsReader | null {
  const session = useIdentitySession();
  const audit = useIdentityServes("audit");
  const plane = useIdentityPlane();
  const { tomb } = useVault();
  if (!audit) return null;
  if (plane === "device") return { key: tomb };
  return session ? { key: session.principalId } : null;
}
