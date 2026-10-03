/**
 * Vitest setup: every suite runs with a development host installed, as the
 * Pages shell's would be (ADR 0133). Suites that test the uninstalled state
 * clear it themselves.
 */
import { afterEach } from "vitest";
import { configureHost } from "./host.js";
import { assertOwnedStorageWrites } from "./test-host-storage-writes.js";
import { createTestHost, repairInertWebStorage } from "./test-host.js";

repairInertWebStorage();
configureHost(createTestHost());

// A test that wrote a Web Storage key the app does not own fails here, even
// when the code under test swallowed the write's outcome.
afterEach(assertOwnedStorageWrites);
