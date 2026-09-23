/**
 * Vitest setup: every suite runs with a development host installed, as the
 * Pages shell's would be (ADR 0133). Suites that test the uninstalled state
 * clear it themselves.
 */
import { configureHost } from "./host.js";
import { createTestHost } from "./test-host.js";

configureHost(createTestHost());
