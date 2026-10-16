/** Optional tailnet families under `src/lib/` (ADR 0144, ADR 0169). */

import { optional } from "./classification-rule.js";

const L = "src/lib/";

export const NETWORK_RELAY_RULES = [
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
