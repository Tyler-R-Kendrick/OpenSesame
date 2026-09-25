/**
 * `enterprise.directory-provisioning`'s panels, as one set its runtime puts
 * in the Identity section's slot (`directory-panel-slot.ts`).
 */

import { AgentsPanel } from "./AgentsPanel.js";
import { DirectoryDevices } from "./DevicesPanel.js";
import { UsersPanel } from "./UsersPanel.js";
import type { DirectoryPanels } from "./directory-panel-slot.js";

export const DIRECTORY_PANELS: DirectoryPanels = {
  People: UsersPanel,
  Agents: AgentsPanel,
  Devices: DirectoryDevices,
};
