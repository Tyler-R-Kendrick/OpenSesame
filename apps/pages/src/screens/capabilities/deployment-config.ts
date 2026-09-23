/**
 * The deployment-side document: what `os-runtime-config.json` carries under
 * `capabilityComposition` (ownership §4.4), as YAML an operator commits to
 * the deployment. Produced from the snapshot's policy; a file, not a request.
 */

import { documentToYaml } from "@opensesame/app-core/lib/configuration/capabilities-document.js";
import type { CompositionSnapshot } from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
import { overlapCast } from "@opensesame/os-domain";

export function deploymentConfigurationYaml(
  snapshot: CompositionSnapshot,
): string {
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
