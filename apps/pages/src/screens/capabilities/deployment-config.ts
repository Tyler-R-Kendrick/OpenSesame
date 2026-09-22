/**
 * The deployment-side document: what `os-runtime-config.json` carries under
 * `capabilityComposition` (ownership §4.4), as YAML an operator commits to
 * the deployment. Produced from the snapshot's policy; a file, not a request.
 */

import { overlapCast } from "@opensesame/os-domain";
import { documentToYaml } from "../../lib/configuration/capabilities-document.js";
import type { CompositionSnapshot } from "../../lib/configuration/capabilities-ports.js";

export function deploymentConfigurationYaml(snapshot: CompositionSnapshot): string {
  return documentToYaml(
    overlapCast({
      capabilityComposition: {
        schemaVersion: 1,
        instancePolicy: snapshot.policy,
      },
    }),
    "# Place under `capabilityComposition` in os-runtime-config.json of the deployment.",
  );
}
