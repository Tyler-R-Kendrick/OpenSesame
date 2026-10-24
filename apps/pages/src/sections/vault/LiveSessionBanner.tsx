/**
 * A joined live session inside the vault. The vault is the joiner's own; the
 * shared catalog stays live in this tab. This is the link between the two, so
 * a person who enters the vault can still see and reopen what the owner
 * shared.
 */

import { useVaultShare } from "../../components/vault-share-seat.js";

/** The live capability provides the view; the vault owns only its seat. */
export function LiveSessionBanner() {
  const Banner = useVaultShare()?.Banner;
  return Banner ? <Banner /> : null;
}
