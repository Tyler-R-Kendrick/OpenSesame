/**
 * Shared wiring for the capability suites: the seam mocked whole with the
 * double, and a spy on the module table so CONSENT-01 can assert that
 * drawing every card imported nothing.
 */

import { vi } from "vitest";
import {
  type CompositionDouble,
  type DoubleOptions,
  createCompositionDouble,
} from "./composition-double.js";
import { fakePortsModule } from "./composition-ports-double.js";

export const double: CompositionDouble = createCompositionDouble();

/** Every implementation import goes through here in production; none may fire. */
export const moduleTableSpy = vi.fn();

export function resetDouble(options?: DoubleOptions): void {
  double.reset(options);
  moduleTableSpy.mockClear();
}

/** What `vi.mock` returns for the composition seam: the double over `double`. */
export function mockedPorts() {
  return fakePortsModule(double);
}
