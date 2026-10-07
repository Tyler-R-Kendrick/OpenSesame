import { continueToolRead } from "./tool-shared.js";
/**
 * Read-only settings summary. It reports which model plane runs the
 * password-reset ceremony, so it reads the model-provider record and the
 * browser-inference verdict — `support.local-ai`'s code — and is therefore
 * contributed by that capability. Endpoints that would tell a caller where
 * to aim a redirect are omitted (ADR 0087).
 */

import { browserInference } from "../lib/browser-inference.js";
import {
  autonomousResetAvailable,
  loadModelProvider,
  resolveModelPlane,
} from "../lib/model-provider.js";
import { loadSettings } from "../lib/settings.js";
import type { PagesWebMcpTool } from "./tool-shared.js";

export const SETTINGS_READ_TOOL: PagesWebMcpTool = {
  name: "opensesame_settings_read",
  // The operation that owns the tool (support.local-ai registers it, and the
  // model plane is what it reports). It used to also name configs.browse,
  // sync_targets.read and backup.status, none of which it returns.
  capabilityIds: ["model_plane.read"],
  scope: "session",
  readOnly: true,
  description:
    "Read-only settings summary: the active project, capability-connector bindings, and which plane runs the password-reset model. Values that could carry credentials are omitted, and the plane is reported but never chosen here (ADR 0087).",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  execute: async (_args, ceiling) => {
    const settings = loadSettings();
    // Reported so an agent does not offer a ceremony that cannot run. Which
    // plane, and whether it is on — never the endpoint, which would tell a
    // caller where to aim a redirect it is not allowed to make (ADR 0087).
    const plane = resolveModelPlane(
      loadModelProvider(),
      await continueToolRead(() => browserInference(), ceiling),
    );
    return {
      identityApi: settings.identityApi,
      activeProjectId: settings.activeProjectId ?? null,
      capabilityConnectors: settings.capabilityConnectors,
      modelPlane: {
        kind: plane.kind,
        because: plane.because,
        autonomousResetAvailable: autonomousResetAvailable(plane),
      },
    };
  },
};
