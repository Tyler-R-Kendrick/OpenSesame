/** Optional tailnet families under `src/lib/` (ADR 0144, ADR 0169). */

import { optional, shared } from "./classification-rule.js";

const L = "src/lib/";

export const NETWORK_RELAY_RULES = [
  shared(
    `${L}tailscale/browser-node-`,
    "browser node port and encrypted state records shared by Networking and Connections",
  ),
  shared(
    `${L}secret-backends/local-vault-port`,
    "vault session lifetime checks shared by secret backends and the browser node",
  ),
  shared(
    `${L}secret-backends/types`,
    "pure secret backend contracts and errors used by shared vault session checks",
  ),
  optional(
    `${L}tailnet-sync/`,
    "networking.tailnet",
    "tailnet vault sync: drive client, merge pass, adoption (ADR 0144)",
  ),
  optional(
    `${L}tailnet-admin/`,
    "networking.tailnet-devices",
    "tailnet device management: daemon client, sealed pairing, device model (ADR 0169)",
  ),
];
