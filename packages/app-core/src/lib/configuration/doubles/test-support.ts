/**
 * Shared wiring for the capability suites: the double installed behind the
 * composition seam (`capabilityPorts`).
 */

import { afterEach, beforeEach } from "vitest";
import {
  installCapabilityPorts,
  restoreCapabilityPorts,
} from "../capabilities-ports.js";
import {
  type CompositionDouble,
  type DoubleOptions,
  createCompositionDouble,
} from "./composition-double.js";
import { fakePortsModule } from "./composition-ports-double.js";

export const double: CompositionDouble = createCompositionDouble();

export function resetDouble(options?: DoubleOptions): void {
  double.reset(options);
}

/** The composition seam as the double serves it, over `double`. */
export function doublePorts() {
  return fakePortsModule(double);
}

/**
 * Put the double behind every capability surface for each test in the file
 * that calls this, and the real composition back after each one. Call it
 * once, at the top level of a suite.
 */
export function installDoublePorts(): void {
  beforeEach(() => installCapabilityPorts(doublePorts()));
  afterEach(() => restoreCapabilityPorts());
}
