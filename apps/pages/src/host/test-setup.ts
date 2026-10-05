import { browserPorts } from "@opensesame/app-core/browser/host.js";
import { composeHost, configureHost } from "@opensesame/app-core/host.js";
import { installWipeGuard } from "@opensesame/app-core/lib/duress/wipe/test-guard.js";
import { writeSealsWith } from "@opensesame/app-core/lib/vault/generators/opaque-seal.js";
import {
  assertOwnedStorageWrites,
  recordStorageWrite,
} from "@opensesame/app-core/test-host-storage-writes.js";
import {
  repairInertWebStorage,
  testAtRestKeys,
} from "@opensesame/app-core/test-host.js";
/**
 * Vitest setup: the same host main.tsx installs, with Vitest's own
 * `import.meta.env` (BASE_URL "/", DEV true), so modules see what they did
 * before the env moved behind the host (ADR 0133).
 */
import { loadPack, packEntries } from "@opensesame/vault-item-types";
import { afterEach } from "vitest";
import { closeJsdomGaps } from "./jsdom-gaps.js";
import { shellBuild } from "./shell-build.js";

// Pepper seals cost a quarter of a second each at the real Argon2id setting;
// the suites ask for the cheap one (app-core's opaque-seal.test.ts proves the real one).
writeSealsWith("fast");

repairInertWebStorage();
configureHost(
  composeHost(browserPorts(), {
    env: import.meta.env,
    ...shellBuild,
    recordStorageWrite,
    // Values are sealed under a key the host has at hand (ADR 0149), so a
    // test's storage is the page's real Web Storage, sealed.
    atRestKeys: testAtRestKeys,
  }),
);
closeJsdomGaps();

// A test that wrote a Web Storage key the app does not own fails here, even
// when the code under test swallowed the write's outcome.
afterEach(assertOwnedStorageWrites);

// The duress wipe removes every vault in the origin's storage: a test that
// reaches the real runner fails when it ends, unless it opted in by name.
installWipeGuard();

// Built-in packs arrive on demand in the app (ADR 0165); these suites are
// written against the whole corpus, so they switch every pack on first.
await Promise.all(packEntries().map((entry) => loadPack(entry.id)));
