/**
 * Taking a claim link out of the address (ADR 0140 plan step 4).
 *
 * `/claim#token=osc_clm_…` is an ownership claim; with `&key=…` beside the
 * bearer it is a secret drop, handed to the drop code (`vault/drop.ts`) and
 * never stashed — a drop opens in one sitting. The dispatch is ceremony-kit's
 * `readClaimLink`, the same one the standalone apps make.
 *
 * Either way the fragment leaves history before anything is presented, so a
 * reload, a bookmark or a shared screen never carries a bearer. A bearer that
 * arrived in the query string was already written to a request line and a
 * server log (os-domain `FORBIDDEN_URL_PARAMS`): it is scrubbed and refused,
 * never presented.
 */

import {
  type ClaimLink,
  fragmentCarriesBearer,
  readClaimLink,
} from "@opensesame/ceremony-kit";
import { maybePage } from "../../ports.js";

export type ClaimArrival = ClaimLink | { kind: "leaked" } | { kind: "none" };

type Address = { pathname: string; search: string; hash: string };

/** `?…` with the leaked bearer and its key taken out, and nothing else. */
function withoutBearer(search: string): string {
  const params = new URLSearchParams(search.replace(/^\?/, ""));
  params.delete("token");
  params.delete("key");
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

/**
 * Read an address: what arrived, and the address to replace it with when a
 * bearer or key must leave it (`null` when nothing needs to change).
 */
export function readClaimArrival(address: Address): {
  arrival: ClaimArrival;
  scrubbed: string | null;
} {
  const { pathname, search, hash } = address;
  const queried = new URLSearchParams(search.replace(/^\?/, ""));
  const leaked = (queried.get("token") ?? "").startsWith("osc_clm_");
  const cleanSearch = leaked ? withoutBearer(search) : search;
  const carries = fragmentCarriesBearer(hash);
  const scrubbed =
    leaked || carries
      ? `${pathname}${cleanSearch}${carries ? "" : hash}`
      : null;
  if (leaked) return { arrival: { kind: "leaked" }, scrubbed };
  return { arrival: readClaimLink(hash) ?? { kind: "none" }, scrubbed };
}

/** Take a claim link out of this page's address, before anything renders. */
export function captureClaimLink(): ClaimArrival {
  const page = maybePage();
  if (!page) return { kind: "none" };
  const { arrival, scrubbed } = readClaimArrival(page.location);
  if (scrubbed !== null) page.replaceUrl(scrubbed);
  return arrival;
}
