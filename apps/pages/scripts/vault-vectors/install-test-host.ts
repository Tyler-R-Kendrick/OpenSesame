/** The emitter runs the core under Node: install the core's test host first. */
import { configureHost } from "@opensesame/app-core/host.js";
import { createTestHost } from "@opensesame/app-core/test-host.js";

configureHost(createTestHost({ env: { DEV: false } }));
