/** The optional live-session banner is supplied by its capability wrapper. */
import { useVaultShare } from "../../components/vault-share-seat.js";

export function LiveSessionBanner() {
  const Banner = useVaultShare()?.Banner;
  return Banner ? <Banner /> : null;
}
