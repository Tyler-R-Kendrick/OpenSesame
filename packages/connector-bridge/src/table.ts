import type { BridgeTable } from "./policy.js";
import { BRIDGE_TABLE } from "./table.generated.js";

/** The providers a browser cannot reach by itself, and the hosts the bridge may send them to. */
export const connectorBridgeTable: BridgeTable = BRIDGE_TABLE;
