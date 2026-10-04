/**
 * Vitest setup: the same host main.tsx installs, with Vitest's own
 * `import.meta.env` (BASE_URL "/", DEV true), so modules see what they did
 * before the env moved behind the host (ADR 0133).
 */
import { browserPorts } from "@opensesame/app-core/browser/host.js";
import { composeHost, configureHost } from "@opensesame/app-core/host.js";
import { clearNotices } from "@opensesame/app-core/lib/notices.js";
import {
  assertOwnedStorageWrites,
  recordStorageWrite,
} from "@opensesame/app-core/test-host-storage-writes.js";
import {
  repairInertWebStorage,
  testAtRestKeys,
} from "@opensesame/app-core/test-host.js";
import { afterEach } from "vitest";
import { closeJsdomGaps } from "./jsdom-gaps.js";
import { shellBuild } from "./shell-build.js";

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

// A failure a test raised in the tray never reaches the next test.
afterEach(clearNotices);
