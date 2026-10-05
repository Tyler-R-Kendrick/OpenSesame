/**
 * Vitest setup: every suite runs with a development host installed, as the
 * Pages shell's would be (ADR 0133). Suites that test the uninstalled state
 * clear it themselves.
 */
import { loadPack, packEntries } from "@opensesame/vault-item-types";
import { afterEach } from "vitest";
import { configureHost } from "./host.js";
import { installWipeGuard } from "./lib/duress/wipe/test-guard.js";
import { writeSealsWith } from "./lib/vault/generators/opaque-seal.js";
import { assertOwnedStorageWrites } from "./test-host-storage-writes.js";
import { createTestHost, repairInertWebStorage } from "./test-host.js";

// Built-in packs arrive on demand in the app (ADR 0165); these suites are
// written against the whole corpus, so they switch every pack on first.
await Promise.all(packEntries().map((entry) => loadPack(entry.id)));

// Pepper seals cost a quarter of a second each at the real Argon2id setting;
// the suites ask for the cheap one, and `opaque-seal.test.ts` proves the real one.
writeSealsWith("fast");

repairInertWebStorage();
configureHost(createTestHost());

// A test that wrote a Web Storage key the app does not own fails here, even
// when the code under test swallowed the write's outcome.
afterEach(assertOwnedStorageWrites);

// The duress wipe removes every vault in the origin's storage: a test that
// reaches the real runner fails when it ends, unless it opted in by name.
installWipeGuard();
