/**
 * Test fixture: declares the Connections guide targets the way
 * `connectors.external` declares them on activation, so a panel that mounts
 * one (`connections.back`, `connections.authorize`, `connections.connected`,
 * …) can render in a unit test.
 *
 * A suite that describes a deployment which approved the connectors
 * capability calls this once at the top of the file; the default, with
 * nothing declared, is the core-only corpus and a mounted Connections target
 * still fails closed with `guide_target_undeclared` (ADR 0088/0130).
 */

import { afterEach, beforeEach } from "vitest";
import { declareTutorialForTest } from "../../modules/tutorial-test-realm.js";
import { CONNECTIONS_TARGETS } from "../../tutorial/registry/connections-catalog.js";

/** Registers the declare/undeclare pair around every test in the file. */
export function declareConnectionsTutorial(): void {
  let undeclare: (() => void) | null = null;
  beforeEach(async () => {
    undeclare = await declareTutorialForTest("connectors.external", {
      targets: CONNECTIONS_TARGETS,
    });
  });
  afterEach(() => {
    undeclare?.();
    undeclare = null;
  });
}
