/**
 * Vitest setup: the same host main.tsx installs, with Vitest's own
 * `import.meta.env` (BASE_URL "/", DEV true), so modules see what they did
 * before the env moved behind the host (ADR 0133).
 */
import { configureHost } from "@opensesame/app-core/host.js";
import { shellBuild } from "./shell-build.js";

configureHost({ env: import.meta.env, ...shellBuild });
